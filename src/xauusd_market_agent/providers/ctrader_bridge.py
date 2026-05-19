from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from ctrader_open_api import Client, EndPoints, Protobuf, TcpProtocol
from ctrader_open_api.auth import Auth
from ctrader_open_api.messages import OpenApiMessages_pb2 as messages
from ctrader_open_api.messages import OpenApiModelMessages_pb2 as model
from twisted.internet import defer, reactor


class BridgeError(RuntimeError):
    pass


class TokenRefreshRequired(BridgeError):
    pass


def _read_request() -> dict[str, Any]:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    payload = json.loads(raw)
    return payload if isinstance(payload, dict) else {}


def _write_response(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()


def _mask_error(exc: Exception) -> str:
    return str(exc)


def _epoch_millis(value: datetime) -> int:
    return int(value.astimezone(timezone.utc).timestamp() * 1000)


def _normalize_symbol(value: str) -> str:
    return "".join(char for char in value.upper() if char.isalnum())


def _iso_from_ms(value: int) -> str:
    return datetime.fromtimestamp(value / 1000, tz=timezone.utc).astimezone().isoformat()


def _iso_from_minutes(value: int) -> str:
    return datetime.fromtimestamp(value * 60, tz=timezone.utc).astimezone().isoformat()


def _save_token_store(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def _health(
    *,
    source: str,
    source_type: str,
    data_mode: str,
    is_available: bool,
    is_stale: bool,
    stale_reason: str = "",
    error: str = "",
    current_value: float | None = None,
    previous_value: float | None = None,
    change_value: float | None = None,
    change_unit: str = "",
    data_timestamp: str = "",
    raw_source_id: str = "",
) -> dict[str, Any]:
    now = datetime.now().astimezone().isoformat()
    return {
        "source": source,
        "source_type": source_type,
        "fetched_at": now,
        "data_timestamp": data_timestamp or now,
        "data_mode": data_mode,
        "is_available": is_available,
        "is_stale": is_stale,
        "stale_reason": stale_reason,
        "error": error,
        "raw_source_id": raw_source_id,
        "current_value": current_value,
        "previous_value": previous_value,
        "change_value": change_value,
        "change_unit": change_unit,
    }


@dataclass
class BridgeRequest:
    client_id: str
    client_secret: str
    access_token: str
    refresh_token: str
    account_id: int
    environment: str
    symbol: str
    symbol_id: int | None
    app_redirect_uri: str
    snapshot_path: Path
    token_store_path: Path
    quote_timeout_seconds: int
    quote_stale_after_seconds: int
    start: datetime | None = None
    end: datetime | None = None

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "BridgeRequest":
        return cls(
            client_id=str(payload.get("clientId", "")),
            client_secret=str(payload.get("clientSecret", "")),
            access_token=str(payload.get("accessToken", "")),
            refresh_token=str(payload.get("refreshToken", "")),
            account_id=int(payload.get("accountId", 0) or 0),
            environment="live" if str(payload.get("environment", "demo")).lower() == "live" else "demo",
            symbol=str(payload.get("symbol", "XAUUSD") or "XAUUSD"),
            symbol_id=int(payload["symbolId"]) if payload.get("symbolId") is not None else None,
            app_redirect_uri=str(payload.get("appRedirectUri", "")),
            snapshot_path=Path(str(payload.get("snapshotPath", "ctrader-last-quote.json"))),
            token_store_path=Path(str(payload.get("tokenStorePath", "ctrader-token.json"))),
            quote_timeout_seconds=int(payload.get("quoteTimeoutSeconds", 8) or 8),
            quote_stale_after_seconds=int(payload.get("quoteStaleAfterSeconds", 15) or 15),
            start=datetime.fromisoformat(str(payload["start"])) if payload.get("start") else None,
            end=datetime.fromisoformat(str(payload["end"])) if payload.get("end") else None,
        )


class CTraderBridge:
    def __init__(self, request: BridgeRequest) -> None:
        self.request = request
        host = EndPoints.PROTOBUF_LIVE_HOST if request.environment == "live" else EndPoints.PROTOBUF_DEMO_HOST
        self.client = Client(host, EndPoints.PROTOBUF_PORT, TcpProtocol)
        self.client.setMessageReceivedCallback(self._on_message)
        self._spot_waiter: defer.Deferred | None = None
        self._resolved_symbol: dict[str, Any] | None = None

    def _on_message(self, _client: Client, message: Any) -> None:
        payload = Protobuf.extract(message)
        if (
            isinstance(payload, messages.ProtoOASpotEvent)
            and self._spot_waiter is not None
            and self._resolved_symbol is not None
            and int(payload.symbolId) == int(self._resolved_symbol["symbolId"])
            and not self._spot_waiter.called
        ):
            self._spot_waiter.callback(payload)

    def _start(self) -> defer.Deferred:
        self.client.startService()
        return self.client.whenConnected(failAfterFailures=1)

    def _stop(self) -> None:
        try:
            self.client.stopService()
        except Exception:
            pass

    def _send(self, name: str, **params: Any) -> defer.Deferred:
        d = self.client.send(
            name,
            responseTimeoutInSeconds=max(5, self.request.quote_timeout_seconds),
            **params,
        )

        def extract(message: Any) -> Any:
            payload = Protobuf.extract(message)
            if isinstance(payload, messages.ProtoOAErrorRes):
                error = f"{payload.errorCode}: {payload.description}"
                if "token" in error.lower():
                    raise TokenRefreshRequired(error)
                raise BridgeError(error)
            return payload

        d.addCallback(extract)
        return d

    @defer.inlineCallbacks
    def _refresh_tokens(self) -> Any:
        if not self.request.refresh_token:
            raise BridgeError("cTrader refresh token is missing.")
        redirect = self.request.app_redirect_uri or "http://localhost"
        response = Auth(
            self.request.client_id,
            self.request.client_secret,
            redirect,
        ).refreshToken(self.request.refresh_token)
        if not isinstance(response, dict) or not response.get("accessToken"):
            raise BridgeError(str(response))
        self.request.access_token = str(response["accessToken"])
        self.request.refresh_token = str(response.get("refreshToken", self.request.refresh_token))
        _save_token_store(
            self.request.token_store_path,
            {
                "clientSecret": self.request.client_secret,
                "accessToken": self.request.access_token,
                "refreshToken": self.request.refresh_token,
            },
        )
        return {
            "ok": True,
            "accessToken": self.request.access_token,
            "refreshToken": self.request.refresh_token,
            "provider_health": _health(
                source="cTrader",
                source_type="spot",
                data_mode="live_seen",
                is_available=True,
                is_stale=False,
            ),
        }

    @defer.inlineCallbacks
    def _application_and_account_auth(self) -> Any:
        yield self._send(
            "ApplicationAuthReq",
            clientId=self.request.client_id,
            clientSecret=self.request.client_secret,
        )
        accounts = yield self._send(
            "GetAccountListByAccessTokenReq",
            accessToken=self.request.access_token,
        )
        matched_account = None
        for account in accounts.ctidTraderAccount:
            if int(account.ctidTraderAccountId) == int(self.request.account_id):
                matched_account = account
                break
        if matched_account is None:
            raise BridgeError(f"cTrader account {self.request.account_id} is not accessible for this token.")
        yield self._send(
            "AccountAuthReq",
            ctidTraderAccountId=self.request.account_id,
            accessToken=self.request.access_token,
        )
        return matched_account

    @defer.inlineCallbacks
    def _run_with_refresh(self, operation):
        try:
            result = yield self._application_and_account_auth()
            output = yield operation(result)
            return output
        except TokenRefreshRequired:
            if not self.request.refresh_token:
                raise
            yield self._refresh_tokens()
            result = yield self._application_and_account_auth()
            output = yield operation(result)
            return output

    @defer.inlineCallbacks
    def _resolve_symbol(self, _account: Any) -> Any:
        if self.request.symbol_id is not None:
            symbol_id = int(self.request.symbol_id)
            symbol_by_id = yield self._send(
                "SymbolByIdReq",
                ctidTraderAccountId=self.request.account_id,
                symbolId=[symbol_id],
            )
            if not symbol_by_id.symbol:
                raise BridgeError(f"Configured symbolId {symbol_id} was not found.")
            full = symbol_by_id.symbol[0]
            return {
                "symbolId": symbol_id,
                "symbolName": self.request.symbol,
                "digits": int(full.digits),
                "pipPosition": int(full.pipPosition),
            }
        symbol_list = yield self._send(
            "SymbolsListReq",
            ctidTraderAccountId=self.request.account_id,
            includeArchivedSymbols=False,
        )
        normalized_target = _normalize_symbol(self.request.symbol)
        aliases = {normalized_target, "XAUUSD", "XAUUSD", "GOLD"}
        match = None
        for symbol in symbol_list.symbol:
            name = str(symbol.symbolName or "")
            description = str(symbol.description or "")
            normalized_name = _normalize_symbol(name)
            normalized_description = _normalize_symbol(description)
            if normalized_name in aliases or normalized_description in aliases:
                match = symbol
                break
        if match is None:
            raise BridgeError(f"Unable to resolve cTrader symbol for {self.request.symbol}.")
        symbol_by_id = yield self._send(
            "SymbolByIdReq",
            ctidTraderAccountId=self.request.account_id,
            symbolId=[int(match.symbolId)],
        )
        if not symbol_by_id.symbol:
            raise BridgeError(f"Unable to fetch full cTrader symbol details for {match.symbolName}.")
        full = symbol_by_id.symbol[0]
        return {
            "symbolId": int(match.symbolId),
            "symbolName": str(match.symbolName or self.request.symbol),
            "digits": int(full.digits),
            "pipPosition": int(full.pipPosition),
        }

    def _scale_price(self, raw: int, digits: int) -> float:
        return float(raw) / (10 ** digits)

    @defer.inlineCallbacks
    def resolve_symbol(self):
        yield self._start()

        def operation(account):
            return self._resolve_symbol(account)

        try:
            symbol = yield self._run_with_refresh(operation)
            self._resolved_symbol = symbol
            defer.returnValue({"ok": True, "symbol": symbol})
        finally:
            self._stop()

    @defer.inlineCallbacks
    def test_connection(self):
        yield self._start()

        @defer.inlineCallbacks
        def operation(account):
            symbol = yield self._resolve_symbol(account)
            defer.returnValue(
                {
                    "ok": True,
                    "account": {
                        "ctidTraderAccountId": int(account.ctidTraderAccountId),
                        "isLive": bool(getattr(account, "isLive", False)),
                    },
                    "symbol": symbol,
                    "provider_health": _health(
                        source="cTrader",
                        source_type="spot",
                        data_mode="live_seen",
                        is_available=True,
                        is_stale=False,
                        raw_source_id=str(symbol["symbolId"]),
                    ),
                }
            )

        try:
            payload = yield self._run_with_refresh(operation)
            self._resolved_symbol = payload.get("symbol")
            defer.returnValue(payload)
        finally:
            self._stop()

    @defer.inlineCallbacks
    def fetch_quote(self):
        yield self._start()

        @defer.inlineCallbacks
        def operation(account):
            symbol = yield self._resolve_symbol(account)
            self._resolved_symbol = symbol
            yield self._send(
                "SubscribeSpotsReq",
                ctidTraderAccountId=self.request.account_id,
                symbolId=[int(symbol["symbolId"])],
                subscribeToSpotTimestamp=True,
            )
            waiter: defer.Deferred = defer.Deferred()
            self._spot_waiter = waiter
            timeout_call = reactor.callLater(
                max(5, self.request.quote_timeout_seconds),
                lambda: (not waiter.called) and waiter.errback(BridgeError("Timed out waiting for cTrader spot quote.")),
            )
            try:
                spot = yield waiter
            finally:
                if timeout_call.active():
                    timeout_call.cancel()
                self._spot_waiter = None
            bid = self._scale_price(int(spot.bid), int(symbol["digits"])) if spot.bid else None
            ask = self._scale_price(int(spot.ask), int(symbol["digits"])) if spot.ask else None
            mid = round(((bid or 0.0) + (ask or 0.0)) / 2, int(symbol["digits"])) if bid is not None and ask is not None else (bid or ask or 0.0)
            timestamp_ms = int(spot.timestamp or 0)
            quote = {
                "symbol": str(symbol["symbolName"]),
                "symbol_id": int(symbol["symbolId"]),
                "bid": bid,
                "ask": ask,
                "mid": mid,
                "timestamp": _iso_from_ms(timestamp_ms) if timestamp_ms else datetime.now().astimezone().isoformat(),
                "source": "cTrader OpenAPI",
                "source_type": "spot",
                "environment": self.request.environment,
                "account_id": str(self.request.account_id),
            }
            provider_health = _health(
                source="cTrader",
                source_type="spot",
                data_mode="live_seen",
                is_available=True,
                is_stale=False,
                current_value=mid,
                data_timestamp=quote["timestamp"],
                raw_source_id=str(symbol["symbolId"]),
            )
            self.request.snapshot_path.parent.mkdir(parents=True, exist_ok=True)
            self.request.snapshot_path.write_text(json.dumps(quote, ensure_ascii=False), encoding="utf-8")
            defer.returnValue({"ok": True, "quote": quote, "provider_health": provider_health})

        try:
            payload = yield self._run_with_refresh(operation)
            defer.returnValue(payload)
        finally:
            self._stop()

    @defer.inlineCallbacks
    def backfill(self):
        if self.request.start is None or self.request.end is None:
            raise BridgeError("Backfill start/end timestamps are required.")
        yield self._start()

        @defer.inlineCallbacks
        def operation(account):
            symbol = yield self._resolve_symbol(account)
            self._resolved_symbol = symbol
            bars: list[dict[str, Any]] = []
            chunk_start = self.request.start
            chunk_size = timedelta(minutes=500)
            while chunk_start < self.request.end:
                chunk_end = min(chunk_start + chunk_size, self.request.end)
                response = yield self._send(
                    "GetTrendbarsReq",
                    ctidTraderAccountId=self.request.account_id,
                    fromTimestamp=_epoch_millis(chunk_start),
                    toTimestamp=_epoch_millis(chunk_end),
                    period=model.ProtoOATrendbarPeriod.M1,
                    symbolId=int(symbol["symbolId"]),
                    count=500,
                )
                for trendbar in response.trendbar:
                    low = self._scale_price(int(trendbar.low), int(symbol["digits"]))
                    open_price = self._scale_price(int(trendbar.low + trendbar.deltaOpen), int(symbol["digits"]))
                    close_price = self._scale_price(int(trendbar.low + trendbar.deltaClose), int(symbol["digits"]))
                    high_price = self._scale_price(int(trendbar.low + trendbar.deltaHigh), int(symbol["digits"]))
                    bars.append(
                        {
                            "symbol": str(symbol["symbolName"]),
                            "data_timestamp": _iso_from_minutes(int(trendbar.utcTimestampInMinutes)),
                            "open": open_price,
                            "high": high_price,
                            "low": low,
                            "close": close_price,
                            "bid": None,
                            "ask": None,
                            "source": "cTrader OpenAPI",
                            "source_type": "spot",
                            "data_mode": "backfilled",
                            "is_stale": False,
                            "stale_reason": "",
                        }
                    )
                chunk_start = chunk_end
            deduped = {item["data_timestamp"]: item for item in bars}
            ordered = [deduped[key] for key in sorted(deduped)]
            previous_value = ordered[0]["open"] if ordered else None
            current_value = ordered[-1]["close"] if ordered else None
            change_value = (
                0.0
                if not ordered or not previous_value
                else ((float(current_value) - float(previous_value)) / float(previous_value)) * 100.0
            )
            provider_health = _health(
                source="cTrader",
                source_type="spot",
                data_mode="backfilled",
                is_available=bool(ordered),
                is_stale=False,
                current_value=float(current_value) if current_value is not None else None,
                previous_value=float(previous_value) if previous_value is not None else None,
                change_value=float(change_value) if ordered else None,
                change_unit="percent",
                data_timestamp=ordered[-1]["data_timestamp"] if ordered else self.request.end.isoformat(),
                raw_source_id=str(symbol["symbolId"]),
            )
            defer.returnValue({"ok": True, "bars": ordered, "provider_health": provider_health})

        try:
            payload = yield self._run_with_refresh(operation)
            defer.returnValue(payload)
        finally:
            self._stop()


def _complete_and_stop(d: defer.Deferred) -> dict[str, Any]:
    state: dict[str, Any] = {}

    def finish(payload: dict[str, Any]) -> None:
        state["payload"] = payload
        if reactor.running:
            reactor.stop()

    d.addCallbacks(finish, lambda failure: finish({"ok": False, "error": _mask_error(failure.value)}))
    reactor.run(installSignalHandlers=False)
    return state["payload"]


def _dispatch(command: str, request_payload: dict[str, Any]) -> dict[str, Any]:
    request = BridgeRequest.from_payload(request_payload)
    bridge = CTraderBridge(request)
    if command == "resolve-symbol":
        return _complete_and_stop(bridge.resolve_symbol())
    if command == "test-connection":
        return _complete_and_stop(bridge.test_connection())
    if command == "quote":
        return _complete_and_stop(bridge.fetch_quote())
    if command == "backfill":
        return _complete_and_stop(bridge.backfill())
    if command == "refresh-token":
        return _complete_and_stop(bridge._refresh_tokens())
    return {"ok": False, "error": f"Unsupported cTrader bridge command: {command}"}


def main(argv: list[str] | None = None) -> int:
    args = argv or sys.argv[1:]
    if not args:
        _write_response({"ok": False, "error": "Missing cTrader bridge command."})
        return 1
    payload = _dispatch(args[0], _read_request())
    _write_response(payload)
    return 0 if payload.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
