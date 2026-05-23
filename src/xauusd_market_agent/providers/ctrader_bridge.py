from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


class BridgeError(RuntimeError):
    pass


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat()


def _parse_timestamp(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.astimezone() if parsed.tzinfo else parsed.replace(tzinfo=datetime.now().astimezone().tzinfo)


def _as_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _read_stdin() -> dict[str, Any]:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    payload = json.loads(raw)
    return payload if isinstance(payload, dict) else {}


def _without_secrets(payload: dict[str, Any]) -> dict[str, Any]:
    clean = dict(payload)
    if clean.get("password"):
        clean["password"] = "***"
    return clean


def _redact_text(value: str, secrets: list[str]) -> str:
    redacted = value
    for secret in secrets:
        if secret:
            redacted = redacted.replace(secret, "***")
    return redacted


@dataclass
class BridgeRequest:
    account_id: str
    ctid: str
    password: str
    environment: str
    symbol: str
    symbol_id: int | None
    snapshot_path: Path
    quote_timeout_seconds: int
    quote_stale_after_seconds: int
    cli_executable: str

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "BridgeRequest":
        return cls(
            account_id=str(payload.get("accountId", "")).strip(),
            ctid=str(payload.get("ctid", "")).strip(),
            password=str(payload.get("password", "")).strip(),
            environment="live" if str(payload.get("environment", "")).lower() == "live" else "demo",
            symbol=str(payload.get("symbol", "XAUUSD") or "XAUUSD").strip() or "XAUUSD",
            symbol_id=_as_int(payload.get("symbolId")),
            snapshot_path=Path(str(payload.get("snapshotPath", "ctrader-last-quote.json"))),
            quote_timeout_seconds=int(payload.get("quoteTimeoutSeconds", 8) or 8),
            quote_stale_after_seconds=int(payload.get("quoteStaleAfterSeconds", 15) or 15),
            cli_executable=str(payload.get("cliExecutable", "ctrader-cli") or "ctrader-cli").strip()
            or "ctrader-cli",
        )

    def require_credentials(self) -> None:
        if not self.account_id or not self.ctid or not self.password:
            raise BridgeError("cTrader CLI credentials are incomplete.")

    def cli_payload(self, extra: dict[str, Any] | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "accountId": self.account_id,
            "ctid": self.ctid,
            "password": self.password,
            "environment": self.environment,
            "symbol": self.symbol,
            "symbolId": self.symbol_id,
        }
        if extra:
            payload.update(extra)
        return payload


class CTraderCliBridge:
    def __init__(self, request: BridgeRequest) -> None:
        self.request = request

    def _run_cli(self, command: str, extra: dict[str, Any] | None = None) -> dict[str, Any]:
        self.request.require_credentials()
        payload = self.request.cli_payload(extra)
        try:
            process = subprocess.run(
                [self.request.cli_executable, command],
                input=json.dumps(payload),
                text=True,
                capture_output=True,
                check=False,
                timeout=max(5, self.request.quote_timeout_seconds + 2),
            )
        except FileNotFoundError as exc:
            raise BridgeError(
                "The local cTrader connector is not available. Install or repair the cTrader connector and try again."
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise BridgeError("cTrader CLI command timed out.") from exc

        stdout = process.stdout.strip()
        stderr = process.stderr.strip()
        if process.returncode != 0:
            safe_error = _redact_text(stderr or stdout, [self.request.password, self.request.ctid])
            raise BridgeError(safe_error or f"cTrader CLI exited with code {process.returncode}.")
        if not stdout:
            raise BridgeError("cTrader CLI returned no JSON payload.")
        try:
            parsed = json.loads(stdout)
        except json.JSONDecodeError as exc:
            raise BridgeError("cTrader CLI returned invalid JSON.") from exc
        if not isinstance(parsed, dict):
            raise BridgeError("cTrader CLI JSON payload must be an object.")
        return parsed

    def test_connection(self) -> dict[str, Any]:
        response = self._run_cli("test-connection")
        if response.get("ok") is False:
            return response
        return {
            "ok": True,
            "message": str(response.get("message", "cTrader CLI credentials accepted.")),
            "account": response.get("account")
            or {
                "ctidTraderAccountId": self.request.account_id,
                "environment": self.request.environment,
            },
            "symbol": response.get("symbol"),
            "provider_health": response.get("provider_health"),
        }

    def resolve_symbol(self) -> dict[str, Any]:
        if self.request.symbol_id is not None:
            return {
                "ok": True,
                "symbol": {"symbolId": self.request.symbol_id, "symbolName": self.request.symbol},
            }
        response = self._run_cli("resolve-symbol")
        symbol = response.get("symbol")
        if isinstance(symbol, dict):
            return {"ok": True, "symbol": symbol}
        symbol_id = response.get("symbolId") or response.get("symbol_id")
        symbol_name = response.get("symbolName") or response.get("symbol") or self.request.symbol
        if symbol_id is None:
            raise BridgeError("cTrader CLI did not return a symbol id.")
        return {
            "ok": True,
            "symbol": {
                "symbolId": symbol_id,
                "symbolName": symbol_name,
                "digits": response.get("digits"),
                "pipPosition": response.get("pipPosition") or response.get("pip_position"),
            },
        }

    def quote(self) -> dict[str, Any]:
        response = self._run_cli("quote")
        if response.get("ok") is False:
            return response
        quote = response.get("quote") if isinstance(response.get("quote"), dict) else response
        timestamp = str(quote.get("timestamp") or quote.get("data_timestamp") or _now_iso())
        bid = quote.get("bid")
        ask = quote.get("ask")
        mid = quote.get("mid")
        if mid is None and bid is not None and ask is not None:
            mid = (float(bid) + float(ask)) / 2
        if mid is None:
            mid = quote.get("close") or quote.get("price")
        quote_time = _parse_timestamp(timestamp)
        now = datetime.now().astimezone()
        age_seconds = (now - quote_time).total_seconds() if quote_time is not None else None
        stale_after = max(1, self.request.quote_stale_after_seconds)
        is_stale = age_seconds is None or age_seconds > stale_after
        stale_reason = (
            "cTrader quote timestamp could not be parsed."
            if age_seconds is None
            else f"cTrader quote is {int(age_seconds)}s old; market may be closed or feed is paused."
        ) if is_stale else ""
        normalized_quote = {
            "symbol": str(quote.get("symbol", self.request.symbol)),
            "symbol_id": quote.get("symbol_id", quote.get("symbolId", self.request.symbol_id)),
            "bid": bid,
            "ask": ask,
            "mid": mid,
            "timestamp": timestamp,
            "source": "cTrader CLI",
            "source_type": "spot",
            "environment": self.request.environment,
            "account_id": self.request.account_id,
        }
        health = response.get("provider_health") if isinstance(response.get("provider_health"), dict) else {}
        provider_health = {
            "source": "cTrader",
            "source_type": "spot",
            "data_mode": "stale" if is_stale else "live_seen",
            "is_available": True,
            "is_stale": is_stale,
            "stale_reason": stale_reason,
            "error": "",
            "current_value": mid,
            "data_timestamp": timestamp,
            "fetched_at": _now_iso(),
            "raw_source_id": str(normalized_quote.get("symbol_id") or self.request.symbol),
            **health,
        }
        return {"ok": True, "quote": normalized_quote, "provider_health": provider_health}

    def backfill(self, start: str, end: str) -> dict[str, Any]:
        response = self._run_cli("backfill", {"start": start, "end": end})
        if response.get("ok") is False:
            return response
        bars = response.get("bars")
        if not isinstance(bars, list):
            raise BridgeError("cTrader CLI backfill did not return bars.")
        health = response.get("provider_health") if isinstance(response.get("provider_health"), dict) else {}
        provider_health = {
            "source": "cTrader",
            "source_type": "spot",
            "data_mode": "backfilled",
            "is_available": bool(bars),
            "is_stale": False,
            "stale_reason": "",
            "error": "",
            "data_timestamp": str(bars[-1].get("data_timestamp", end)) if bars else end,
            "fetched_at": _now_iso(),
            "raw_source_id": str(self.request.symbol_id or self.request.symbol),
            **health,
        }
        return {"ok": True, "bars": bars, "provider_health": provider_health}


def handle(command: str, payload: dict[str, Any]) -> dict[str, Any]:
    request = BridgeRequest.from_payload(payload)
    bridge = CTraderCliBridge(request)
    if command == "test-connection":
        return bridge.test_connection()
    if command == "resolve-symbol":
        return bridge.resolve_symbol()
    if command == "quote":
        return bridge.quote()
    if command == "backfill":
        return bridge.backfill(str(payload.get("start", "")), str(payload.get("end", "")))
    raise BridgeError(f"Unsupported cTrader CLI bridge command: {command}")


def main() -> int:
    command = sys.argv[1] if len(sys.argv) > 1 else "quote"
    try:
        payload = _read_stdin()
        response = handle(command, payload)
        print(json.dumps(response, ensure_ascii=False))
        return 0 if response.get("ok", True) is not False else 1
    except Exception as exc:
        safe_payload = _without_secrets(_read_stdin()) if False else {}
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": str(exc),
                    "payload": safe_payload,
                },
                ensure_ascii=False,
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
