from __future__ import annotations

from dataclasses import asdict, replace
from datetime import datetime, timedelta
import json
import os
import time
from pathlib import Path
from typing import Any

from .backfill import BackfillManager
from .config import MarketAgentConfig
from .driver_attention import DriverAttentionManager
from .detectors import detect_market_trigger
from .evidence import build_evidence_gate_result
from .llm_client import LocalLLMClient
from .models import CrossAssetSnapshot, EvidenceChainStatus, Headline, MarketMove, ProviderHealth, ScenarioFixture
from .notification_policy import decide_notification
from .notifier import FileNotificationSink, TelegramNotificationSink
from .pipeline import analyze_fixture_with_optional_llm
from .provider_health import health_to_dict
from .providers.provider_router import ProviderRouter
from .state_store import JsonStateStore
from .timeline_store import TimelineStore


def _status_path_from_env(status_path: Path | None = None) -> Path | None:
    if status_path is not None:
        return Path(status_path)
    raw = os.getenv("MARKET_AGENT_MONITOR_STATUS_PATH", "").strip()
    return Path(raw) if raw else None


def _read_monitor_status(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def _write_monitor_status(status_path: Path | None, **updates: Any) -> None:
    path = _status_path_from_env(status_path)
    if path is None:
        return
    current = _read_monitor_status(path) if path.exists() else {}
    payload = {
        "ok": True,
        "available": True,
        "running": False,
        "phase": "stopped",
        "pid": os.getpid(),
        "lastError": "",
        "message": "Monitor loop is stopped.",
        **current,
        **updates,
        "updatedAt": datetime.now().astimezone().isoformat(),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    temp_path.replace(path)


def _provider_health_payload(health: ProviderHealth | None) -> dict[str, Any]:
    return asdict(health) if health is not None else {}


def _unique_strings(values: list[object]) -> list[str]:
    seen: dict[str, None] = {}
    for value in values:
        text = str(value or "").strip()
        if text:
            seen.setdefault(text, None)
    return list(seen.keys())


def _latest_value(rows: list[dict[str, Any]], key: str) -> str | None:
    values = [str(row.get(key, "")).strip() for row in rows if str(row.get(key, "")).strip()]
    return max(values) if values else None


def _compact_sources(rows: list[dict[str, Any]], limit: int = 4) -> list[str]:
    return _unique_strings([row.get("source", "") for row in rows])[:limit]


def _symbols_from_rows(*row_groups: list[dict[str, Any]] | None) -> list[str]:
    symbols: list[object] = []
    for rows in row_groups:
        for row in rows or []:
            symbols.append(str(row.get("symbol", "")).upper())
    return _unique_strings(symbols) or ["XAUUSD"]


def _time_bounds(rows: list[dict[str, Any]], key: str) -> tuple[str | None, str | None]:
    values = sorted(str(row.get(key, "")).strip() for row in rows if str(row.get(key, "")).strip())
    if not values:
        return None, None
    return values[0], values[-1]


def _format_price(value: object) -> str:
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return ""
    return f"{number:,.2f}"


def _ctrader_activity(health: ProviderHealth | None) -> dict[str, Any]:
    if health is None:
        return {
            "status": "waiting",
            "label": "Waiting for XAUUSD",
            "detail": "cTrader has not returned a price snapshot yet.",
            "symbols": ["XAUUSD"],
        }
    price = _format_price(health.current_value)
    base = {
        "symbols": ["XAUUSD"],
        "source": health.source,
        "sourceType": health.source_type,
        "dataMode": health.data_mode,
        "dataTimestamp": health.data_timestamp,
        "fetchedAt": health.fetched_at,
        "providerHealth": _provider_health_payload(health),
    }
    if health.is_available and not health.is_stale and health.data_mode == "live_seen":
        return {
            **base,
            "status": "live",
            "label": "XAUUSD live",
            "detail": f"Last price {price} from cTrader." if price else "Live XAUUSD quote is active.",
        }
    if health.is_available and health.current_value is not None:
        return {
            **base,
            "status": "market_closed",
            "label": "Market closed",
            "detail": (
                f"Last XAUUSD price {price} is fixed until the market reopens; "
                "news and calendar still update."
            )
            if price
            else "Last XAUUSD price is fixed until the market reopens; news and calendar still update.",
        }
    return {
        **base,
        "status": "unavailable",
        "label": "No XAUUSD price",
        "detail": health.error or health.stale_reason or "cTrader has not returned a usable XAUUSD price.",
    }


def _context_activity(
    news_count: int,
    calendar_count: int,
    *,
    news_rows: list[dict[str, Any]] | None = None,
    calendar_rows: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    news_rows = news_rows or []
    calendar_rows = calendar_rows or []
    detail = f"{news_count} headlines and {calendar_count} calendar events collected."
    return {
        "status": "active" if news_count or calendar_count else "collecting",
        "label": "News and calendar",
        "detail": detail,
        "newsCount": news_count,
        "calendarCount": calendar_count,
        "sources": _unique_strings([*_compact_sources(news_rows), *_compact_sources(calendar_rows)]),
        "latestNewsAt": _latest_value(news_rows, "published_at"),
        "latestCalendarAt": _latest_value(calendar_rows, "scheduled_at"),
    }


def _history_activity(
    backfill_required: bool,
    *,
    completed: bool = False,
    window_start: str | None = None,
    window_end: str | None = None,
    stored_rows: int | None = None,
    symbols: list[str] | None = None,
) -> dict[str, Any]:
    base: dict[str, Any] = {
        "symbols": symbols or ["XAUUSD"],
        "windowStart": window_start,
        "windowEnd": window_end,
    }
    if stored_rows is not None:
        base["storedRows"] = stored_rows
    if backfill_required and completed:
        return {
            **base,
            "status": "synced",
            "label": "History synced",
            "detail": "Missing cTrader history was stored for replay and evidence.",
            "progress": 100,
        }
    if backfill_required:
        return {
            **base,
            "status": "syncing",
            "label": "History sync",
            "detail": "Backfill runs in the background after the current live check.",
        }
    return {
        **base,
        "status": "idle",
        "label": "History current",
        "detail": "No backfill gap detected for this run.",
    }


def _llm_activity(
    llm_enabled: bool,
    llm_status: str | None = None,
    *,
    model: str | None = None,
    analysis: Any | None = None,
) -> dict[str, Any]:
    base: dict[str, Any] = {}
    if model:
        base["model"] = model
    if analysis is not None:
        base["result"] = str(getattr(analysis, "main_driver", "unknown") or "unknown")
        base["causeStatus"] = str(getattr(analysis, "cause_status", "") or "")
        base["analysisEngine"] = str(getattr(analysis, "analysis_engine", "") or "")
    if not llm_enabled:
        return {
            **base,
            "status": "skipped",
            "label": "Rule-based",
            "detail": "Evidence gate and deterministic rules ran without Local AI.",
        }
    if llm_status == "validated":
        return {
            **base,
            "status": "validated",
            "label": "Local AI reviewed",
            "detail": "LLM output passed validation after the evidence gate.",
        }
    if llm_status:
        return {
            **base,
            "status": "unavailable",
            "label": "Local AI unavailable",
            "detail": "Rules were used because Local AI did not return a valid review.",
        }
    return {
        **base,
        "status": "queued",
        "label": "Local AI queued",
        "detail": "Batch review runs after evidence gate.",
    }


def _alert_activity(
    decision: Any | None = None,
    telegram_result: dict[str, Any] | None = None,
    *,
    alert_preflight: dict[str, Any] | None = None,
) -> dict[str, Any]:
    base = {
        "preflightStatus": (alert_preflight or {}).get("status"),
        "preflightReason": (alert_preflight or {}).get("reason"),
        "telegramStatus": (telegram_result or {}).get("status"),
        "notificationLevel": getattr(decision, "notification_level", None) if decision is not None else None,
    }
    if decision is None:
        return {
            **base,
            "status": "pending",
            "label": "Alert gate",
            "detail": "Waiting for evidence and notification policy.",
        }
    if getattr(decision, "should_notify", False):
        sent = bool((telegram_result or {}).get("sent"))
        return {
            **base,
            "status": "sent" if sent else "ready",
            "label": "Alert sent" if sent else "Alert ready",
            "detail": "A current live alert passed the gate.",
        }
    return {
        **base,
        "status": "suppressed" if getattr(decision, "reason", "") else "idle",
        "label": "No alert",
        "detail": getattr(decision, "reason", "") or "No current live alert passed the gate.",
    }


def _evidence_activity(chain_status: EvidenceChainStatus | None = None) -> dict[str, Any]:
    if chain_status is None:
        return {
            "status": "pending",
            "label": "Evidence gate",
            "detail": "Waiting for provider health and market context.",
        }
    label = {
        "ready": "Evidence gate ready",
        "partial": "Evidence partial",
        "context_only": "Context only",
    }.get(chain_status.status, "Evidence gate")
    return {
        "status": chain_status.status,
        "label": label,
        "detail": chain_status.reason,
        "chainStatus": chain_status.status,
        "usableInputs": chain_status.usable_inputs,
        "missingRequired": chain_status.missing_required,
        "contextOnlyInputs": chain_status.context_only_inputs,
        "llmStatus": chain_status.llm_status,
    }


def _replay_activity(
    *,
    monitor_run_id: int | None = None,
    timeline_store_path: Path | None = None,
    storage_counts: dict[str, int] | None = None,
    storage_summary: dict[str, Any] | None = None,
    symbols: list[str] | None = None,
) -> dict[str, Any]:
    if monitor_run_id is None:
        return {
            "status": "pending",
            "label": "Replay store",
            "detail": "Waiting for this run to be persisted.",
            "symbols": symbols or [],
        }
    return {
        "status": "stored",
        "label": "Replay stored",
        "detail": f"Run {monitor_run_id} persisted to TimelineStore.",
        "monitorRunId": monitor_run_id,
        "timelineStorePath": str(timeline_store_path) if timeline_store_path is not None else "",
        "stored": storage_counts or {},
        "storageSummary": storage_summary or {},
        "symbols": symbols or [],
    }


def _activity_snapshot(
    *,
    provider_health: dict[str, ProviderHealth],
    news_count: int,
    calendar_count: int,
    backfill_required: bool,
    llm_enabled: bool,
    llm_status: str | None = None,
    decision: Any | None = None,
    telegram_result: dict[str, Any] | None = None,
    history_completed: bool = False,
    news_rows: list[dict[str, Any]] | None = None,
    calendar_rows: list[dict[str, Any]] | None = None,
    market_price_bar_count: int | None = None,
    related_asset_bar_count: int | None = None,
    market_price_bars: list[dict[str, Any]] | None = None,
    related_asset_bars: list[dict[str, Any]] | None = None,
    chain_status: EvidenceChainStatus | None = None,
    analysis: Any | None = None,
    llm_model: str | None = None,
    alert_preflight: dict[str, Any] | None = None,
    monitor_run_id: int | None = None,
    timeline_store_path: Path | None = None,
    storage_counts: dict[str, int] | None = None,
    storage_summary: dict[str, Any] | None = None,
    history_window_start: str | None = None,
    history_window_end: str | None = None,
) -> dict[str, Any]:
    market_price_bars = market_price_bars or []
    related_asset_bars = related_asset_bars or []
    symbols = _symbols_from_rows(market_price_bars, related_asset_bars)
    market_start, market_end = _time_bounds([*market_price_bars, *related_asset_bars], "data_timestamp")
    history_window_start = market_start or history_window_start
    history_window_end = market_end or history_window_end
    if market_price_bar_count is None:
        market_price_bar_count = len(market_price_bars)
    if related_asset_bar_count is None:
        related_asset_bar_count = len(related_asset_bars)
    history_stored_rows = None
    if market_price_bar_count is not None or related_asset_bar_count is not None:
        history_stored_rows = int(market_price_bar_count or 0) + int(related_asset_bar_count or 0)
    return {
        "ctrader": _ctrader_activity(provider_health.get("xauusd")),
        "history": _history_activity(
            backfill_required,
            completed=history_completed,
            window_start=history_window_start,
            window_end=history_window_end,
            stored_rows=history_stored_rows,
            symbols=symbols,
        ),
        "context": _context_activity(
            news_count,
            calendar_count,
            news_rows=news_rows,
            calendar_rows=calendar_rows,
        ),
        "evidence": _evidence_activity(chain_status),
        "llm": _llm_activity(llm_enabled, llm_status, model=llm_model, analysis=analysis),
        "replay": _replay_activity(
            monitor_run_id=monitor_run_id,
            timeline_store_path=timeline_store_path,
            storage_counts=storage_counts,
            storage_summary=storage_summary,
            symbols=symbols,
        ),
        "alerts": _alert_activity(decision, telegram_result, alert_preflight=alert_preflight),
    }


class MonitorLock:
    def __init__(self, path: Path, *, stale_after_seconds: int = 900) -> None:
        self.path = Path(path)
        self.stale_after_seconds = stale_after_seconds
        self._fd: int | None = None

    def __enter__(self) -> "MonitorLock | None":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        now = time.time()
        try:
            stat = self.path.stat()
            if now - stat.st_mtime > self.stale_after_seconds:
                self.path.unlink(missing_ok=True)
        except FileNotFoundError:
            pass
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
        try:
            self._fd = os.open(self.path, flags)
        except FileExistsError:
            return None
        os.write(self._fd, f"{os.getpid()}\n{datetime.now().astimezone().isoformat()}\n".encode("utf-8"))
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        if self._fd is not None:
            os.close(self._fd)
            self._fd = None
            self.path.unlink(missing_ok=True)


def _parse_ts(raw: str) -> datetime:
    return datetime.fromisoformat(raw)


def _headline_time(raw: str) -> str:
    return _parse_ts(raw).astimezone().strftime("%d-%m-%Y %H:%M")


def _headline_from_news(row: dict[str, Any]) -> Headline:
    tags = tuple(row.get("categories", [])) + tuple(row.get("matched_keywords", []))
    if not row.get("included", True):
        tags = tags + ("filtered", str(row.get("filter_reason", "")))
    return Headline(
        timestamp_myt=_headline_time(row["published_at"]),
        source=str(row["source"]),
        title=str(row["title"]),
        relevance_reason=str(row.get("relevance_reason", "")),
        impact_direction_on_gold=str(row.get("impact_direction_on_gold", "unknown")),
        tags=tuple(dict.fromkeys(tags)),
    )


def _headline_from_calendar(row: dict[str, Any]) -> Headline:
    tags = ("calendar", str(row.get("impact", "")).lower())
    return Headline(
        timestamp_myt=_headline_time(row["scheduled_at"]),
        source=str(row["source"]),
        title=str(row["title"]),
        relevance_reason=str(row.get("relevance_reason", "")),
        impact_direction_on_gold=str(row.get("impact_direction_on_gold", "unknown")),
        tags=tuple(dict.fromkeys(tags)),
    )


def _empty_fixture(anchor_time: datetime) -> ScenarioFixture:
    return ScenarioFixture(
        scenario_id="live_market_unavailable",
        as_of_myt=anchor_time.astimezone().strftime("%d-%m-%Y %H:%M"),
        market=MarketMove(
            symbol="XAUUSD",
            from_price=0.0,
            to_price=0.0,
            move_percent=0.0,
            move_percent_15m=0.0,
            move_percent_1h=0.0,
            window_minutes=15,
            breaks=(),
        ),
        cross_asset=CrossAssetSnapshot(
            dxy_percent=0.0,
            us10y_bps=0.0,
            us2y_bps=0.0,
            wti_percent=0.0,
            brent_percent=0.0,
            vix_percent=0.0,
            spx_percent=0.0,
            nasdaq_percent=0.0,
        ),
        calendar_events=(),
        news=(),
        expected_llm_claim=None,
    )


def _cross_asset_from_rows(related_rows: list[dict[str, Any]]) -> CrossAssetSnapshot:
    latest: dict[str, dict[str, Any]] = {}
    for row in sorted(related_rows, key=lambda item: item["data_timestamp"]):
        latest[str(row["symbol"]).lower()] = row

    def value(symbol: str) -> float:
        row = latest.get(symbol, {})
        return float(
            row.get("change_15m")
            or row.get("change_value")
            or 0.0
        )

    return CrossAssetSnapshot(
        dxy_percent=value("dxy"),
        us10y_bps=value("us10y"),
        us2y_bps=value("us2y"),
        wti_percent=value("wti"),
        brent_percent=value("brent"),
        vix_percent=value("vix"),
        spx_percent=value("spx"),
        nasdaq_percent=value("nasdaq"),
    )


def _market_move_from_rows(anchor_time: datetime, rows: list[dict[str, Any]]) -> MarketMove:
    if not rows:
        return _empty_fixture(anchor_time).market
    ordered = sorted(rows, key=lambda item: item["data_timestamp"])
    first = ordered[0]
    last = ordered[-1]
    from_price = float(first.get("open_price") or first["close_price"])
    to_price = float(last["close_price"])
    move_percent = 0.0 if from_price == 0 else ((to_price - from_price) / from_price) * 100.0
    return MarketMove(
        symbol=str(last.get("symbol", "XAUUSD")),
        from_price=from_price,
        to_price=to_price,
        move_percent=move_percent,
        move_percent_15m=move_percent,
        move_percent_1h=move_percent,
        window_minutes=max(15, len(ordered) * 5),
        breaks=(),
    )


def _build_fixture_from_context(
    *,
    anchor_time: datetime,
    market_price_bars: list[dict[str, Any]],
    related_asset_bars: list[dict[str, Any]],
    news_rows: list[dict[str, Any]],
    calendar_rows: list[dict[str, Any]],
    scenario_id: str,
) -> ScenarioFixture:
    market = _market_move_from_rows(anchor_time, market_price_bars)
    included_news_rows = [item for item in news_rows if item.get("included", True)]
    return ScenarioFixture(
        scenario_id=scenario_id,
        as_of_myt=anchor_time.astimezone().strftime("%d-%m-%Y %H:%M"),
        market=market,
        cross_asset=_cross_asset_from_rows(related_asset_bars),
        calendar_events=tuple(_headline_from_calendar(item) for item in calendar_rows),
        news=tuple(_headline_from_news(item) for item in included_news_rows),
        expected_llm_claim=None,
    )


def _build_runtime_context(
    config: MarketAgentConfig,
    anchor_time: datetime,
    *,
    provider_router: ProviderRouter | None = None,
    news_headlines: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    router = provider_router or ProviderRouter.from_config(config)
    market_rows, market_health = router.fetch_market_context(anchor_time)
    related_rows, related_health = router.fetch_related_assets_context(anchor_time)
    news_rows, news_health = router.fetch_news_context(anchor_time)
    calendar_rows, calendar_health = router.fetch_calendar_context(anchor_time)
    if news_headlines:
        injected = []
        for item in news_headlines:
            published_at = str(item.get("published_at", anchor_time.isoformat()))
            injected.append(
                {
                    "published_at": published_at,
                    "first_seen_at": anchor_time.isoformat(),
                    "backfilled_at": None,
                    "is_backfilled": False,
                    "source": str(item.get("source", "Injected")),
                    "title": str(item.get("title", "")),
                    "link": str(item.get("link", "")),
                    "relevance_reason": str(item.get("relevance_reason", "Injected headline.")),
                    "impact_direction_on_gold": str(item.get("impact_direction_on_gold", "unknown")),
                    "data_mode": "live_seen",
                    "included": bool(item.get("included", True)),
                    "filter_reason": str(item.get("filter_reason", "")),
                    "source_quality_score": float(item.get("source_quality_score", item.get("score", 0.6))),
                    "score": float(item.get("score", 0.6)),
                    "matched_keywords": item.get("matched_keywords", []),
                    "categories": item.get("categories", ["injected"]),
                }
            )
        news_rows.extend(injected)
        news_rows.sort(key=lambda item: item["published_at"])
        if injected:
            news_health = ProviderHealth(
                **{
                    **asdict(news_health),
                    "data_mode": news_health.data_mode if news_health.is_available else "live_seen",
                    "is_available": True,
                    "current_value": float(len(news_rows)),
                    "data_timestamp": news_rows[-1]["published_at"],
                }
            )
    fixture = _build_fixture_from_context(
        anchor_time=anchor_time,
        market_price_bars=market_rows,
        related_asset_bars=related_rows,
        news_rows=news_rows,
        calendar_rows=calendar_rows,
        scenario_id="live_once",
    )
    return {
        "fixture": fixture,
        "provider_health": {
            "xauusd": market_health,
            **related_health,
            "news": news_health,
            "calendar": calendar_health,
        },
        "selected_market_provider": router.last_market_provider_meta.get("selected_market_provider", "unavailable"),
        "provider_chain_status": router.last_market_provider_meta.get("provider_chain_status", []),
        "fallback_reason": router.last_market_provider_meta.get("fallback_reason", ""),
        "market_price_bars": market_rows,
        "related_asset_bars": related_rows,
        "news_rows": news_rows,
        "calendar_rows": calendar_rows,
    }


def _run_recovery_backfill(
    config: MarketAgentConfig,
    *,
    previous_run_at: str,
    anchor_time: datetime,
    provider_router: ProviderRouter | None = None,
    news_headlines: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    router = provider_router or ProviderRouter.from_config(config)
    recovery = BackfillManager(router).recover_gap(datetime.fromisoformat(previous_run_at), anchor_time)
    if news_headlines:
        for item in news_headlines:
            recovery.news_rows.append(
                {
                    "published_at": str(item.get("published_at", anchor_time.isoformat())),
                    "first_seen_at": anchor_time.isoformat(),
                    "backfilled_at": anchor_time.isoformat(),
                    "is_backfilled": True,
                    "source": str(item.get("source", "Injected")),
                    "title": str(item.get("title", "")),
                    "link": str(item.get("link", "")),
                    "relevance_reason": str(item.get("relevance_reason", "Injected recovery headline.")),
                    "impact_direction_on_gold": str(item.get("impact_direction_on_gold", "unknown")),
                    "data_mode": "backfilled",
                    "included": bool(item.get("included", True)),
                    "filter_reason": str(item.get("filter_reason", "")),
                    "source_quality_score": float(item.get("source_quality_score", item.get("score", 0.6))),
                    "score": float(item.get("score", 0.6)),
                    "matched_keywords": item.get("matched_keywords", []),
                    "categories": item.get("categories", ["injected"]),
                }
            )
        recovery.news_rows.sort(key=lambda item: item["published_at"])
    fixture = _build_fixture_from_context(
        anchor_time=anchor_time,
        market_price_bars=recovery.market_price_bars,
        related_asset_bars=recovery.related_asset_bars,
        news_rows=recovery.news_rows,
        calendar_rows=recovery.calendar_rows,
        scenario_id="recovery",
    )
    return {
        "fixture": fixture,
        "provider_health": recovery.provider_health,
        "selected_market_provider": router.last_market_provider_meta.get("selected_market_provider", "unavailable"),
        "provider_chain_status": router.last_market_provider_meta.get("provider_chain_status", []),
        "fallback_reason": router.last_market_provider_meta.get("fallback_reason", ""),
        "market_price_bars": recovery.market_price_bars,
        "related_asset_bars": recovery.related_asset_bars,
        "news_rows": recovery.news_rows,
        "calendar_rows": recovery.calendar_rows,
        "recovery_summary": recovery.recovery_summary,
        "recovery_timeline_events": recovery.recovery_timeline_events,
    }


def build_live_fixture(
    config: MarketAgentConfig,
    anchor_time: datetime,
    news_headlines: list[dict[str, Any]] | None = None,
    provider_router: ProviderRouter | None = None,
) -> ScenarioFixture:
    return _build_runtime_context(
        config,
        anchor_time=anchor_time,
        provider_router=provider_router,
        news_headlines=news_headlines,
    )["fixture"]


def _is_live_xauusd_health(health: ProviderHealth | None) -> bool:
    if health is None:
        return False
    try:
        age_seconds = (
            datetime.fromisoformat(health.fetched_at) - datetime.fromisoformat(health.data_timestamp)
        ).total_seconds()
    except (TypeError, ValueError):
        return False
    return (
        health.is_available
        and not health.is_stale
        and health.data_mode == "live_seen"
        and (health.current_value is None or float(health.current_value) > 0)
        and 0 <= age_seconds <= 300
    )


def _build_evidence_chain_status(
    *,
    fixture: ScenarioFixture,
    provider_health: dict[str, ProviderHealth],
    evidence_status: dict[str, str],
    data_mode: str,
    analysis: Any | None = None,
    market_price_bar_count: int | None = None,
    related_asset_bar_count: int | None = None,
    news_row_count: int | None = None,
    calendar_row_count: int | None = None,
) -> EvidenceChainStatus:
    missing_required: list[str] = []
    usable_inputs: list[str] = []
    context_only_inputs: list[str] = []

    xauusd = provider_health.get("xauusd")
    if _is_live_xauusd_health(xauusd) and fixture.market.to_price > 0:
        usable_inputs.append("live_xauusd_spot")
    elif xauusd and xauusd.is_available and xauusd.is_stale and xauusd.current_value:
        context_only_inputs.append("market_closed_last_xauusd_spot")
        missing_required.append("live_xauusd_spot")
    else:
        missing_required.append("live_xauusd_spot")

    if market_price_bar_count is None:
        has_history = fixture.market.from_price > 0 and fixture.market.to_price > 0 and fixture.market.window_minutes >= 15
    else:
        has_history = market_price_bar_count >= 2
    if has_history:
        usable_inputs.append("xauusd_recent_history")
    else:
        missing_required.append("xauusd_recent_history")

    confirming_related = [
        key
        for key in ("dxy", "us10y", "us2y", "oil", "vix_equities")
        if evidence_status.get(key) == "confirming"
    ]
    unavailable_related = [
        key
        for key in ("dxy", "us10y", "us2y", "oil", "vix_equities")
        if evidence_status.get(key) in {"unavailable", "stale"}
    ]
    if confirming_related:
        usable_inputs.extend(f"confirming_{key}" for key in confirming_related)
    elif related_asset_bar_count:
        context_only_inputs.append("cross_market_sensors")
    else:
        context_only_inputs.append("cross_market_sensors_unavailable")

    if news_row_count:
        usable_inputs.append("news_context")
    else:
        context_only_inputs.append("news_waiting")
    if calendar_row_count:
        usable_inputs.append("calendar_context")
    else:
        context_only_inputs.append("calendar_waiting")

    llm_status = str(getattr(analysis, "llm_status", "") or "not_used")
    if analysis is not None:
        if str(getattr(analysis, "analysis_engine", "")) == "llm_validated":
            usable_inputs.append("llm_validated")
        else:
            context_only_inputs.append(f"llm_{llm_status}")

    if missing_required:
        return EvidenceChainStatus(
            status="context_only",
            can_show_current_conclusion=False,
            reason="Current conclusion is paused until live XAUUSD price and recent price history are available.",
            missing_required=missing_required,
            usable_inputs=usable_inputs,
            context_only_inputs=context_only_inputs,
            llm_status=llm_status,
        )

    if unavailable_related and not confirming_related:
        return EvidenceChainStatus(
            status="partial",
            can_show_current_conclusion=True,
            reason="Price evidence is available, but cross-market confirmation is incomplete; only unknown or unconfirmed conclusions can pass.",
            missing_required=[],
            usable_inputs=usable_inputs,
            context_only_inputs=[*context_only_inputs, *[f"{key}_unavailable" for key in unavailable_related]],
            llm_status=llm_status,
        )

    return EvidenceChainStatus(
        status="ready",
        can_show_current_conclusion=True,
        reason="Live price, recent history, provider health, evidence gate, and validation are available for this run.",
        missing_required=[],
        usable_inputs=usable_inputs,
        context_only_inputs=context_only_inputs,
        llm_status=llm_status,
    )


def _downgrade_analysis_for_incomplete_chain(analysis: Any, chain_status: EvidenceChainStatus) -> Any:
    if chain_status.can_show_current_conclusion:
        return analysis
    if not hasattr(analysis, "__dataclass_fields__"):
        return analysis
    return replace(
        analysis,
        bias="neutral",
        main_driver="unknown",
        secondary_driver=None,
        cause_status="unconfirmed",
        confidence="low",
        is_new_state=False,
        is_continuation=False,
        previous_state_invalidated=False,
        should_notify=False,
        notification_level="none",
        allowed_candidate_drivers_used=["unknown"],
        causal_chain=chain_status.reason,
        user_message="Current market context is still being collected. No confirmed driver is available yet.",
        summary=chain_status.reason,
    )


def _suppress_unhelpful_alert(
    analysis: Any,
    *,
    chain_status: EvidenceChainStatus,
    provider_health: dict[str, ProviderHealth],
) -> Any:
    if not getattr(analysis, "should_notify", False) or not hasattr(analysis, "__dataclass_fields__"):
        return analysis

    xauusd = provider_health.get("xauusd")
    market_closed_context = bool(
        xauusd
        and xauusd.is_available
        and xauusd.is_stale
        and xauusd.current_value is not None
    )
    no_news_low_signal = bool(getattr(analysis, "no_news_found", False)) and str(
        getattr(analysis, "cause_status", "")
    ) in {"likely", "unconfirmed"}
    weak_unconfirmed = str(getattr(analysis, "cause_status", "")) == "unconfirmed" and str(
        getattr(analysis, "notification_level", "")
    ) in {"level_1", "level_2"}

    if chain_status.can_show_current_conclusion and not market_closed_context and not no_news_low_signal and not weak_unconfirmed:
        return analysis

    if market_closed_context:
        reason = "Market is closed; last price is context only and Telegram alert is suppressed."
    elif no_news_low_signal:
        reason = "No fresh news/calendar evidence confirmed the move; Telegram alert is suppressed."
    elif weak_unconfirmed:
        reason = "Move is still unconfirmed; Telegram alert is suppressed."
    else:
        reason = chain_status.reason

    return replace(
        analysis,
        should_notify=False,
        notification_level="none",
        causal_chain=reason,
        user_message=reason,
        summary=reason,
    )


def _suppress_non_live_alert(
    analysis: Any,
    *,
    run_type: str,
    data_mode: str,
) -> Any:
    if not hasattr(analysis, "__dataclass_fields__"):
        return analysis
    if run_type == "live" and data_mode == "live_seen":
        return analysis
    reason = (
        "Historical recovery data was stored for replay and evidence only; "
        "it is not a current alert."
    )
    return replace(
        analysis,
        should_notify=False,
        notification_level="none",
        causal_chain=reason,
        user_message=reason,
        summary=reason,
    )


def _format_alert_message(
    *,
    analysis: Any,
    fixture: ScenarioFixture,
    chain_status: EvidenceChainStatus,
    data_mode: str,
) -> str:
    move = fixture.market.move_percent_15m or fixture.market.move_percent
    direction = "down" if move < 0 else "up" if move > 0 else "flat"
    evidence_bits = []
    for key, label in (("dxy", "DXY"), ("us10y", "US10Y"), ("us2y", "US2Y"), ("oil", "Oil")):
        status = str(getattr(analysis, "evidence_status", {}).get(key, "") or "")
        if status in {"confirming", "contradicting", "unavailable", "stale"}:
            evidence_bits.append(f"{label}: {status}")
    evidence_line = "; ".join(evidence_bits[:4]) if evidence_bits else "No accepted cross-market confirmation."
    if not chain_status.can_show_current_conclusion:
        evidence_line = chain_status.reason
    return "\n".join(
        [
            "XAUUSD Market Agent",
            f"Status: {str(getattr(analysis, 'cause_status', 'unconfirmed')).replace('_', ' ').title()}",
            f"Move: {direction} {move:+.2f}% over {fixture.market.window_minutes}m",
            f"Driver: {str(getattr(analysis, 'main_driver', 'unknown')).replace('_', ' ').title()}",
            f"Evidence: {evidence_line}",
            f"Summary: {str(getattr(analysis, 'user_message', '')).strip()}",
            f"Data: {data_mode}",
        ]
    )


def _llm_review_alert(
    *,
    llm_client: Any,
    message: str,
    analysis: Any,
    packet: dict[str, Any],
) -> tuple[bool, str, str]:
    if llm_client is None or not hasattr(llm_client, "review_alert"):
        return True, message, "not_used"
    try:
        review = llm_client.review_alert(
            {
                "message": message,
                "analysis": analysis.to_dict() if hasattr(analysis, "to_dict") else {},
                "evidence_packet": packet,
                "rules": [
                    "Approve only if the message is formatted with status, move, driver, evidence, summary, and data.",
                    "Block if market is closed/stale/context-only.",
                    "Block if no accepted evidence supports the stated driver.",
                    "Do not invent drivers, prices, news, or trading advice.",
                    "Rewrite only to make the message clearer without adding facts.",
                ],
            }
        )
    except Exception:
        return True, message, "unavailable"
    if not isinstance(review, dict):
        return True, message, "unavailable"
    decision = str(review.get("decision", "approve")).lower()
    if decision == "block":
        return False, message, str(review.get("reason", "LLM alert review blocked the message."))
    if decision == "rewrite":
        rewritten = str(review.get("message", "")).strip()
        if rewritten and "XAUUSD" in rewritten and "Evidence:" in rewritten:
            return True, rewritten, "rewritten"
    return True, message, "approved"


def _preflight_alert(
    *,
    message: str,
    analysis: Any,
    chain_status: EvidenceChainStatus,
    provider_health: dict[str, ProviderHealth],
    llm_client: Any,
    packet: dict[str, Any],
) -> tuple[bool, str, str]:
    if not chain_status.can_show_current_conclusion:
        return False, message, chain_status.reason
    xauusd = provider_health.get("xauusd")
    if xauusd and (xauusd.is_stale or xauusd.data_mode != "live_seen"):
        return False, message, "XAUUSD spot is not fresh live data."
    if "Evidence:" not in message or "Summary:" not in message or "Driver:" not in message:
        return False, message, "Alert message is not formatted."
    return _llm_review_alert(
        llm_client=llm_client,
        message=message,
        analysis=analysis,
        packet=packet,
    )


def _alert_preflight_status(allowed: bool, detail: str) -> str:
    if not allowed:
        return "blocked"
    if detail == "rewritten":
        return "rewritten"
    if detail in {"approved", "not_used", "unavailable"}:
        return detail
    return "approved"


def _build_packet(
    fixture: ScenarioFixture,
    *,
    provider_health: dict[str, ProviderHealth],
    attention_snapshot: Any,
    previous_state: Any,
    data_mode: str,
    analysis: Any | None = None,
    market_price_bar_count: int | None = None,
    related_asset_bar_count: int | None = None,
    news_row_count: int | None = None,
    calendar_row_count: int | None = None,
    selected_market_provider: str = "unavailable",
    provider_chain_status: list[dict[str, Any]] | None = None,
    fallback_reason: str = "",
) -> dict[str, Any]:
    evidence = build_evidence_gate_result(
        fixture,
        provider_health=provider_health,
        attention_snapshot=attention_snapshot,
    )
    dynamic_themes = [
        asdict(state)
        for state in attention_snapshot.states.values()
        if str(state.driver_id).startswith("theme:")
    ]
    requested_sensors = sorted(
        {
            sensor_id
            for theme in dynamic_themes
            for sensor_id in theme.get("requested_sensor_ids", [])
        }
    )
    chain_status = _build_evidence_chain_status(
        fixture=fixture,
        provider_health=provider_health,
        evidence_status=evidence.evidence_status,
        data_mode=data_mode,
        analysis=analysis,
        market_price_bar_count=market_price_bar_count,
        related_asset_bar_count=related_asset_bar_count,
        news_row_count=news_row_count,
        calendar_row_count=calendar_row_count,
    )
    return {
        "as_of_myt": fixture.as_of_myt,
        "data_mode": data_mode,
        "market_move": {
            "symbol": fixture.market.symbol,
            "from_price": fixture.market.from_price,
            "to_price": fixture.market.to_price,
            "move_percent": fixture.market.move_percent,
            "window_minutes": fixture.market.window_minutes,
            "source_type": provider_health["xauusd"].source_type if "xauusd" in provider_health else "",
            "provider_data_mode": provider_health["xauusd"].data_mode if "xauusd" in provider_health else "",
        },
        "provider_health": health_to_dict(provider_health),
        "selected_market_provider": selected_market_provider,
        "provider_chain_status": provider_chain_status or [],
        "fallback_reason": fallback_reason,
        "active_driver_states": attention_snapshot.active_driver_states,
        "dormant_driver_states": attention_snapshot.dormant_driver_states,
        "driver_attention_summary": attention_snapshot.driver_attention_summary,
        "dynamic_themes": dynamic_themes,
        "requested_sensors": requested_sensors,
        "evidence_chain_status": asdict(chain_status),
        "previous_state": asdict(previous_state) if previous_state is not None and hasattr(previous_state, "__dataclass_fields__") else previous_state,
        "calendar_events": [
            {"timestamp_myt": item.timestamp_myt, "title": item.title, "source": item.source}
            for item in fixture.calendar_events
        ],
        "news": [
            {"timestamp_myt": item.timestamp_myt, "title": item.title, "source": item.source}
            for item in fixture.news
        ],
        "allowed_candidate_drivers": evidence.allowed_candidate_drivers,
        "blocked_drivers": evidence.blocked_drivers,
        "cross_asset_confirmation": evidence.cross_asset_confirmation,
        "evidence_status": evidence.evidence_status,
    }


def _resolve_runtime_data_mode(
    *,
    backfill_required: bool,
    provider_health: dict[str, ProviderHealth],
) -> str:
    return provider_health.get("xauusd", ProviderHealth("", "", "", "", "unavailable", False, False)).data_mode or "unavailable"


def _semantic_market_event_payload(
    fixture: ScenarioFixture,
    analysis: Any,
    decision: Any,
    *,
    run_type: str,
    data_mode: str,
) -> dict[str, Any]:
    trigger = detect_market_trigger(fixture)
    move = float(fixture.market.move_percent_15m or fixture.market.move_percent or 0.0)
    cause_status = str(getattr(analysis, "cause_status", "") or "").lower()
    main_driver = str(getattr(analysis, "main_driver", "") or "unknown")
    has_news = bool(fixture.news)
    has_calendar = bool(fixture.calendar_events)
    if bool(getattr(decision, "previous_state_invalidated", False)):
        semantic_type = "reversal"
    elif "session_break" in trigger.trigger_types:
        semantic_type = "session"
    elif has_news and cause_status not in {"no_meaningful_change", "unconfirmed"}:
        semantic_type = "news"
    elif abs(move) >= 0.35:
        semantic_type = "breakout"
    elif abs(move) < 0.18 and not trigger.triggered:
        semantic_type = "range"
    else:
        semantic_type = "analysis"
    return {
        "semantic_type": semantic_type,
        "impact_percent": move,
        "direction": "up" if move > 0 else "down" if move < 0 else "flat",
        "duration_minutes": fixture.market.window_minutes,
        "trigger_types": trigger.trigger_types,
        "main_driver": main_driver,
        "driver_label": main_driver,
        "has_news": has_news,
        "has_calendar": has_calendar,
        "run_type": run_type,
        "data_mode": data_mode,
    }


def build_live_evidence_packet(
    config: MarketAgentConfig,
    anchor_time: datetime,
    news_headlines: list[dict[str, Any]] | None = None,
    previous_state=None,
    data_mode: str = "live_seen",
    provider_router: ProviderRouter | None = None,
) -> dict[str, Any]:
    context = _build_runtime_context(
        config,
        anchor_time=anchor_time,
        provider_router=provider_router,
        news_headlines=news_headlines,
    )
    fixture = context["fixture"]
    provider_health = context["provider_health"]
    evidence = build_evidence_gate_result(fixture, provider_health=provider_health)
    attention_snapshot = DriverAttentionManager().evaluate(
        fixture=fixture,
        provider_health=provider_health,
        evidence_status=evidence.evidence_status,
        data_mode=provider_health["xauusd"].data_mode if "xauusd" in provider_health else data_mode,
    )
    return _build_packet(
        fixture,
        provider_health=provider_health,
        attention_snapshot=attention_snapshot,
        previous_state=previous_state,
        data_mode=provider_health["xauusd"].data_mode if "xauusd" in provider_health else data_mode,
        market_price_bar_count=len(context.get("market_price_bars", [])),
        related_asset_bar_count=len(context.get("related_asset_bars", [])),
        news_row_count=len(context.get("news_rows", [])),
        calendar_row_count=len(context.get("calendar_rows", [])),
        selected_market_provider=context.get("selected_market_provider", "unavailable"),
        provider_chain_status=context.get("provider_chain_status", []),
        fallback_reason=context.get("fallback_reason", ""),
    )


def run_live_once(
    config: MarketAgentConfig,
    anchor_time: datetime | None = None,
    news_headlines: list[dict[str, Any]] | None = None,
    llm_client=None,
    previous_state=None,
    data_mode: str = "live_seen",
    provider_router: ProviderRouter | None = None,
) -> tuple[ScenarioFixture, Any]:
    anchor = anchor_time or datetime.now().astimezone()
    context = _build_runtime_context(
        config,
        anchor_time=anchor,
        provider_router=provider_router,
        news_headlines=news_headlines,
    )
    fixture = context["fixture"]
    provider_health = context["provider_health"]
    evidence = build_evidence_gate_result(fixture, provider_health=provider_health)
    attention_snapshot = DriverAttentionManager().evaluate(
        fixture=fixture,
        provider_health=provider_health,
        evidence_status=evidence.evidence_status,
        data_mode=provider_health["xauusd"].data_mode if "xauusd" in provider_health else data_mode,
    )
    result = analyze_fixture_with_optional_llm(
        fixture,
        llm_client=llm_client or LocalLLMClient(),
        previous_state=previous_state,
        provider_health=provider_health,
        attention_snapshot=attention_snapshot,
        data_mode=provider_health["xauusd"].data_mode if "xauusd" in provider_health else data_mode,
    )
    return fixture, result


def _detect_gap(
    *,
    previous_run_at: str | None,
    anchor: datetime,
    gap_minutes: int,
) -> tuple[bool, str]:
    if not previous_run_at:
        return False, "live"
    delta = anchor - datetime.fromisoformat(previous_run_at)
    if delta.total_seconds() / 60.0 > gap_minutes:
        return True, "recovery"
    return False, "live"


def run_monitored_live_once(
    config: MarketAgentConfig,
    anchor_time: datetime | None = None,
    state_path: Path | None = None,
    alerts_path: Path | None = None,
    cooldown_minutes: int | None = None,
    news_headlines: list[dict[str, Any]] | None = None,
    timeline_store_path: Path | None = None,
    llm_client=None,
    provider_router: ProviderRouter | None = None,
    telegram_sink=None,
    status_path: Path | None = None,
) -> dict[str, Any]:
    anchor = anchor_time or datetime.now().astimezone()
    resolved_status_path = _status_path_from_env(status_path)
    state_store = JsonStateStore(state_path or config.state_store_path)
    timeline_store = TimelineStore(timeline_store_path or config.timeline_store_path)
    sink = FileNotificationSink(alerts_path or config.alerts_output_path)
    previous_state = state_store.load()
    last_successful_run_at = timeline_store.get_last_successful_run_at()
    previous_attention_states = timeline_store.load_latest_driver_attention_states()
    backfill_required, detected_run_type = _detect_gap(
        previous_run_at=last_successful_run_at,
        anchor=anchor,
        gap_minutes=config.backfill_gap_minutes,
    )
    run_type = "live"
    active_llm_client = llm_client or LocalLLMClient()
    llm_enabled = bool(getattr(getattr(active_llm_client, "config", None), "enabled", False))
    _write_monitor_status(
        resolved_status_path,
        ok=True,
        available=True,
        running=True,
        phase="collecting_inputs",
        pid=os.getpid(),
        lastRunAt=anchor.isoformat(),
        lastError="",
        message="Getting XAUUSD price, related sensors, news, and calendar.",
        activity={
            "ctrader": {
                "status": "checking",
                "label": "Getting XAUUSD",
                "detail": "Requesting the latest cTrader price snapshot.",
            },
            "history": _history_activity(backfill_required),
            "context": {
                "status": "collecting",
                "label": "News and calendar",
                "detail": "Collecting market context in the background.",
            },
            "evidence": _evidence_activity(),
            "llm": _llm_activity(llm_enabled),
            "replay": _replay_activity(),
            "alerts": _alert_activity(),
        },
    )
    runtime_context = _build_runtime_context(
        config,
        anchor_time=anchor,
        provider_router=provider_router,
        news_headlines=news_headlines,
    )
    fixture = runtime_context["fixture"]
    provider_health = runtime_context["provider_health"]
    _write_monitor_status(
        resolved_status_path,
        running=True,
        phase="running_evidence_gate",
        lastRunAt=anchor.isoformat(),
        message="Checking whether collected inputs form a usable evidence chain.",
        activity=_activity_snapshot(
            provider_health=provider_health,
            news_count=len(runtime_context.get("news_rows", [])),
            calendar_count=len(runtime_context.get("calendar_rows", [])),
            backfill_required=backfill_required,
            llm_enabled=llm_enabled,
            news_rows=runtime_context.get("news_rows", []),
            calendar_rows=runtime_context.get("calendar_rows", []),
            market_price_bar_count=len(runtime_context.get("market_price_bars", [])),
            related_asset_bar_count=len(runtime_context.get("related_asset_bars", [])),
            market_price_bars=runtime_context.get("market_price_bars", []),
            related_asset_bars=runtime_context.get("related_asset_bars", []),
            llm_model=str(getattr(getattr(active_llm_client, "config", None), "model", "") or ""),
            history_window_start=last_successful_run_at,
            history_window_end=anchor.isoformat(),
        ),
    )
    data_mode = _resolve_runtime_data_mode(
        backfill_required=backfill_required,
        provider_health=provider_health,
    )
    evidence = build_evidence_gate_result(fixture, provider_health=provider_health)
    attention_snapshot = DriverAttentionManager().evaluate(
        fixture=fixture,
        provider_health=provider_health,
        evidence_status=evidence.evidence_status,
        previous_states=previous_attention_states,
        data_mode=data_mode,
    )
    _write_monitor_status(
        resolved_status_path,
        running=True,
        phase="llm_review" if llm_enabled else "rule_based_review",
        lastRunAt=anchor.isoformat(),
        message="Local AI batch review is running after the evidence gate."
        if llm_enabled
        else "Rule-based analysis is running after the evidence gate.",
        activity=_activity_snapshot(
            provider_health=provider_health,
            news_count=len(runtime_context.get("news_rows", [])),
            calendar_count=len(runtime_context.get("calendar_rows", [])),
            backfill_required=backfill_required,
            llm_enabled=llm_enabled,
            news_rows=runtime_context.get("news_rows", []),
            calendar_rows=runtime_context.get("calendar_rows", []),
            market_price_bar_count=len(runtime_context.get("market_price_bars", [])),
            related_asset_bar_count=len(runtime_context.get("related_asset_bars", [])),
            market_price_bars=runtime_context.get("market_price_bars", []),
            related_asset_bars=runtime_context.get("related_asset_bars", []),
            llm_model=str(getattr(getattr(active_llm_client, "config", None), "model", "") or ""),
            history_window_start=last_successful_run_at,
            history_window_end=anchor.isoformat(),
        ),
    )
    analysis = analyze_fixture_with_optional_llm(
        fixture,
        llm_client=active_llm_client,
        previous_state=previous_state,
        provider_health=provider_health,
        attention_snapshot=attention_snapshot,
        data_mode=data_mode,
    )
    pre_decision_chain_status = _build_evidence_chain_status(
        fixture=fixture,
        provider_health=provider_health,
        evidence_status=evidence.evidence_status,
        data_mode=data_mode,
        analysis=analysis,
        market_price_bar_count=len(runtime_context.get("market_price_bars", [])),
        related_asset_bar_count=len(runtime_context.get("related_asset_bars", [])),
        news_row_count=len(runtime_context.get("news_rows", [])),
        calendar_row_count=len(runtime_context.get("calendar_rows", [])),
    )
    analysis = _downgrade_analysis_for_incomplete_chain(analysis, pre_decision_chain_status)
    analysis = _suppress_unhelpful_alert(
        analysis,
        chain_status=pre_decision_chain_status,
        provider_health=provider_health,
    )
    analysis = _suppress_non_live_alert(
        analysis,
        run_type=run_type,
        data_mode=data_mode,
    )
    packet = _build_packet(
        fixture,
        provider_health=provider_health,
        attention_snapshot=attention_snapshot,
        previous_state=previous_state,
        data_mode=data_mode,
        analysis=analysis,
        market_price_bar_count=len(runtime_context.get("market_price_bars", [])),
        related_asset_bar_count=len(runtime_context.get("related_asset_bars", [])),
        news_row_count=len(runtime_context.get("news_rows", [])),
        calendar_row_count=len(runtime_context.get("calendar_rows", [])),
        selected_market_provider=runtime_context.get("selected_market_provider", "unavailable"),
        provider_chain_status=runtime_context.get("provider_chain_status", []),
        fallback_reason=runtime_context.get("fallback_reason", ""),
    )
    alert_message = ""
    alert_preflight = {
        "status": "not_applicable",
        "reason": "Analysis result does not require notification.",
    }
    if getattr(analysis, "should_notify", False):
        formatted_message = _format_alert_message(
            analysis=analysis,
            fixture=fixture,
            chain_status=pre_decision_chain_status,
            data_mode=data_mode,
        )
        allowed_to_send, reviewed_message, preflight_reason = _preflight_alert(
            message=formatted_message,
            analysis=analysis,
            chain_status=pre_decision_chain_status,
            provider_health=provider_health,
            llm_client=active_llm_client,
            packet=packet,
        )
        alert_preflight = {
            "status": _alert_preflight_status(allowed_to_send, preflight_reason),
            "reason": preflight_reason,
        }
        if allowed_to_send:
            alert_message = reviewed_message
        elif hasattr(analysis, "__dataclass_fields__"):
            analysis = replace(
                analysis,
                should_notify=False,
                notification_level="none",
                causal_chain=preflight_reason,
                summary=preflight_reason,
            )
            packet = {
                **packet,
                "alert_preflight": alert_preflight,
                "analysis": analysis.to_dict() if hasattr(analysis, "to_dict") else {},
            }
    packet = {**packet, "alert_preflight": alert_preflight}
    decision = decide_notification(
        previous_state=previous_state,
        analysis_result=analysis,
        now_iso=anchor.isoformat(),
        cooldown_minutes=cooldown_minutes or config.notification_cooldown_minutes,
    )
    _write_monitor_status(
        resolved_status_path,
        running=True,
        phase="alert_gate",
        lastRunAt=anchor.isoformat(),
        message="Checking whether this run should notify.",
        activity=_activity_snapshot(
            provider_health=provider_health,
            news_count=len(runtime_context.get("news_rows", [])),
            calendar_count=len(runtime_context.get("calendar_rows", [])),
            backfill_required=backfill_required,
            llm_enabled=llm_enabled,
            llm_status=getattr(analysis, "llm_status", None),
            decision=decision,
            news_rows=runtime_context.get("news_rows", []),
            calendar_rows=runtime_context.get("calendar_rows", []),
            market_price_bar_count=len(runtime_context.get("market_price_bars", [])),
            related_asset_bar_count=len(runtime_context.get("related_asset_bars", [])),
            market_price_bars=runtime_context.get("market_price_bars", []),
            related_asset_bars=runtime_context.get("related_asset_bars", []),
            chain_status=pre_decision_chain_status,
            analysis=analysis,
            llm_model=str(getattr(getattr(active_llm_client, "config", None), "model", "") or ""),
            alert_preflight=alert_preflight,
            history_window_start=last_successful_run_at,
            history_window_end=anchor.isoformat(),
        ),
    )
    telegram_result = {
        "sent": False,
        "status": "disabled",
        "error": "",
        "notification_level": decision.notification_level,
    }
    if decision.should_notify:
        alert_payload = {
            "time": anchor.isoformat(),
            "notification_level": decision.notification_level,
            "message": alert_message or analysis.user_message,
            "main_driver": analysis.main_driver,
            "bias": analysis.bias,
            "state_change_reason": decision.state_change_reason,
            "confidence_delta": decision.confidence_delta,
            "previous_state_invalidated": decision.previous_state_invalidated,
            "invalidation_triggered_by": decision.invalidation_triggered_by,
            "alert_preflight": alert_preflight,
        }
        sink.emit(alert_payload)
        if config.telegram_enabled:
            telegram = telegram_sink or TelegramNotificationSink(
                bot_token=config.telegram_bot_token,
                chat_id=config.telegram_chat_id,
                timeout_seconds=config.telegram_timeout_seconds,
                enabled_levels=set(config.telegram_levels),
            )
            telegram_payload = {
                **alert_payload,
                "selected_market_provider": runtime_context.get("selected_market_provider", "unavailable"),
                "data_mode": data_mode,
            }
            if hasattr(telegram, "send"):
                telegram_result = telegram.send(telegram_payload)
            else:
                try:
                    sent = telegram.emit(telegram_payload)
                    telegram_result = {
                        "sent": bool(sent),
                        "status": "sent" if sent else "failed",
                        "error": "",
                        "notification_level": decision.notification_level,
                    }
                except Exception as exc:
                    telegram_result = {
                        "sent": False,
                        "status": "failed",
                        "error": str(exc),
                        "notification_level": decision.notification_level,
                    }
    state_store.save(decision.next_state)
    monitor_run_id = timeline_store.record_monitor_run(
        run_started_at=anchor.isoformat(),
        run_type=run_type,
        data_mode=data_mode,
        backfill_required=backfill_required,
        last_successful_run_at=last_successful_run_at,
        no_news_found=bool(analysis.no_news_found),
        alert_suppressed_reason="" if decision.should_notify else decision.reason,
    )
    timeline_store.record_provider_health(monitor_run_id, packet["provider_health"])
    timeline_store.record_market_price_bars(monitor_run_id, runtime_context["market_price_bars"])
    timeline_store.record_related_asset_bars(monitor_run_id, runtime_context["related_asset_bars"])
    timeline_store.record_news_items(monitor_run_id, runtime_context["news_rows"])
    timeline_store.record_calendar_events(monitor_run_id, runtime_context["calendar_rows"])
    timeline_store.record_driver_attention_states(
        monitor_run_id,
        {key: asdict(value) for key, value in attention_snapshot.states.items()},
    )
    timeline_store.record_evidence_packet(monitor_run_id, packet)
    timeline_store.record_analysis_result(
        monitor_run_id,
        analysis.to_dict(),
        rejected_driver=getattr(analysis, "rejected_driver", None),
        rejection_reason=getattr(analysis, "rejection_reason", None),
    )
    timeline_store.record_alert(
        monitor_run_id,
        {
            "should_notify": decision.should_notify,
            "notification_level": decision.notification_level,
            "reason": decision.reason,
            "telegram": telegram_result,
            "alert_preflight": alert_preflight,
        },
    )
    timeline_store.record_state_transition(
        monitor_run_id,
        {
            "is_new_state": decision.is_new_state,
            "is_continuation": decision.is_continuation,
            "previous_state_invalidated": decision.previous_state_invalidated,
            "state_change_reason": decision.state_change_reason,
            "confidence_changed": decision.confidence_changed,
            "confidence_delta": decision.confidence_delta,
            "invalidation_triggered_by": decision.invalidation_triggered_by,
            "next_state": asdict(decision.next_state),
        },
    )
    timeline_store.record_timeline_event(
        monitor_run_id,
        event_time=anchor.isoformat(),
        event_type="analysis",
        label=analysis.main_driver,
        payload={
            **_semantic_market_event_payload(
                fixture,
                analysis,
                decision,
                run_type=run_type,
                data_mode=data_mode,
            ),
            "analysis": analysis.to_dict(),
        },
    )
    storage_counts = {
        "marketPriceBars": len(runtime_context.get("market_price_bars", [])),
        "relatedAssetBars": len(runtime_context.get("related_asset_bars", [])),
        "newsItems": len(runtime_context.get("news_rows", [])),
        "calendarEvents": len(runtime_context.get("calendar_rows", [])),
        "driverAttentionStates": len(attention_snapshot.states),
        "timelineEvents": 1,
        "alerts": 1,
    }
    stored_market_price_bars = list(runtime_context.get("market_price_bars", []))
    stored_related_asset_bars = list(runtime_context.get("related_asset_bars", []))
    if backfill_required:
        _write_monitor_status(
            resolved_status_path,
            running=True,
            phase="syncing_history",
            lastRunAt=anchor.isoformat(),
            message="Current live check is stored. Backfilling missed cTrader history for replay.",
            activity=_activity_snapshot(
                provider_health=provider_health,
                news_count=len(runtime_context.get("news_rows", [])),
                calendar_count=len(runtime_context.get("calendar_rows", [])),
                backfill_required=backfill_required,
                llm_enabled=llm_enabled,
                llm_status=getattr(analysis, "llm_status", None),
                decision=decision,
                telegram_result=telegram_result,
                news_rows=runtime_context.get("news_rows", []),
                calendar_rows=runtime_context.get("calendar_rows", []),
                market_price_bar_count=len(runtime_context.get("market_price_bars", [])),
                related_asset_bar_count=len(runtime_context.get("related_asset_bars", [])),
                market_price_bars=runtime_context.get("market_price_bars", []),
                related_asset_bars=runtime_context.get("related_asset_bars", []),
                chain_status=pre_decision_chain_status,
                analysis=analysis,
                llm_model=str(getattr(getattr(active_llm_client, "config", None), "model", "") or ""),
                alert_preflight=alert_preflight,
                history_window_start=last_successful_run_at,
                history_window_end=anchor.isoformat(),
            ),
        )
        recovery_context = _run_recovery_backfill(
            config,
            previous_run_at=last_successful_run_at or anchor.isoformat(),
            anchor_time=anchor,
            provider_router=provider_router,
            news_headlines=news_headlines,
        )
        timeline_store.record_market_price_bars(monitor_run_id, recovery_context["market_price_bars"])
        timeline_store.record_related_asset_bars(monitor_run_id, recovery_context["related_asset_bars"])
        timeline_store.record_news_items(monitor_run_id, recovery_context["news_rows"])
        timeline_store.record_calendar_events(monitor_run_id, recovery_context["calendar_rows"])
        storage_counts["marketPriceBars"] += len(recovery_context.get("market_price_bars", []))
        storage_counts["relatedAssetBars"] += len(recovery_context.get("related_asset_bars", []))
        storage_counts["newsItems"] += len(recovery_context.get("news_rows", []))
        storage_counts["calendarEvents"] += len(recovery_context.get("calendar_rows", []))
        stored_market_price_bars.extend(recovery_context.get("market_price_bars", []))
        stored_related_asset_bars.extend(recovery_context.get("related_asset_bars", []))
        for item in recovery_context.get("recovery_timeline_events", []):
            timeline_store.record_timeline_event(
                monitor_run_id,
                event_time=item["event_time"],
                event_type=item["event_type"],
                label=item["label"],
                payload=item["payload"],
            )
            storage_counts["timelineEvents"] += 1
        timeline_store.record_timeline_event(
            monitor_run_id,
            event_time=anchor.isoformat(),
            event_type="recovery_summary",
            label="backfill",
            payload={
                "summary": recovery_context["recovery_summary"],
                "data_mode": "backfilled",
                "current_run_type": run_type,
                "detected_gap_type": detected_run_type,
            },
        )
        storage_counts["timelineEvents"] += 1
    final_activity = _activity_snapshot(
        provider_health=provider_health,
        news_count=len(runtime_context.get("news_rows", [])),
        calendar_count=len(runtime_context.get("calendar_rows", [])),
        backfill_required=backfill_required,
        llm_enabled=llm_enabled,
        llm_status=getattr(analysis, "llm_status", None),
        decision=decision,
        telegram_result=telegram_result,
        history_completed=backfill_required,
        news_rows=runtime_context.get("news_rows", []),
        calendar_rows=runtime_context.get("calendar_rows", []),
        market_price_bar_count=storage_counts["marketPriceBars"],
        related_asset_bar_count=storage_counts["relatedAssetBars"],
        market_price_bars=stored_market_price_bars,
        related_asset_bars=stored_related_asset_bars,
        chain_status=pre_decision_chain_status,
        analysis=analysis,
        llm_model=str(getattr(getattr(active_llm_client, "config", None), "model", "") or ""),
        alert_preflight=alert_preflight,
        monitor_run_id=monitor_run_id,
        timeline_store_path=timeline_store.path,
        storage_counts=storage_counts,
        storage_summary=timeline_store.get_storage_summary(),
        history_window_start=last_successful_run_at,
        history_window_end=anchor.isoformat(),
    )
    final_status_updates = {
        "ok": True,
        "available": True,
        "running": False,
        "phase": "stopped",
        "pid": os.getpid(),
        "lastRunAt": anchor.isoformat(),
        "lastSuccessAt": anchor.isoformat(),
        "nextRunAt": None,
        "lastError": "",
        "message": "Monitor run completed.",
        "activity": final_activity,
        "latestMonitorRunId": monitor_run_id,
    }
    if backfill_required:
        final_status_updates["lastRecoveryAt"] = anchor.isoformat()
    _write_monitor_status(resolved_status_path, **final_status_updates)
    return {
        "monitor_run_id": monitor_run_id,
        "run_type": run_type,
        "backfill_required": backfill_required,
        "last_successful_run_at": last_successful_run_at,
        "evidence_packet": packet,
        "analysis": analysis.to_dict(),
        "notification": {
            "should_notify": decision.should_notify,
            "notification_level": decision.notification_level,
            "reason": decision.reason,
            "telegram": telegram_result,
            "alert_preflight": alert_preflight,
        },
        "state_transition": {
            "is_new_state": decision.is_new_state,
            "is_continuation": decision.is_continuation,
            "previous_state_invalidated": decision.previous_state_invalidated,
            "state_change_reason": decision.state_change_reason,
            "confidence_changed": decision.confidence_changed,
            "confidence_delta": decision.confidence_delta,
            "invalidation_triggered_by": decision.invalidation_triggered_by,
            "next_state": asdict(decision.next_state),
        },
    }


def run_monitor_loop(
    config: MarketAgentConfig,
    interval_seconds: int,
    max_iterations: int | None = None,
    anchor_times: list[datetime] | None = None,
    state_path: Path | None = None,
    alerts_path: Path | None = None,
    cooldown_minutes: int | None = None,
    timeline_store_path: Path | None = None,
    provider_router: ProviderRouter | None = None,
    status_path: Path | None = None,
) -> list[dict[str, Any]]:
    outcomes: list[dict[str, Any]] = []
    resolved_status_path = _status_path_from_env(status_path)
    with MonitorLock(config.monitor_lock_path) as lock:
        if lock is None:
            _write_monitor_status(
                resolved_status_path,
                ok=False,
                available=True,
                running=True,
                phase="already_running",
                message="Monitor loop is already running.",
                lastError="",
            )
            return [
                {
                    "ok": False,
                    "phase": "already_running",
                    "message": "Monitor loop is already running.",
                }
            ]
        _write_monitor_status(
            resolved_status_path,
            ok=True,
            available=True,
            running=True,
            phase="starting",
            pid=os.getpid(),
            intervalSeconds=interval_seconds,
            lastError="",
            message="Monitor loop is starting.",
        )
        iteration = 0
        while max_iterations is None or iteration < max_iterations:
            anchor = None
            if anchor_times is not None:
                if iteration >= len(anchor_times):
                    break
                anchor = anchor_times[iteration]
            outcomes.append(
                run_monitored_live_once(
                    config=config,
                    anchor_time=anchor,
                    state_path=state_path,
                    alerts_path=alerts_path,
                    cooldown_minutes=cooldown_minutes,
                    timeline_store_path=timeline_store_path,
                    provider_router=provider_router,
                    status_path=resolved_status_path,
                )
            )
            iteration += 1
            if max_iterations is not None and iteration >= max_iterations:
                break
            if interval_seconds > 0:
                next_run = datetime.now().astimezone() + timedelta(seconds=interval_seconds)
                _write_monitor_status(
                    resolved_status_path,
                    running=True,
                    phase="idle_between_runs",
                    nextRunAt=next_run.isoformat(),
                    message="Waiting for the next monitor pass.",
                )
                time.sleep(interval_seconds)
    last_outcome = outcomes[-1] if outcomes else {}
    last_run_at = last_outcome.get("evidence_packet", {}).get("as_of") or last_outcome.get("last_successful_run_at")
    final_updates = {
        "ok": True,
        "available": True,
        "running": False,
        "phase": "stopped",
        "pid": None,
        "nextRunAt": None,
        "lastError": "",
        "message": "Monitor loop is stopped.",
    }
    if last_run_at:
        final_updates["lastRunAt"] = last_run_at
        final_updates["lastSuccessAt"] = last_run_at
    _write_monitor_status(resolved_status_path, **final_updates)
    return outcomes
