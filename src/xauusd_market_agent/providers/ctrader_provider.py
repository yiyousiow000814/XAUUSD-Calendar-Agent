from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable

from ..config import CTraderCliConfig
from ..models import ProviderHealth
from .ctrader_bridge import handle as run_ctrader_cli_command

BridgeRunner = Callable[[str, dict[str, object]], dict[str, object]]


def _mask_secret(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 4:
        return "*" * len(value)
    return f"{value[:2]}{'*' * max(4, len(value) - 4)}{value[-2:]}"


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat()


def _provider_health_from_payload(payload: dict[str, Any], fallback_symbol: str) -> ProviderHealth:
    return ProviderHealth(
        source=str(payload.get("source", "cTrader")),
        source_type=str(payload.get("source_type", "spot")),
        fetched_at=str(payload.get("fetched_at", _now_iso())),
        data_timestamp=str(payload.get("data_timestamp", payload.get("timestamp", _now_iso()))),
        data_mode=str(payload.get("data_mode", "unavailable")),
        is_available=bool(payload.get("is_available", False)),
        is_stale=bool(payload.get("is_stale", False)),
        stale_reason=str(payload.get("stale_reason", "")),
        error=str(payload.get("error", "")),
        raw_source_id=str(payload.get("raw_source_id", fallback_symbol)),
        latency_ms=payload.get("latency_ms"),
        current_value=float(payload["current_value"]) if payload.get("current_value") is not None else None,
        previous_value=float(payload["previous_value"]) if payload.get("previous_value") is not None else None,
        change_value=float(payload["change_value"]) if payload.get("change_value") is not None else None,
        change_unit=str(payload.get("change_unit", "")),
    )


def _default_bridge_runner(config: CTraderCliConfig) -> BridgeRunner:
    def run(command: str, payload: dict[str, object]) -> dict[str, object]:
        return run_ctrader_cli_command(command, payload)

    return run


class CTraderProvider:
    def __init__(
        self,
        *,
        cli_config: CTraderCliConfig,
        bridge_runner: BridgeRunner | None = None,
        saved_snapshot_path: Path | None = None,
    ) -> None:
        self.cli_config = cli_config
        self.saved_snapshot_path = (
            Path(saved_snapshot_path)
            if saved_snapshot_path is not None
            else Path(cli_config.snapshot_path)
        )
        self.bridge_runner = bridge_runner or _default_bridge_runner(cli_config)

    @classmethod
    def from_market_agent_config(cls, market_config) -> "CTraderProvider":
        return cls(
            cli_config=CTraderCliConfig.from_sources(market_config),
            saved_snapshot_path=market_config.ctrader_saved_snapshot_path,
        )

    def is_configured(self) -> bool:
        return self.cli_config.is_ready()

    def masked_config_payload(self) -> dict[str, object]:
        cfg = self.cli_config
        return {
            "enabled": cfg.enabled,
            "environment": cfg.environment,
            "symbol": cfg.symbol,
            "symbolId": cfg.symbol_id,
            "accountId": cfg.account_id,
            "ctidMasked": _mask_secret(cfg.ctid),
            "passwordMasked": _mask_secret(cfg.password),
            "hasPassword": bool(cfg.password),
            "configPath": str(cfg.config_path),
            "snapshotPath": str(self.saved_snapshot_path),
            "quoteTimeoutSeconds": cfg.quote_timeout_seconds,
            "quoteStaleAfterSeconds": cfg.quote_stale_after_seconds,
            "allowSavedSnapshotFallback": cfg.allow_saved_snapshot_fallback,
        }

    def _bridge_payload(self) -> dict[str, object]:
        cfg = self.cli_config
        return {
            "accountId": cfg.account_id,
            "ctid": cfg.ctid,
            "password": cfg.password,
            "environment": cfg.environment,
            "symbol": cfg.symbol,
            "symbolId": cfg.symbol_id,
            "snapshotPath": str(self.saved_snapshot_path),
            "quoteTimeoutSeconds": cfg.quote_timeout_seconds,
            "quoteStaleAfterSeconds": cfg.quote_stale_after_seconds,
            "cliExecutable": cfg.cli_executable,
        }

    def _unavailable_health(self, reason: str) -> ProviderHealth:
        return ProviderHealth(
            source="cTrader",
            source_type="spot",
            fetched_at=_now_iso(),
            data_timestamp=_now_iso(),
            data_mode="unavailable",
            is_available=False,
            is_stale=False,
            stale_reason=reason,
            error=reason,
            raw_source_id=self.cli_config.symbol,
        )

    def _write_snapshot(self, payload: dict[str, Any]) -> None:
        self.saved_snapshot_path.parent.mkdir(parents=True, exist_ok=True)
        self.saved_snapshot_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    def _load_saved_snapshot(self, anchor_time: datetime, *, fallback_error: str = "") -> tuple[list[dict[str, Any]], ProviderHealth]:
        if not self.saved_snapshot_path.exists():
            return [], self._unavailable_health(fallback_error or "cTrader quote snapshot is unavailable.")
        payload = json.loads(self.saved_snapshot_path.read_text(encoding="utf-8"))
        timestamp = str(payload.get("timestamp", anchor_time.isoformat()))
        row = {
            "timestamp": timestamp,
            "data_timestamp": timestamp,
            "symbol": payload.get("symbol", self.cli_config.symbol),
            "open": float(payload.get("mid", payload.get("bid", 0.0))),
            "high": float(payload.get("mid", payload.get("ask", 0.0))),
            "low": float(payload.get("mid", payload.get("bid", 0.0))),
            "close": float(payload.get("mid", payload.get("ask", 0.0))),
            "bid": float(payload.get("bid", payload.get("mid", 0.0))),
            "ask": float(payload.get("ask", payload.get("mid", 0.0))),
            "source": "cTrader saved snapshot",
            "source_type": "spot_snapshot",
            "data_mode": "stale",
            "is_stale": True,
            "stale_reason": fallback_error or "Loaded saved cTrader quote snapshot fallback.",
        }
        health = ProviderHealth(
            source="cTrader",
            source_type="spot_snapshot",
            fetched_at=anchor_time.isoformat(),
            data_timestamp=timestamp,
            data_mode="stale",
            is_available=True,
            is_stale=True,
            stale_reason=fallback_error or "Loaded saved cTrader quote snapshot fallback.",
            error=fallback_error,
            raw_source_id=str(payload.get("symbol_id", self.cli_config.symbol)),
            current_value=float(payload.get("mid", payload.get("bid", 0.0))),
        )
        return [row], health

    def _latest_history_snapshot(
        self,
        anchor_time: datetime,
        *,
        fallback_error: str = "",
    ) -> tuple[list[dict[str, Any]], ProviderHealth | None]:
        try:
            response = self.bridge_runner(
                "backfill",
                {
                    **self._bridge_payload(),
                    "start": (anchor_time - timedelta(days=7)).isoformat(),
                    "end": anchor_time.isoformat(),
                },
            )
            bars = response.get("bars")
            if not isinstance(bars, list) or not bars:
                return [], None
            ordered = sorted(bars, key=lambda item: str(item.get("data_timestamp", item.get("timestamp", ""))))
            last = ordered[-1]
            previous = ordered[-2] if len(ordered) > 1 else None
            close = float(last.get("close", last.get("close_price", last.get("mid", 0.0))))
            previous_close = (
                float(previous.get("close", previous.get("close_price", previous.get("mid", close))))
                if isinstance(previous, dict)
                else close
            )
            timestamp = str(last.get("data_timestamp", last.get("timestamp", anchor_time.isoformat())))
            reason = fallback_error or "Market may be closed or live quotes are paused; showing last cTrader history price."
            snapshot = {
                "timestamp": timestamp,
                "symbol": str(last.get("symbol", self.cli_config.symbol)),
                "symbol_id": self.cli_config.symbol_id,
                "mid": close,
                "source": "cTrader history",
                "source_type": "spot",
                "environment": self.cli_config.environment,
                "account_id": self.cli_config.account_id,
            }
            self._write_snapshot(snapshot)
            row = {
                "timestamp": timestamp,
                "data_timestamp": timestamp,
                "symbol": str(last.get("symbol", self.cli_config.symbol)),
                "open": float(last.get("open", last.get("open_price", close))),
                "high": float(last.get("high", last.get("high_price", close))),
                "low": float(last.get("low", last.get("low_price", close))),
                "close": close,
                "bid": last.get("bid"),
                "ask": last.get("ask"),
                "source": "cTrader history",
                "source_type": "spot",
                "data_mode": "stale",
                "is_stale": True,
                "stale_reason": reason,
            }
            return [row], ProviderHealth(
                source="cTrader",
                source_type="spot",
                fetched_at=anchor_time.isoformat(),
                data_timestamp=timestamp,
                data_mode="stale",
                is_available=True,
                is_stale=True,
                stale_reason=reason,
                error="",
                raw_source_id=str(last.get("symbol_id", self.cli_config.symbol_id or self.cli_config.symbol)),
                current_value=close,
                previous_value=previous_close,
                change_value=close - previous_close,
                change_unit="price",
            )
        except Exception:
            return [], None

    def resolve_symbol(self) -> dict[str, Any]:
        if self.cli_config.symbol_id is not None:
            return {
                "symbolId": self.cli_config.symbol_id,
                "symbolName": self.cli_config.symbol,
            }
        response = self.bridge_runner("resolve-symbol", self._bridge_payload())
        symbol = response.get("symbol")
        if not isinstance(symbol, dict):
            raise RuntimeError(response.get("error") or "cTrader symbol resolution failed.")
        return symbol

    def fetch_latest(self, anchor_time: datetime) -> tuple[list[dict[str, object]], ProviderHealth]:
        if not self.is_configured():
            return [], self._unavailable_health("cTrader CLI credentials are not configured.")
        try:
            response = self.bridge_runner("quote", self._bridge_payload())
            quote = response.get("quote")
            bars = response.get("bars")
            health_payload = response.get("provider_health")
            if not isinstance(quote, dict) or not isinstance(health_payload, dict):
                raise RuntimeError(response.get("error") or "cTrader quote bridge returned an invalid payload.")
            self._write_snapshot(quote)
            row = self._quote_row(quote, health_payload)
            live_rows = self._bar_rows(bars, fallback_quote=quote, health_payload=health_payload) or [row]
            health = _provider_health_from_payload(health_payload, str(quote.get("symbol_id", self.cli_config.symbol)))
            if health.is_stale:
                history_rows, history_health = self._latest_history_snapshot(
                    anchor_time,
                    fallback_error=health.stale_reason,
                )
                if history_rows and history_health is not None:
                    return history_rows, history_health
            return live_rows, health
        except Exception as exc:
            history_rows, history_health = self._latest_history_snapshot(anchor_time, fallback_error=str(exc))
            if history_rows and history_health is not None:
                return history_rows, history_health
            if self.cli_config.allow_saved_snapshot_fallback:
                rows, health = self._load_saved_snapshot(anchor_time, fallback_error=str(exc))
                if rows:
                    return rows, health
            return [], self._unavailable_health(str(exc))

    def _quote_row(self, quote: dict[str, Any], health_payload: dict[str, Any]) -> dict[str, object]:
        mid = float(quote.get("mid", quote.get("bid", 0.0)))
        bid = float(quote.get("bid", mid))
        ask = float(quote.get("ask", mid))
        return {
            "timestamp": str(quote["timestamp"]),
            "data_timestamp": str(quote["timestamp"]),
            "symbol": str(quote.get("symbol", self.cli_config.symbol)),
            "open": mid,
            "high": ask,
            "low": bid,
            "close": mid,
            "bid": bid,
            "ask": ask,
            "source": str(quote.get("source", "cTrader CLI")),
            "source_type": str(quote.get("source_type", "spot")),
            "data_mode": str(health_payload.get("data_mode", "live_seen")),
            "is_stale": bool(health_payload.get("is_stale", False)),
            "stale_reason": str(health_payload.get("stale_reason", "")),
        }

    def _bar_rows(
        self,
        bars: Any,
        *,
        fallback_quote: dict[str, Any],
        health_payload: dict[str, Any],
    ) -> list[dict[str, object]]:
        if not isinstance(bars, list):
            return []
        rows: list[dict[str, object]] = []
        for bar in bars:
            if not isinstance(bar, dict):
                continue
            close = bar.get("close", fallback_quote.get("mid", fallback_quote.get("bid", 0.0)))
            rows.append(
                {
                    "timestamp": str(bar.get("data_timestamp", bar.get("timestamp", fallback_quote["timestamp"]))),
                    "data_timestamp": str(bar.get("data_timestamp", bar.get("timestamp", fallback_quote["timestamp"]))),
                    "symbol": str(bar.get("symbol", fallback_quote.get("symbol", self.cli_config.symbol))),
                    "open": float(bar.get("open", close)),
                    "high": float(bar.get("high", close)),
                    "low": float(bar.get("low", close)),
                    "close": float(close),
                    "bid": float(bar.get("bid", fallback_quote.get("bid", close))),
                    "ask": float(bar.get("ask", fallback_quote.get("ask", close))),
                    "source": str(bar.get("source", "cTrader CLI")),
                    "source_type": str(bar.get("source_type", "spot_m1")),
                    "data_mode": str(bar.get("data_mode", health_payload.get("data_mode", "live_seen"))),
                    "is_stale": bool(bar.get("is_stale", health_payload.get("is_stale", False))),
                    "stale_reason": str(bar.get("stale_reason", health_payload.get("stale_reason", ""))),
                }
            )
        return rows

    def backfill(self, start: datetime, end: datetime) -> tuple[list[dict[str, object]], ProviderHealth]:
        if not self.is_configured():
            return [], self._unavailable_health("cTrader CLI credentials are not configured.")
        response = self.bridge_runner(
            "backfill",
            {
                **self._bridge_payload(),
                "start": start.isoformat(),
                "end": end.isoformat(),
            },
        )
        bars = response.get("bars")
        health_payload = response.get("provider_health")
        if not isinstance(bars, list) or not isinstance(health_payload, dict):
            raise RuntimeError(response.get("error") or "cTrader backfill bridge returned an invalid payload.")
        rows = [
            {
                "timestamp": str(bar["data_timestamp"]),
                "data_timestamp": str(bar["data_timestamp"]),
                "symbol": str(bar.get("symbol", self.cli_config.symbol)),
                "open": float(bar["open"]),
                "high": float(bar["high"]),
                "low": float(bar["low"]),
                "close": float(bar["close"]),
                "bid": bar.get("bid"),
                "ask": bar.get("ask"),
                "source": str(bar.get("source", "cTrader CLI")),
                "source_type": str(bar.get("source_type", "spot")),
                "data_mode": str(bar.get("data_mode", "backfilled")),
                "is_stale": bool(bar.get("is_stale", False)),
                "stale_reason": str(bar.get("stale_reason", "")),
            }
            for bar in bars
        ]
        return rows, _provider_health_from_payload(health_payload, self.cli_config.symbol)
