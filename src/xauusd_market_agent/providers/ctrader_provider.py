from __future__ import annotations

import json
from datetime import datetime
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
            health_payload = response.get("provider_health")
            if not isinstance(quote, dict) or not isinstance(health_payload, dict):
                raise RuntimeError(response.get("error") or "cTrader quote bridge returned an invalid payload.")
            self._write_snapshot(quote)
            row = {
                "timestamp": str(quote["timestamp"]),
                "data_timestamp": str(quote["timestamp"]),
                "symbol": str(quote.get("symbol", self.cli_config.symbol)),
                "open": float(quote.get("mid", quote.get("bid", 0.0))),
                "high": float(quote.get("ask", quote.get("mid", 0.0))),
                "low": float(quote.get("bid", quote.get("mid", 0.0))),
                "close": float(quote.get("mid", quote.get("bid", 0.0))),
                "bid": float(quote.get("bid", quote.get("mid", 0.0))),
                "ask": float(quote.get("ask", quote.get("mid", 0.0))),
                "source": str(quote.get("source", "cTrader CLI")),
                "source_type": str(quote.get("source_type", "spot")),
                "data_mode": str(health_payload.get("data_mode", "live_seen")),
                "is_stale": bool(health_payload.get("is_stale", False)),
                "stale_reason": str(health_payload.get("stale_reason", "")),
            }
            return [row], _provider_health_from_payload(health_payload, str(quote.get("symbol_id", self.cli_config.symbol)))
        except Exception as exc:
            if self.cli_config.allow_saved_snapshot_fallback:
                rows, health = self._load_saved_snapshot(anchor_time, fallback_error=str(exc))
                if rows:
                    return rows, health
            return [], self._unavailable_health(str(exc))

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
