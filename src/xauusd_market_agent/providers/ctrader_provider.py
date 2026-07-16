from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable

from ..config import CTraderCliConfig
from ..market_session import classify_xauusd_stale_quote
from ..models import ProviderHealth
from .ctrader_bridge import handle as run_ctrader_cli_command

BridgeRunner = Callable[[str, dict[str, object]], dict[str, object]]
LiveStreamStarter = Callable[[dict[str, object]], None]
ProcessChecker = Callable[[int], bool]


def _mask_secret(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 4:
        return "*" * len(value)
    return f"{value[:2]}{'*' * max(4, len(value) - 4)}{value[-2:]}"


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat()


def _parse_quote_timestamp(raw: str, anchor_time: datetime) -> datetime | None:
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=anchor_time.tzinfo)
    return parsed


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


def _default_process_checker(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        try:
            import ctypes

            process_query_limited_information = 0x1000
            handle = ctypes.windll.kernel32.OpenProcess(
                process_query_limited_information,
                False,
                pid,
            )
            if not handle:
                return False
            ctypes.windll.kernel32.CloseHandle(handle)
            return True
        except Exception:
            return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _default_live_stream_starter(payload: dict[str, object]) -> None:
    repo_root = Path(__file__).resolve().parents[3]
    command = [
        sys.executable,
        "-m",
        "src.xauusd_market_agent.providers.ctrader_live_stream",
        "start",
    ]
    startupinfo = None
    creationflags = 0
    if os.name == "nt":
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = 0
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    process = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        text=True,
        cwd=str(repo_root),
        startupinfo=startupinfo,
        creationflags=creationflags,
    )
    if process.stdin is not None:
        process.stdin.write(json.dumps(payload, ensure_ascii=False))
        process.stdin.close()


class CTraderProvider:
    def __init__(
        self,
        *,
        cli_config: CTraderCliConfig,
        bridge_runner: BridgeRunner | None = None,
        saved_snapshot_path: Path | None = None,
        live_stream_status_path: Path | None = None,
        live_stream_starter: LiveStreamStarter | None = None,
        process_checker: ProcessChecker | None = None,
    ) -> None:
        self.cli_config = cli_config
        self.saved_snapshot_path = (
            Path(saved_snapshot_path)
            if saved_snapshot_path is not None
            else Path(cli_config.snapshot_path)
        )
        self.live_stream_status_path = (
            Path(live_stream_status_path)
            if live_stream_status_path is not None
            else self.saved_snapshot_path.with_name("ctrader_live_stream_status.json")
        )
        self.bridge_runner = bridge_runner or _default_bridge_runner(cli_config)
        self.live_stream_starter = live_stream_starter or _default_live_stream_starter
        self.process_checker = process_checker or _default_process_checker

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

    def _live_stream_payload(self) -> dict[str, object]:
        cfg = self.cli_config
        return {
            "accountId": cfg.account_id,
            "ctid": cfg.ctid,
            "password": cfg.password,
            "symbol": cfg.symbol,
            "symbolId": cfg.symbol_id,
            "snapshotPath": str(self.saved_snapshot_path),
            "statusPath": str(self.live_stream_status_path),
            "quoteStaleAfterSeconds": cfg.quote_stale_after_seconds,
            "cliExecutable": cfg.cli_executable,
        }

    def _read_live_stream_status(self) -> dict[str, Any]:
        try:
            payload = json.loads(self.live_stream_status_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return payload if isinstance(payload, dict) else {}

    def _mark_live_stream_stopped(self, reason: str) -> None:
        try:
            payload = {
                "ok": False,
                "running": False,
                "phase": "stopped",
                "pid": None,
                "bridgePid": None,
                "startedAt": "",
                "stoppedAt": _now_iso(),
                "snapshotPath": str(self.saved_snapshot_path),
                "message": "Live quote stream is stopped.",
                "lastError": reason,
            }
            self.live_stream_status_path.parent.mkdir(parents=True, exist_ok=True)
            self.live_stream_status_path.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except OSError:
            return

    def _live_stream_is_running(self) -> bool:
        status = self._read_live_stream_status()
        if status.get("running") is not True:
            return False
        try:
            pid = int(status.get("pid") or 0)
        except (TypeError, ValueError):
            pid = 0
        try:
            bridge_pid = int(status.get("bridgePid") or 0)
        except (TypeError, ValueError):
            bridge_pid = 0
        if not pid or not self.process_checker(pid):
            self._mark_live_stream_stopped("cTrader live stream supervisor process is not running.")
            return False
        if bridge_pid and not self.process_checker(bridge_pid):
            self._mark_live_stream_stopped("cTrader live stream bridge process is not running.")
            return False
        return True

    def _live_stream_snapshot_is_fresh_or_pending(self) -> bool:
        try:
            payload = json.loads(self.saved_snapshot_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return True
        if not isinstance(payload, dict):
            return False
        timestamp = str(payload.get("timestamp") or payload.get("server_time") or "").strip()
        parsed = _parse_quote_timestamp(timestamp, datetime.now().astimezone())
        if parsed is None:
            return False
        classification = classify_xauusd_stale_quote(
            quote_time=parsed,
            anchor_time=datetime.now().astimezone(),
            stale_after_seconds=self.cli_config.quote_stale_after_seconds,
        )
        return classification.classification in {"fresh", "stale", "market_closed"}

    def _ensure_live_stream_started(self) -> None:
        if not self.cli_config.is_ready() or self._live_stream_is_running():
            return
        try:
            self.live_stream_starter(self._live_stream_payload())
        except Exception:
            return

    def _wait_for_fresh_live_snapshot(
        self,
        anchor_time: datetime,
        *,
        previous_timestamp: str = "",
    ) -> tuple[list[dict[str, Any]], ProviderHealth] | None:
        deadline = time.monotonic() + max(0.5, float(self.cli_config.quote_timeout_seconds))
        while time.monotonic() < deadline:
            fresh_snapshot = self._load_fresh_snapshot(anchor_time)
            if fresh_snapshot is not None:
                rows, health = fresh_snapshot
                # A snapshot that is fresh for this run is usable even if the
                # quote timestamp matches the last stored file. The monitor may
                # restart between runs without the market printing a new tick.
                if health.data_mode == "live_seen" and not health.is_stale:
                    return rows, health
            time.sleep(0.25)
        return None

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

    def _load_fresh_snapshot(
        self, anchor_time: datetime
    ) -> tuple[list[dict[str, Any]], ProviderHealth] | None:
        if not self.saved_snapshot_path.exists():
            return None
        try:
            payload = json.loads(self.saved_snapshot_path.read_text(encoding="utf-8"))
        except Exception:
            return None
        if not isinstance(payload, dict):
            return None
        timestamp = str(payload.get("timestamp", "")).strip()
        if not timestamp:
            return None
        quote_time = _parse_quote_timestamp(timestamp, anchor_time)
        if quote_time is None:
            return None
        classification = classify_xauusd_stale_quote(
            quote_time=quote_time,
            anchor_time=anchor_time,
            stale_after_seconds=self.cli_config.quote_stale_after_seconds,
        )
        if classification.classification != "fresh":
            return None
        mid = payload.get("mid", payload.get("close", payload.get("bid")))
        bid = payload.get("bid", mid)
        ask = payload.get("ask", mid)
        if mid is None or bid is None or ask is None:
            return None
        quote = {
            "symbol": str(payload.get("symbol", self.cli_config.symbol)),
            "bid": float(bid),
            "ask": float(ask),
            "mid": float(mid),
            "timestamp": timestamp,
            "source": "cTrader live snapshot",
            "source_type": "spot",
        }
        health_payload = {
            "data_mode": "live_seen",
            "is_stale": False,
            "stale_reason": "",
        }
        bars = [payload.get("m1_bar")] if isinstance(payload.get("m1_bar"), dict) else []
        live_rows = self._bar_rows(bars, fallback_quote=quote, health_payload=health_payload)
        row = {
            "timestamp": timestamp,
            "data_timestamp": timestamp,
            "symbol": str(payload.get("symbol", self.cli_config.symbol)),
            "open": float(mid),
            "high": float(ask),
            "low": float(bid),
            "close": float(mid),
            "bid": float(bid),
            "ask": float(ask),
            "source": "cTrader live snapshot",
            "source_type": "spot",
            "data_mode": "live_seen",
            "is_stale": False,
            "stale_reason": "",
        }
        health = ProviderHealth(
            source="cTrader",
            source_type="spot",
            fetched_at=anchor_time.isoformat(),
            data_timestamp=timestamp,
            data_mode="live_seen",
            is_available=True,
            is_stale=False,
            stale_reason="",
            error="",
            raw_source_id=str(payload.get("symbol_id", payload.get("symbolId", self.cli_config.symbol))),
            current_value=float(mid),
        )
        return live_rows or [row], health

    def _load_stale_live_snapshot_context(
        self,
        anchor_time: datetime,
        *,
        fallback_error: str = "",
    ) -> tuple[list[dict[str, Any]], ProviderHealth] | None:
        if not self.saved_snapshot_path.exists():
            return None
        try:
            payload = json.loads(self.saved_snapshot_path.read_text(encoding="utf-8"))
        except Exception:
            return None
        if not isinstance(payload, dict) or payload.get("ok") is False:
            return None
        timestamp = str(
            payload.get("timestamp", "")
            or payload.get("server_time", "")
            or payload.get("data_timestamp", "")
        ).strip()
        quote_time = _parse_quote_timestamp(timestamp, anchor_time)
        mid = payload.get("mid", payload.get("close", payload.get("bid")))
        bid = payload.get("bid", mid)
        ask = payload.get("ask", mid)
        if quote_time is None or mid is None or bid is None or ask is None:
            return None
        classification = classify_xauusd_stale_quote(
            quote_time=quote_time,
            anchor_time=anchor_time,
            stale_after_seconds=self.cli_config.quote_stale_after_seconds,
        )
        if classification.classification == "fresh":
            return None
        reason = classification.reason
        if fallback_error and classification.classification != "market_closed":
            reason = f"{reason} {fallback_error}".strip()
        quote = {
            "symbol": str(payload.get("symbol", self.cli_config.symbol)),
            "bid": float(bid),
            "ask": float(ask),
            "mid": float(mid),
            "timestamp": timestamp,
            "source": "cTrader live snapshot",
            "source_type": "spot",
        }
        health_payload = {
            "data_mode": "stale",
            "is_stale": True,
            "stale_reason": reason,
        }
        bars = [payload.get("m1_bar")] if isinstance(payload.get("m1_bar"), dict) else []
        live_rows = self._bar_rows(bars, fallback_quote=quote, health_payload=health_payload)
        row = {
            "timestamp": timestamp,
            "data_timestamp": timestamp,
            "symbol": str(payload.get("symbol", self.cli_config.symbol)),
            "open": float(mid),
            "high": float(ask),
            "low": float(bid),
            "close": float(mid),
            "bid": float(bid),
            "ask": float(ask),
            "source": "cTrader live snapshot",
            "source_type": "spot",
            "data_mode": "stale",
            "is_stale": True,
            "stale_reason": reason,
        }
        health = ProviderHealth(
            source="cTrader",
            source_type="spot",
            fetched_at=anchor_time.isoformat(),
            data_timestamp=timestamp,
            data_mode="stale",
            is_available=True,
            is_stale=True,
            stale_reason=reason,
            error="" if classification.classification == "market_closed" else fallback_error,
            raw_source_id=str(payload.get("symbol_id", payload.get("symbolId", self.cli_config.symbol))),
            current_value=float(mid),
            metadata={
                "stale_classification": classification.classification,
                "quote_age_seconds": classification.age_seconds,
                "market_closed": classification.market_closed,
            },
        )
        return live_rows or [row], health

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
        fresh_snapshot = self._load_fresh_snapshot(anchor_time)
        if fresh_snapshot is not None:
            return fresh_snapshot
        if not self.cli_config.quote_bridge_enabled:
            reason = "Waiting for fresh cTrader live stream snapshot."
            stale_context = self._load_stale_live_snapshot_context(anchor_time, fallback_error=reason)
            if stale_context is not None:
                _, stale_health = stale_context
                if stale_health.metadata.get("stale_classification") == "market_closed":
                    return stale_context
            previous_timestamp = ""
            try:
                payload = json.loads(self.saved_snapshot_path.read_text(encoding="utf-8"))
                if isinstance(payload, dict):
                    previous_timestamp = str(
                        payload.get("timestamp")
                        or payload.get("server_time")
                        or payload.get("data_timestamp")
                        or ""
                    )
            except Exception:
                previous_timestamp = ""
            self._ensure_live_stream_started()
            fresh_after_start = self._wait_for_fresh_live_snapshot(
                anchor_time,
                previous_timestamp=previous_timestamp,
            )
            if fresh_after_start is not None:
                return fresh_after_start
            stream_status = self._read_live_stream_status()
            stream_phase = str(stream_status.get("phase") or "").strip()
            if not stream_phase and stream_status.get("running") is True:
                stream_phase = "running"
            if stream_phase in {"starting", "waiting_for_first_snapshot", "error", "stopped"}:
                detail = str(stream_status.get("message") or reason)
                error = str(stream_status.get("lastError") or "")
                return [], self._unavailable_health(" ".join(part for part in [detail, error] if part).strip() or reason)
            if stream_phase == "running" and stale_context is not None:
                return stale_context
            return [], self._unavailable_health(reason)
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
            stale_context = self._load_stale_live_snapshot_context(anchor_time, fallback_error=str(exc))
            if stale_context is not None:
                return stale_context
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
        health_is_stale = bool(health_payload.get("is_stale", False))
        health_data_mode = str(health_payload.get("data_mode", "live_seen"))
        health_stale_reason = str(health_payload.get("stale_reason", ""))
        for bar in bars:
            if not isinstance(bar, dict):
                continue
            close = bar.get("close", fallback_quote.get("mid", fallback_quote.get("bid", 0.0)))
            row_data_mode = health_data_mode if health_is_stale else str(bar.get("data_mode", health_data_mode))
            row_stale_reason = health_stale_reason if health_is_stale else str(bar.get("stale_reason", health_stale_reason))
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
                    "data_mode": row_data_mode,
                    "is_stale": health_is_stale or bool(bar.get("is_stale", False)),
                    "stale_reason": row_stale_reason,
                }
            )
        return rows

    def backfill(self, start: datetime, end: datetime) -> tuple[list[dict[str, object]], ProviderHealth]:
        if not self.is_configured():
            return [], self._unavailable_health("cTrader CLI credentials are not configured.")
        if not self.cli_config.quote_bridge_enabled:
            return [], self._unavailable_health(
                "Automatic cTrader CLI history bridge is disabled; use an explicit backfill/test action."
            )
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
