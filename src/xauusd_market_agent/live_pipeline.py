from __future__ import annotations

from dataclasses import asdict, replace
from datetime import datetime, timedelta
import errno
import hashlib
import json
import os
import sys
import re
import time
from pathlib import Path
from typing import Any

from .backfill import BackfillManager
from .config import MarketAgentConfig, REPO_ROOT
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


def _monitor_owner_pid_from_env() -> int | None:
    raw = os.getenv("MARKET_AGENT_MONITOR_OWNER_PID", "").strip()
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


_MONITOR_SIGNATURE_FILES = (
    "src/xauusd_market_agent/cli.py",
    "src/xauusd_market_agent/config.py",
    "src/xauusd_market_agent/driver_attention.py",
    "src/xauusd_market_agent/evidence.py",
    "src/xauusd_market_agent/live_pipeline.py",
    "src/xauusd_market_agent/llm_bridge.py",
    "src/xauusd_market_agent/pipeline.py",
    "src/xauusd_market_agent/validator.py",
)


def _monitor_code_signature() -> str:
    digest = hashlib.sha1()
    for relative_path in _MONITOR_SIGNATURE_FILES:
        path = REPO_ROOT / relative_path
        digest.update(relative_path.encode("utf-8"))
        digest.update(b"\0")
        try:
            digest.update(path.read_bytes())
        except OSError:
            digest.update(b"missing")
        digest.update(b"\0")
    return digest.hexdigest()


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
    phase = str(updates.get("phase") or current.get("phase") or "").strip()
    if updates.get("running") is True and phase not in {"idle_between_runs", "already_running"}:
        updates.setdefault("nextRunAt", None)
    payload = {
        "ok": True,
        "available": True,
        "running": False,
        "phase": "stopped",
        "pid": os.getpid(),
        "monitorOwnerPid": _monitor_owner_pid_from_env(),
        "agentCodeSignature": _monitor_code_signature(),
        "lastError": "",
        "message": "Monitor loop is stopped.",
        **current,
        **updates,
        "updatedAt": datetime.now().astimezone().isoformat(),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(f"{path.suffix}.{os.getpid()}.{time.time_ns()}.tmp")
    temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    for attempt in range(3):
        try:
            temp_path.replace(path)
            return
        except PermissionError:
            if attempt == 2:
                try:
                    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
                finally:
                    try:
                        temp_path.unlink(missing_ok=True)
                    except OSError:
                        pass
                return
            time.sleep(0.05 * (attempt + 1))


def _should_store_alert_audit(analysis: Any, decision: Any) -> bool:
    if bool(getattr(decision, "should_notify", False)):
        return True
    if bool(getattr(analysis, "should_notify", False)):
        return True
    reason = str(getattr(decision, "reason", "") or "").strip().casefold()
    return bool(reason)


def _should_store_analysis_timeline_event(
    *,
    chain_status: EvidenceChainStatus,
    analysis: Any,
    decision: Any,
    backfill_required: bool,
) -> bool:
    if bool(chain_status.can_show_current_conclusion):
        return True
    if bool(backfill_required):
        return True
    if bool(getattr(decision, "should_notify", False)):
        return True
    if bool(getattr(analysis, "should_notify", False)):
        return True
    return False


def _should_store_context_timeline_event(
    *,
    chain_status: EvidenceChainStatus,
    news_row_count: int,
    calendar_row_count: int,
) -> bool:
    if chain_status.can_show_current_conclusion:
        return False
    return news_row_count > 0 or calendar_row_count > 0


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


def _activity_job(
    title: str,
    status: str,
    detail: str,
    *,
    input: str = "",
    output: str = "",
    timestamp: str | None = None,
    meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "title": title,
        "status": status,
        "detail": detail,
    }
    if input:
        payload["input"] = input
    if output:
        payload["output"] = output
    if timestamp:
        payload["timestamp"] = timestamp
    if meta:
        payload["meta"] = meta
    return payload


def _display_range(start: str | None, end: str | None) -> str:
    if start and end:
        return f"{start} -> {end}"
    if start:
        return f"from {start}"
    if end:
        return f"to {end}"
    return ""


def _sample_titles(rows: list[dict[str, Any]], time_key: str, limit: int = 3) -> list[str]:
    ordered = sorted(rows, key=lambda row: str(row.get(time_key, "")), reverse=True)
    return [str(row.get("title", "")).strip() for row in ordered[:limit] if str(row.get("title", "")).strip()]


def _count_by_symbol(rows: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for row in rows:
        symbol = str(row.get("symbol", "") or "").upper()
        if not symbol:
            continue
        counts[symbol] = counts.get(symbol, 0) + 1
    return counts


def _included_news_rows(rows: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    return [row for row in rows or [] if row.get("included", True)]


def _included_news_count(rows: list[dict[str, Any]] | None) -> int:
    return len(_included_news_rows(rows))


def _health_job_status(health: ProviderHealth | None) -> str:
    if health is None:
        return "waiting"
    if not health.is_available:
        return "unavailable"
    if health.is_stale:
        return "stale"
    return "ready"


def _provider_chain_jobs(chain_status: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    jobs: list[dict[str, Any]] = []
    provider_labels = {
        "ctrader_spot": "cTrader spot freshness",
        "yahoo_gc_f_proxy": "GC=F proxy check",
        "csv_fallback": "CSV import check",
    }
    for item in chain_status or []:
        provider = str(item.get("provider", "provider"))
        source = str(item.get("source", "") or provider)
        data_mode = str(item.get("data_mode", "") or "")
        status = "ready" if item.get("is_available") and not item.get("is_stale") else "stale" if item.get("is_stale") else "unavailable"
        reason = str(item.get("error", "") or item.get("stale_reason", "") or data_mode or "checked")
        jobs.append(
            _activity_job(
                provider_labels.get(provider, f"{provider.replace('_', ' ').title()} check"),
                status,
                reason,
                input="XAUUSD market provider chain",
                output=f"{source} / {data_mode}".strip(" /"),
                timestamp=str(item.get("data_timestamp", "") or "") or None,
            )
        )
    return jobs


def _format_price(value: object) -> str:
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return ""
    return f"{number:,.2f}"


def _ctrader_activity(
    health: ProviderHealth | None,
    *,
    selected_market_provider: str = "",
    provider_chain_status: list[dict[str, Any]] | None = None,
    fallback_reason: str = "",
) -> dict[str, Any]:
    provider_jobs = _provider_chain_jobs(provider_chain_status)
    if health is None:
        return {
            "status": "waiting",
            "label": "Waiting for XAUUSD",
            "detail": "cTrader has not returned a price snapshot yet.",
            "symbols": ["XAUUSD"],
            "selectedProvider": selected_market_provider,
            "providerChain": provider_chain_status or [],
            "fallbackReason": fallback_reason,
            "jobs": [
                _activity_job(
                    "Live quote request",
                    "waiting",
                    "Waiting for the cTrader adapter to return the latest XAUUSD quote.",
                    input="cTrader credentials + XAUUSD symbol",
                    output="No quote snapshot yet",
                ),
                *provider_jobs,
            ],
            "handoff": "Fresh live XAUUSD price and short history feed the evidence gate.",
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
        "selectedProvider": selected_market_provider,
        "providerChain": provider_chain_status or [],
        "fallbackReason": fallback_reason,
    }
    if health.is_available and not health.is_stale and health.data_mode == "live_seen":
        return {
            **base,
            "status": "live",
            "label": "XAUUSD live",
            "detail": f"Last price {price} from cTrader." if price else "Live XAUUSD quote is active.",
            "jobs": [
                _activity_job(
                    "Live quote request",
                    "ready",
                    f"cTrader returned a fresh XAUUSD spot quote{f' at {price}' if price else ''}.",
                    input="cTrader spot feed",
                    output="Fresh XAUUSD snapshot for evidence",
                    timestamp=health.data_timestamp,
                ),
                *provider_jobs,
            ],
            "handoff": "Live XAUUSD quote is usable by price trigger, evidence gate, replay, and alert preflight.",
        }
    if health.is_available and health.current_value is not None:
        market_closed_context = _is_market_closed_xauusd_context(health)
        status = "market_closed" if market_closed_context else "stale"
        label = "Market closed" if market_closed_context else "cTrader not refreshing"
        detail = (
            (
                f"Last XAUUSD price {price} is fixed until the market reopens; "
                "news and calendar still update."
            )
            if price
            else "Last XAUUSD price is fixed until the market reopens; news and calendar still update."
        ) if market_closed_context else (
            (
                f"Last XAUUSD price {price} is stale; cTrader has not produced a fresh live snapshot."
            )
            if price
            else "Last XAUUSD price is stale; cTrader has not produced a fresh live snapshot."
        )
        return {
            **base,
            "status": status,
            "label": label,
            "detail": detail,
            "jobs": [
                _activity_job(
                    "Last quote snapshot",
                    "stale",
                    health.stale_reason
                    or (
                        "The latest cTrader quote is treated as market-closed context."
                        if market_closed_context
                        else "The latest cTrader quote is stale and cannot drive a current conclusion."
                    ),
                    input="Last cTrader XAUUSD quote",
                    output="Context-only XAUUSD price; no live alert",
                    timestamp=health.data_timestamp,
                ),
                *provider_jobs,
            ],
            "handoff": "Market context can still update, but current driver conclusions and Telegram alerts require fresh live XAUUSD.",
        }
    return {
        **base,
        "status": "unavailable",
        "label": "No XAUUSD price",
        "detail": health.error or health.stale_reason or "cTrader has not returned a usable XAUUSD price.",
        "jobs": [
            _activity_job(
                "Live quote request",
                "unavailable",
                health.error or health.stale_reason or "No usable XAUUSD quote was returned.",
                input="cTrader spot feed",
                output="Price input missing",
                timestamp=health.data_timestamp,
            ),
            *provider_jobs,
        ],
        "handoff": "Evidence gate remains blocked until a usable XAUUSD price/history pair exists.",
    }


def _context_activity(
    news_count: int,
    calendar_count: int,
    *,
    news_rows: list[dict[str, Any]] | None = None,
    calendar_rows: list[dict[str, Any]] | None = None,
    provider_health: dict[str, ProviderHealth] | None = None,
) -> dict[str, Any]:
    news_rows = news_rows or []
    calendar_rows = calendar_rows or []
    visible_news_rows = _included_news_rows(news_rows)
    provider_health = provider_health or {}
    news_health = provider_health.get("news")
    calendar_health = provider_health.get("calendar")
    latest_news_at = _latest_value(visible_news_rows, "published_at")
    latest_calendar_at = _latest_value(calendar_rows, "scheduled_at")
    detail = f"{news_count} headlines and {calendar_count} calendar events collected."
    return {
        "status": "active" if news_count or calendar_count else "collecting",
        "label": "News and calendar",
        "detail": detail,
        "newsCount": news_count,
        "calendarCount": calendar_count,
        "sources": _unique_strings([*_compact_sources(visible_news_rows), *_compact_sources(calendar_rows)]),
        "latestNewsAt": latest_news_at,
        "latestCalendarAt": latest_calendar_at,
        "newsSamples": _sample_titles(visible_news_rows, "published_at"),
        "calendarSamples": _sample_titles(calendar_rows, "scheduled_at"),
        "jobs": [
            _activity_job(
                "News collector",
                _health_job_status(news_health) if news_rows else "collecting",
                f"{news_count} relevant headline(s) loaded for the current market window.",
                input="App-managed RSS/news context",
                output=f"{news_count} headline(s), {len(_compact_sources(visible_news_rows))} source(s)",
                timestamp=latest_news_at,
                meta={
                    "sources": _compact_sources(visible_news_rows),
                    "samples": _sample_titles(visible_news_rows, "published_at"),
                    "health": _provider_health_payload(news_health),
                },
            ),
            _activity_job(
                "Calendar collector",
                _health_job_status(calendar_health) if calendar_rows else "collecting",
                f"{calendar_count} calendar event(s) loaded around the analysis window.",
                input="App-managed economic calendar",
                output=f"{calendar_count} calendar event(s)",
                timestamp=latest_calendar_at,
                meta={
                    "sources": _compact_sources(calendar_rows),
                    "samples": _sample_titles(calendar_rows, "scheduled_at"),
                    "health": _provider_health_payload(calendar_health),
                },
            ),
            _activity_job(
                "Context fixture",
                "ready" if visible_news_rows or calendar_rows else "waiting",
                "News and calendar rows are normalized into the scenario fixture before evidence and AI review.",
                input="News rows + calendar rows",
                output="ScenarioFixture.news and ScenarioFixture.calendar_events",
            ),
        ],
        "handoff": "Market context feeds DriverAttention, the evidence packet, Local AI prompt, replay, and alert formatting.",
    }


def _history_activity(
    backfill_required: bool,
    *,
    completed: bool = False,
    window_start: str | None = None,
    window_end: str | None = None,
    stored_rows: int | None = None,
    symbols: list[str] | None = None,
    symbol_rows: dict[str, int] | None = None,
) -> dict[str, Any]:
    symbol_rows = symbol_rows or {}
    xauusd_rows = int(symbol_rows.get("XAUUSD", 0) or 0)
    sensor_rows = max(0, int(stored_rows or 0) - xauusd_rows)
    history_output = (
        f"{xauusd_rows} XAUUSD row(s), {sensor_rows} sensor row(s)"
        if stored_rows is not None
        else "No stored rows yet"
    )
    base: dict[str, Any] = {
        "symbols": symbols or ["XAUUSD"],
        "windowStart": window_start,
        "windowEnd": window_end,
        "xauusdRows": xauusd_rows,
        "sensorRows": sensor_rows,
    }
    if stored_rows is not None:
        base["storedRows"] = stored_rows
    window = _display_range(window_start, window_end) or "current monitor window"
    detector_job = _activity_job(
        "Gap detector",
        "syncing" if backfill_required and not completed else "ready",
        "Checks the last successful monitor run and decides whether recovery backfill is needed.",
        input="last_successful_run_at + current run time",
        output="Backfill required" if backfill_required else "No backfill gap",
    )
    fetch_job = _activity_job(
        "History fetch",
        "synced" if completed else "syncing" if backfill_required else "idle",
        "Fetches missing cTrader history for replay and evidence without blocking the live quote.",
        input=window,
        output=history_output,
    )
    persist_job = _activity_job(
        "History persistence",
        "stored" if completed or stored_rows else "waiting",
        "Writes market and related-asset bars to TimelineStore for day/month replay.",
        input="Normalized price bars",
        output="market_price_bars + related_asset_bars",
    )
    if backfill_required and completed:
        return {
            **base,
            "status": "synced",
            "label": "History synced",
            "detail": "Missing cTrader history was stored for replay and evidence.",
            "progress": 100,
            "jobs": [detector_job, fetch_job, persist_job],
            "handoff": "Backfilled rows are replay/evidence context only; they are not current Telegram alerts.",
        }
    if backfill_required:
        return {
            **base,
            "status": "syncing",
            "label": "History sync",
            "detail": "Backfill runs in the background after the current live check.",
            "jobs": [detector_job, fetch_job, persist_job],
            "handoff": "Live quote stays first; recovery rows are stored after the current run is safe.",
        }
    return {
        **base,
        "status": "idle",
        "label": "History current",
        "detail": (
            "No backfill gap detected, but current XAUUSD recent history still needs another fresh bar."
            if xauusd_rows < 2
            else "No backfill gap detected for this run."
        ),
        "jobs": [detector_job, fetch_job, persist_job],
        "handoff": "Recent XAUUSD history feeds move detection and evidence gate readiness.",
    }


def _llm_activity(
    llm_enabled: bool,
    llm_status: str | None = None,
    *,
    model: str | None = None,
    analysis: Any | None = None,
    alert_preflight: dict[str, Any] | None = None,
    telemetry: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    base: dict[str, Any] = {}
    telemetry = telemetry or []
    if model:
        base["model"] = model
    if telemetry:
        base["telemetry"] = telemetry
        total_elapsed = sum(float(item.get("elapsed_ms", 0) or 0) for item in telemetry)
        output_tokens = sum(int(item.get("output_tokens", 0) or 0) for item in telemetry)
        best_tps = max((float(item.get("tokens_per_second", 0) or 0) for item in telemetry), default=0.0)
        base["performance"] = {
            "calls": len(telemetry),
            "elapsedMs": round(total_elapsed, 2),
            "outputTokens": output_tokens,
            "bestTokensPerSecond": round(best_tps, 2),
        }
    if analysis is not None:
        base["result"] = str(getattr(analysis, "main_driver", "unknown") or "unknown")
        base["causeStatus"] = str(getattr(analysis, "cause_status", "") or "")
        base["analysisEngine"] = str(getattr(analysis, "analysis_engine", "") or "")
    main_driver = str(getattr(analysis, "main_driver", "unknown") or "unknown") if analysis is not None else "pending"
    cause_status = str(getattr(analysis, "cause_status", "") or "") if analysis is not None else ""
    alert_review_status = str((alert_preflight or {}).get("status") or "pending")
    jobs = [
        _activity_job(
            "Rule baseline",
            "ready" if analysis is not None else "queued",
            "Deterministic analysis runs first and remains the fallback if Local AI is off or invalid.",
            input="ScenarioFixture + evidence gate + DriverAttention",
            output=f"{main_driver}{f' / {cause_status}' if cause_status else ''}",
        ),
        _activity_job(
            "Cause review",
            "validated" if llm_status == "validated" else "skipped" if not llm_enabled else "unavailable" if llm_status else "queued",
            "Local AI reviews the compact evidence packet only after allowed/blocked drivers are known.",
            input="Evidence packet JSON",
            output="Validated AnalysisResult" if llm_status == "validated" else "Rule fallback remains source of truth",
            meta={"telemetry": [item for item in telemetry if item.get("task") == "cause_review"]},
        ),
        _activity_job(
            "Validator and repair",
            "ready" if llm_status == "validated" else "skipped" if not llm_enabled else "unavailable" if llm_status else "queued",
            "LLM output must pass deterministic validation; invalid output is repaired once or rejected.",
            input="LLM JSON + allowed_candidate_drivers + blocked_drivers",
            output=str(llm_status or ("not_used" if not llm_enabled else "pending")),
        ),
        _activity_job(
            "Alert review hook",
            alert_review_status if alert_review_status != "not_applicable" else "skipped",
            "If an alert is candidate-worthy, Local AI can approve, rewrite, or block the final message without adding facts.",
            input="Formatted alert + evidence packet",
            output=str((alert_preflight or {}).get("reason") or alert_review_status),
            meta={"telemetry": [item for item in telemetry if item.get("task") == "alert_review"]},
        ),
        _activity_job(
            "Display summary batch",
            "ready" if any(item.get("task") == "display_summary" and item.get("status") == "ok" for item in telemetry) else "skipped" if not llm_enabled else "waiting",
            "Local AI can summarize selected news, calendar, and asset rows for compact dashboard display.",
            input="Bounded news/calendar/assets batch",
            output="summary_title + summary fields",
            meta={"telemetry": [item for item in telemetry if item.get("task") == "display_summary"]},
        ),
    ]
    base["jobs"] = jobs
    base["touchpoints"] = [
        "Rule baseline",
        "Optional Local AI cause review",
        "Deterministic validator / repair",
        "Optional Local AI alert review",
    ]
    base["handoff"] = "AI never bypasses the evidence gate; validated output feeds Dashboard, Evidence, Replay, and alert preflight."
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
    analysis: Any | None = None,
) -> dict[str, Any]:
    should_notify = bool(getattr(decision, "should_notify", False)) if decision is not None else False
    preflight_status = str((alert_preflight or {}).get("status") or "pending")
    preflight_reason = str((alert_preflight or {}).get("reason") or "")
    telegram_status = str((telegram_result or {}).get("status") or "not_tested")
    base = {
        "preflightStatus": preflight_status,
        "preflightReason": preflight_reason,
        "telegramStatus": telegram_status,
        "notificationLevel": getattr(decision, "notification_level", None) if decision is not None else None,
        "jobs": [
            _activity_job(
                "Format alert message",
                "ready" if getattr(analysis, "should_notify", False) else "skipped",
                "Builds the final XAUUSD alert format with status, move, driver, evidence, summary, and data mode.",
                input="AnalysisResult + evidence chain",
                output="Formatted candidate message" if getattr(analysis, "should_notify", False) else "No candidate alert",
            ),
            _activity_job(
                "Preflight evidence check",
                preflight_status if preflight_status != "not_applicable" else "skipped",
                preflight_reason or "Checks freshness, market-closed state, message format, and supporting evidence.",
                input="Formatted message + provider health",
                output=preflight_status,
            ),
            _activity_job(
                "Notification policy",
                "ready" if should_notify else "suppressed" if decision is not None and getattr(decision, "reason", "") else "idle",
                getattr(decision, "reason", "") if decision is not None else "Waiting for analysis result.",
                input="Previous state + current analysis + cooldown policy",
                output="Send alert" if should_notify else "Dashboard/replay only",
            ),
            _activity_job(
                "Telegram delivery",
                "sent" if bool((telegram_result or {}).get("sent")) else telegram_status,
                str((telegram_result or {}).get("error") or "Telegram is used only after all gates pass."),
                input="Approved alert payload",
                output=telegram_status,
            ),
        ],
        "handoff": "Alerts are persisted for replay whether sent or suppressed; Telegram receives only approved current-live messages.",
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


def _evidence_activity(
    chain_status: EvidenceChainStatus | None = None,
    *,
    evidence_status: dict[str, str] | None = None,
    allowed_candidate_drivers: list[str] | None = None,
    blocked_drivers: dict[str, str] | None = None,
    attention_snapshot: Any | None = None,
) -> dict[str, Any]:
    if chain_status is None:
        return {
            "status": "pending",
            "label": "Evidence gate",
            "detail": "Waiting for provider health and market context.",
            "jobs": [
                _activity_job(
                    "Input readiness",
                    "pending",
                    "Waiting for live XAUUSD, recent history, related sensors, news, and calendar.",
                    input="Provider health + context rows",
                    output="EvidenceChainStatus",
                )
            ],
            "handoff": "Only usable evidence can become a current conclusion.",
        }
    label = {
        "ready": "Evidence gate ready",
        "partial": "Evidence partial",
        "context_only": "Context only",
    }.get(chain_status.status, "Evidence gate")
    evidence_status = evidence_status or {}
    allowed_candidate_drivers = allowed_candidate_drivers or []
    blocked_drivers = blocked_drivers or {}
    summary = getattr(attention_snapshot, "driver_attention_summary", {}) or {}
    active_count = int(summary.get("active_driver_count", 0) or 0)
    emerging_count = int(summary.get("emerging_driver_count", 0) or 0)
    return {
        "status": chain_status.status,
        "label": label,
        "detail": chain_status.reason,
        "chainStatus": chain_status.status,
        "usableInputs": chain_status.usable_inputs,
        "missingRequired": chain_status.missing_required,
        "contextOnlyInputs": chain_status.context_only_inputs,
        "llmStatus": chain_status.llm_status,
        "evidenceStatus": evidence_status,
        "allowedCandidateDrivers": allowed_candidate_drivers,
        "blockedDrivers": blocked_drivers,
        "jobs": [
            _activity_job(
                "Input readiness",
                chain_status.status,
                chain_status.reason,
                input="Provider health + price history + market context",
                output=f"{len(chain_status.usable_inputs)} usable / {len(chain_status.missing_required)} missing",
                meta={
                    "usable": chain_status.usable_inputs,
                    "missing": chain_status.missing_required,
                    "context_only": chain_status.context_only_inputs,
                },
            ),
            _activity_job(
                "Cross-market sensors",
                "ready" if evidence_status else "waiting",
                "Classifies DXY, yields, oil, and risk sensors as confirming, contradicting, stale, unavailable, or background.",
                input="Related asset rows + provider health",
                output=", ".join(f"{key}: {value}" for key, value in sorted(evidence_status.items())) or "No sensor status yet",
            ),
            _activity_job(
                "Driver attention",
                "ready" if attention_snapshot is not None else "waiting",
                "Known drivers and dynamic themes move between watching, emerging, active, cooling, and retired.",
                input="Evidence status + previous driver states + current headlines",
                output=f"{active_count} active / {emerging_count} emerging",
            ),
            _activity_job(
                "Candidate driver gate",
                "ready",
                "Only allowed candidate drivers can be used by rule or LLM analysis; blocked drivers remain visible as rejected evidence.",
                input="Driver attention states + evidence gates",
                output=f"{len(allowed_candidate_drivers)} allowed / {len(blocked_drivers)} blocked",
                meta={
                    "allowed": allowed_candidate_drivers,
                    "blocked": blocked_drivers,
                },
            ),
        ],
        "handoff": "The evidence packet is the source of truth for rule analysis, Local AI, Dashboard, Replay, and alert preflight.",
    }


def _replay_activity(
    *,
    monitor_run_id: int | None = None,
    timeline_store_path: Path | None = None,
    storage_counts: dict[str, int] | None = None,
    storage_summary: dict[str, Any] | None = None,
    symbols: list[str] | None = None,
) -> dict[str, Any]:
    storage_counts = storage_counts or {}
    storage_summary = storage_summary or {}
    jobs = [
        _activity_job(
            "Monitor run row",
            "stored" if monitor_run_id is not None else "pending",
            "Creates the monitor_runs record that connects every persisted artifact.",
            input="run_started_at + data_mode + backfill flags",
            output=f"monitor_run_id {monitor_run_id}" if monitor_run_id is not None else "Waiting for run id",
        ),
        _activity_job(
            "Raw evidence rows",
            "stored" if storage_counts else "pending",
            "Stores price bars, related sensors, news, calendar, provider health, evidence packet, analysis, alert, and state transition.",
            input="Runtime context + analysis result",
            output=", ".join(f"{key}: {value}" for key, value in storage_counts.items()) or "No rows persisted yet",
        ),
        _activity_job(
            "Replay query model",
            "ready" if monitor_run_id is not None else "waiting",
            "Day replay reads detailed rows; Month replay filters stored timeline events down to major XAUUSD turns.",
            input="TimelineStore indexed range reads",
            output="Dashboard replay, Evidence detail, Alerts history",
        ),
    ]
    if monitor_run_id is None:
        return {
            "status": "pending",
            "label": "Replay store",
            "detail": "Waiting for this run to be persisted.",
            "symbols": symbols or [],
            "jobs": jobs,
            "handoff": "Replay appears after TimelineStore has a monitor_run_id and indexed range data.",
        }
    return {
        "status": "stored",
        "label": "Replay stored",
        "detail": f"Run {monitor_run_id} persisted to TimelineStore.",
        "monitorRunId": monitor_run_id,
        "timelineStorePath": str(timeline_store_path) if timeline_store_path is not None else "",
        "stored": storage_counts,
        "storageSummary": storage_summary,
        "symbols": symbols or [],
        "jobs": jobs,
        "handoff": "Stored artifacts feed Dashboard, Evidence, Replay day/month views, and alert history without re-running analysis.",
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
    llm_telemetry: list[dict[str, Any]] | None = None,
    alert_preflight: dict[str, Any] | None = None,
    monitor_run_id: int | None = None,
    timeline_store_path: Path | None = None,
    storage_counts: dict[str, int] | None = None,
    storage_summary: dict[str, Any] | None = None,
    history_window_start: str | None = None,
    history_window_end: str | None = None,
    selected_market_provider: str = "",
    provider_chain_status: list[dict[str, Any]] | None = None,
    fallback_reason: str = "",
    evidence_status: dict[str, str] | None = None,
    allowed_candidate_drivers: list[str] | None = None,
    blocked_drivers: dict[str, str] | None = None,
    attention_snapshot: Any | None = None,
) -> dict[str, Any]:
    market_price_bars = market_price_bars or []
    related_asset_bars = related_asset_bars or []
    symbols = _symbols_from_rows(market_price_bars, related_asset_bars)
    symbol_rows = _count_by_symbol([*market_price_bars, *related_asset_bars])
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
    snapshot = {
        "ctrader": _ctrader_activity(
            provider_health.get("xauusd"),
            selected_market_provider=selected_market_provider,
            provider_chain_status=provider_chain_status,
            fallback_reason=fallback_reason,
        ),
        "history": _history_activity(
            backfill_required,
            completed=history_completed,
            window_start=history_window_start,
            window_end=history_window_end,
            stored_rows=history_stored_rows,
            symbols=symbols,
            symbol_rows=symbol_rows,
        ),
        "context": _context_activity(
            news_count,
            calendar_count,
            news_rows=news_rows,
            calendar_rows=calendar_rows,
            provider_health=provider_health,
        ),
        "evidence": _evidence_activity(
            chain_status,
            evidence_status=evidence_status,
            allowed_candidate_drivers=allowed_candidate_drivers,
            blocked_drivers=blocked_drivers,
            attention_snapshot=attention_snapshot,
        ),
        "llm": _llm_activity(
            llm_enabled,
            llm_status,
            model=llm_model,
            analysis=analysis,
            alert_preflight=alert_preflight,
            telemetry=llm_telemetry,
        ),
        "replay": _replay_activity(
            monitor_run_id=monitor_run_id,
            timeline_store_path=timeline_store_path,
            storage_counts=storage_counts,
            storage_summary=storage_summary,
            symbols=symbols,
        ),
        "alerts": _alert_activity(decision, telegram_result, alert_preflight=alert_preflight, analysis=analysis),
    }
    snapshot["summary"] = {
        "symbols": symbols,
        "symbolRows": symbol_rows,
        "windowStart": history_window_start,
        "windowEnd": history_window_end,
        "selectedMarketProvider": selected_market_provider,
        "dataStores": [
            "monitor_runs",
            "provider_health",
            "market_price_bars",
            "related_asset_bars",
            "news_items",
            "calendar_events",
            "driver_attention_states",
            "evidence_packets",
            "analysis_results",
            "alerts",
            "state_transitions",
            "timeline_events",
        ],
    }
    return snapshot


class MonitorLock:
    def __init__(self, path: Path, *, stale_after_seconds: int = 900) -> None:
        self.path = Path(path)
        self.stale_after_seconds = stale_after_seconds
        self._fd: int | None = None

    def _locked_pid_is_dead(self) -> bool:
        try:
            first_line = self.path.read_text(encoding="utf-8").splitlines()[0].strip()
            pid = int(first_line)
        except (OSError, IndexError, ValueError):
            return False
        if pid <= 0 or pid == os.getpid():
            return False
        if sys.platform == "win32":
            try:
                import ctypes
                from ctypes import wintypes

                process_query_limited_information = 0x1000
                still_active = 259
                kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
                handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
                if not handle:
                    return True
                try:
                    exit_code = wintypes.DWORD()
                    if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                        return False
                    return int(exit_code.value) != still_active
                finally:
                    kernel32.CloseHandle(handle)
            except Exception:
                return False
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        except OSError as exc:
            if exc.errno in {errno.ESRCH, errno.EINVAL}:
                return True
            return False
        return False

    def __enter__(self) -> "MonitorLock | None":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        now = time.time()
        try:
            stat = self.path.stat()
            if now - stat.st_mtime > self.stale_after_seconds or self._locked_pid_is_dead():
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
            included_rows = _included_news_rows(news_rows)
            news_health = ProviderHealth(
                **{
                    **asdict(news_health),
                    "data_mode": news_health.data_mode if news_health.is_available else "live_seen" if included_rows else "unavailable",
                    "is_available": bool(included_rows),
                    "current_value": float(len(included_rows)),
                    "data_timestamp": included_rows[-1]["published_at"] if included_rows else anchor_time.isoformat(),
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


def _dedupe_market_rows_by_timestamp(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_timestamp: dict[str, dict[str, Any]] = {}
    for row in rows:
        timestamp = str(row.get("data_timestamp") or "")
        if not timestamp:
            continue
        by_timestamp[timestamp] = row
    return sorted(by_timestamp.values(), key=lambda item: str(item.get("data_timestamp") or ""))


def _recent_price_context_health(row: dict[str, Any], anchor_time: datetime, reason: str) -> ProviderHealth:
    close = float(row.get("close_price") or row.get("close") or 0.0)
    return ProviderHealth(
        source="cTrader",
        source_type="spot_snapshot",
        fetched_at=anchor_time.isoformat(),
        data_timestamp=str(row.get("data_timestamp") or anchor_time.isoformat()),
        data_mode="stale",
        is_available=True,
        is_stale=True,
        stale_reason=reason,
        error=reason,
        raw_source_id=str(row.get("symbol", "XAUUSD")),
        current_value=close,
        metadata={
            "stale_classification": "feed_gap_context",
            "market_closed": False,
        },
    )


def _recent_price_context_row(row: dict[str, Any], reason: str) -> dict[str, Any]:
    close = float(row.get("close_price") or row.get("close") or 0.0)
    return {
        **row,
        "symbol": str(row.get("symbol") or "XAUUSD"),
        "data_timestamp": str(row.get("data_timestamp") or row.get("timestamp") or ""),
        "open_price": float(row.get("open_price") or row.get("open") or close),
        "high_price": float(row.get("high_price") or row.get("high") or close),
        "low_price": float(row.get("low_price") or row.get("low") or close),
        "close_price": close,
        "source": str(row.get("source") or "cTrader recent context"),
        "source_type": "spot_snapshot",
        "data_mode": "stale",
        "is_stale": True,
        "stale_reason": reason,
    }


def _with_recent_market_history(
    runtime_context: dict[str, Any],
    *,
    timeline_store: TimelineStore,
    anchor_time: datetime,
) -> dict[str, Any]:
    current_rows = list(runtime_context.get("market_price_bars", []))
    if not current_rows:
        xauusd_health = runtime_context.get("provider_health", {}).get("xauusd")
        if xauusd_health is None or bool(getattr(xauusd_health, "is_available", False)):
            return runtime_context
        recent_rows = timeline_store.get_recent_market_price_bars(
            symbol="XAUUSD",
            anchor_time=anchor_time,
            lookback_minutes=10,
            limit=5,
        )
        if not recent_rows:
            return runtime_context
        reason = str(getattr(xauusd_health, "stale_reason", "") or "Waiting for fresh cTrader live stream snapshot.")
        context_row = _recent_price_context_row(recent_rows[-1], reason)
        runtime_context["market_price_bars"] = [context_row]
        runtime_context["evidence_market_price_bars"] = [context_row]
        runtime_context["provider_health"] = {
            **runtime_context.get("provider_health", {}),
            "xauusd": _recent_price_context_health(context_row, anchor_time, reason),
        }
        runtime_context["fixture"] = _build_fixture_from_context(
            anchor_time=anchor_time,
            market_price_bars=[context_row],
            related_asset_bars=runtime_context.get("related_asset_bars", []),
            news_rows=runtime_context.get("news_rows", []),
            calendar_rows=runtime_context.get("calendar_rows", []),
            scenario_id="live_once",
        )
        return runtime_context
    recent_rows = timeline_store.get_recent_market_price_bars(
        symbol="XAUUSD",
        anchor_time=anchor_time,
        lookback_minutes=180,
    )
    evidence_rows = _dedupe_market_rows_by_timestamp([*recent_rows, *current_rows])
    if len(evidence_rows) <= len(current_rows):
        runtime_context["evidence_market_price_bars"] = current_rows
        return runtime_context
    runtime_context["evidence_market_price_bars"] = evidence_rows
    return runtime_context


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
        and -5 <= age_seconds <= 300
    )


def _is_market_closed_xauusd_context(health: ProviderHealth | None) -> bool:
    if health is None:
        return False
    metadata = health.metadata or {}
    stale_reason = str(health.stale_reason or "").lower()
    return bool(
        health.is_available
        and health.is_stale
        and health.current_value is not None
        and (
            metadata.get("market_closed") is True
            or str(metadata.get("stale_classification", "")).lower() == "market_closed"
            or (
                health.data_mode in {"market_closed", "stale"}
                and (
                    "market closed" in stale_reason
                    or "market may be closed" in stale_reason
                    or "market reopens" in stale_reason
                    or "weekend closed" in stale_reason
                )
            )
        )
    )


def _is_feed_gap_xauusd_context(health: ProviderHealth | None) -> bool:
    if health is None:
        return False
    metadata = health.metadata or {}
    return bool(
        health.is_available
        and health.is_stale
        and health.current_value is not None
        and str(metadata.get("stale_classification", "")).lower() == "feed_gap_context"
    )


def _xauusd_context_input_label(health: ProviderHealth | None) -> str:
    if _is_market_closed_xauusd_context(health):
        return "market_closed_last_xauusd_spot"
    if _is_feed_gap_xauusd_context(health):
        return "feed_gap_last_xauusd_spot"
    return "stale_xauusd_spot"


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
    market_closed_xauusd_context = _is_market_closed_xauusd_context(xauusd)
    feed_gap_xauusd_context = _is_feed_gap_xauusd_context(xauusd)
    if _is_live_xauusd_health(xauusd) and fixture.market.to_price > 0:
        usable_inputs.append("live_xauusd_spot")
    elif market_closed_xauusd_context or feed_gap_xauusd_context or (
        xauusd and xauusd.is_available and xauusd.is_stale and xauusd.current_value
    ):
        context_only_inputs.append(_xauusd_context_input_label(xauusd))
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
        if market_closed_xauusd_context:
            reason = (
                "XAUUSD market is closed; news, calendar, and cross-market context keep updating, "
                "and the next trade read resumes when fresh XAUUSD price action returns."
            )
        elif xauusd and xauusd.is_available and xauusd.is_stale:
            reason = (
                "XAUUSD live quote is stale; news, calendar, and cross-market context keep updating, "
                "but a current trade read needs fresh spot and recent price history."
            )
        else:
            reason = "A current XAUUSD trade read needs fresh live price and recent price history."
        return EvidenceChainStatus(
            status="context_only",
            can_show_current_conclusion=False,
            reason=reason,
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
            context_only_inputs=[
                *context_only_inputs,
                *[
                    f"{key}_{str(evidence_status.get(key) or 'unavailable').lower()}"
                    for key in unavailable_related
                ],
            ],
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
        user_message=chain_status.reason,
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
    market_closed_context = _is_market_closed_xauusd_context(xauusd)
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
    chain_status: EvidenceChainStatus,
) -> Any:
    if not hasattr(analysis, "__dataclass_fields__"):
        return analysis
    if run_type == "live" and data_mode == "live_seen":
        return analysis
    if run_type == "live":
        reason = chain_status.reason
    else:
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
        return False, message, "Local AI alert review is required before Telegram delivery."
    if not bool(getattr(getattr(llm_client, "config", None), "enabled", False)):
        return False, message, "Local AI alert review is disabled."
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
        return False, message, "Local AI alert review is unavailable."
    if not isinstance(review, dict):
        return False, message, "Local AI alert review returned no decision."
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


def _notification_ledger_path(alerts_path: Path) -> Path:
    return Path(alerts_path).with_name("market_agent_notification_ledger.json")


def _alert_fingerprint(message: str, analysis: Any, data_mode: str) -> str:
    payload = {
        "message": " ".join(str(message or "").split()),
        "main_driver": str(getattr(analysis, "main_driver", "unknown") or "unknown"),
        "bias": str(getattr(analysis, "bias", "unknown") or "unknown"),
        "cause_status": str(getattr(analysis, "cause_status", "unknown") or "unknown"),
        "data_mode": data_mode,
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()


def _read_notification_ledger(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_notification_ledger(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _reserve_notification_fingerprint(
    *,
    alerts_path: Path,
    fingerprint: str,
    now_iso: str,
    cooldown_minutes: int,
) -> tuple[bool, str]:
    ledger_path = _notification_ledger_path(alerts_path)
    ledger = _read_notification_ledger(ledger_path)
    previous = ledger.get("last")
    if isinstance(previous, dict) and previous.get("fingerprint") == fingerprint:
        previous_time = str(previous.get("reserved_at") or "")
        try:
            elapsed = (datetime.fromisoformat(now_iso) - datetime.fromisoformat(previous_time)).total_seconds() / 60
        except Exception:
            elapsed = 1_000_000.0
        if elapsed < cooldown_minutes:
            return False, "Duplicate Telegram alert suppressed by notification ledger."
    ledger["last"] = {
        "fingerprint": fingerprint,
        "reserved_at": now_iso,
        "status": "reserved",
    }
    _write_notification_ledger(ledger_path, ledger)
    return True, "reserved"


def _complete_notification_fingerprint(
    *,
    alerts_path: Path,
    fingerprint: str,
    telegram_result: dict[str, Any],
) -> None:
    ledger_path = _notification_ledger_path(alerts_path)
    ledger = _read_notification_ledger(ledger_path)
    previous = ledger.get("last")
    if not isinstance(previous, dict) or previous.get("fingerprint") != fingerprint:
        return
    previous["status"] = "sent" if telegram_result.get("sent") else str(telegram_result.get("status") or "failed")
    previous["telegram"] = telegram_result
    _write_notification_ledger(ledger_path, ledger)


def _safe_summary_text(value: Any, limit: int = 180) -> str:
    text = " ".join(str(value or "").split())
    if len(text) <= limit:
        return text.rstrip(" ,;:-")
    clipped = text[:limit].rstrip()
    if limit > 0 and not text[limit : limit + 1].isspace():
        clipped = re.sub(r"\s+\S*$", "", clipped).rstrip()
    clipped = (clipped or text[:limit].rstrip()).rstrip(" ,;:-")
    clipped = re.sub(r"\s+(this|that|the|a|an|and|or|for|to|of|with|as|by)$", "", clipped, flags=re.IGNORECASE)
    return clipped


_MARKET_TITLE_VERBS = re.compile(
    r"\b("
    r"is|are|was|were|be|being|been|will|would|could|should|may|might|can|"
    r"says|said|warns|warned|signals|signaled|announces|announced|expects|expected|"
    r"hits|hit|jumps|jumped|falls|fell|drops|dropped|slips|slipped|rises|rose|"
    r"surges|surged|eases|eased|extends|extended|hold|holds|held|keep|keeps|kept|weighs|weighed|"
    r"drives|drove|pressure|pressures|pressured|opens|opened|closes|closed|cuts|cut|"
    r"raises|raised|denies|denied|confirms|confirmed|threatens|threatened|"
    r"disrupts|disrupted|sanctions|sanctioned|lifts|lifted|pushes|pushed|"
    r"leaves|left|returns|returned|lift"
    r")\b",
    re.IGNORECASE,
)


def _is_complete_market_news_title(value: Any) -> bool:
    text = str(value or "").strip()
    if not text:
        return False
    words = re.findall(r"[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?", text)
    if 3 <= len(words) < 5:
        return bool(_MARKET_TITLE_VERBS.search(text))
    if len(words) >= 7:
        return True
    if len(words) < 5:
        return False
    return bool(_MARKET_TITLE_VERBS.search(text))


def _safe_market_read_title(value: Any, limit: int = 112) -> str:
    text = _safe_summary_text(value, limit=180)
    if not text:
        return ""
    for separator in (": ", " — ", " - "):
        head, marker, _tail = text.partition(separator)
        if marker and _is_complete_market_news_title(head):
            text = head
            break
    return _safe_summary_text(text, limit=limit)


_MARKET_READ_STRONG_TERMS = re.compile(
    r"\b("
    r"xauusd|gold|bullion|treasury|treasurys|yield|yields|dollar|dxy|fed|fomc|rates?|"
    r"inflation|cpi|ppi|pce|jobs?|payrolls?|oil|crude|wti|brent|iran|israel|hormuz|"
    r"geopolitical|war|strike|ceasefire|sanction|risk|stocks?|equities"
    r")\b",
    re.IGNORECASE,
)

_MARKET_READ_WEAK_TERMS = re.compile(
    r"\b("
    r"credit cards?|mortgages?|car loans?|savings rates?|your finances?|portfolio stocks?|"
    r"cramer|retirement|social security|fertility|smartphones?|used car|consumer loans?"
    r")\b",
    re.IGNORECASE,
)


def _market_read_title_quality(item: Any, title: str) -> int:
    text = f"{title} {' '.join(getattr(item, 'tags', ())) } {getattr(item, 'relevance_reason', '')}".lower()
    score = len(_MARKET_READ_STRONG_TERMS.findall(text))
    score -= 3 * len(_MARKET_READ_WEAK_TERMS.findall(text))
    if text.startswith(("i'm ", "i’m ")):
        score -= 4
    return score


def _market_read_driver_label(driver: str) -> str:
    return {
        "usd": "USD",
        "yields": "rates/yields",
        "oil_inflation": "oil/inflation",
        "risk_sentiment": "risk sentiment",
        "geopolitics": "geopolitics",
        "technical_liquidation": "technical flow",
        "unknown": "unconfirmed",
    }.get(str(driver or "unknown"), str(driver or "unknown").replace("_", " "))


def _market_read_bias_label(bias: str) -> str:
    return {
        "bullish_gold": "bullish for gold",
        "bearish_gold": "bearish for gold",
        "neutral": "neutral",
    }.get(str(bias or "neutral"), str(bias or "neutral").replace("_", " "))


def _market_read_provider_ok(provider_health: dict[str, ProviderHealth], key: str) -> bool:
    health = provider_health.get(key)
    return bool(health and health.is_available and not health.is_stale and health.data_mode != "unavailable")


def _market_read_evidence_status_for_sensor(evidence_status: dict[str, str], key: str) -> str:
    direct = str(evidence_status.get(key, "") or "")
    if direct:
        return direct
    if key in {"wti", "brent"}:
        return str(evidence_status.get("oil", "") or "")
    if key in {"vix", "spx", "nasdaq"}:
        return str(evidence_status.get("vix_equities", "") or "")
    return ""


def _market_read_latest_titles(items: tuple[Any, ...], limit: int = 3) -> list[str]:
    ranked: list[tuple[int, int, str]] = []
    seen: set[str] = set()
    for index, item in enumerate(items):
        title = _safe_market_read_title(getattr(item, "title", ""))
        if title and title not in seen:
            seen.add(title)
            ranked.append((_market_read_title_quality(item, title), -index, title))
    ranked.sort(reverse=True)
    positive = [item for item in ranked if item[0] >= 0]
    selected = positive if positive else ranked
    return [title for _score, _index, title in selected[:limit]]


def _market_read_contains_keyword(text: str, keyword: str) -> bool:
    normalized_text = re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()
    normalized_keyword = re.sub(r"[^a-z0-9]+", " ", keyword.lower()).strip()
    if not normalized_text or not normalized_keyword:
        return False
    return re.search(rf"(?<![a-z0-9]){re.escape(normalized_keyword)}(?![a-z0-9])", normalized_text) is not None


def _market_read_driver_keywords(driver: str) -> tuple[str, ...]:
    normalized = str(driver or "").lower()
    return {
        "geopolitics": (
            "iran",
            "israel",
            "hormuz",
            "lebanon",
            "middle east",
            "red sea",
            "military",
            "missile",
            "attack",
            "strike",
            "war",
            "ceasefire",
            "airspace",
        ),
        "fed_rates": ("fed", "fomc", "powell", "rate", "rates", "cpi", "ppi", "pce", "nfp", "payroll", "jobs"),
        "yields": ("yield", "yields", "treasury", "us10y", "us2y", "rate", "rates"),
        "usd": ("usd", "dollar", "dxy", "greenback"),
        "oil_inflation": ("oil", "opec", "hormuz", "supply", "sanction", "inventory", "shipping", "wti", "brent", "crude"),
        "risk_sentiment": ("vix", "risk", "equities", "stocks", "spx", "nasdaq"),
    }.get(normalized, ())


def _market_read_driver_matched_titles(
    *,
    items: tuple[Any, ...],
    driver: str,
    limit: int = 3,
) -> list[str]:
    keywords = _market_read_driver_keywords(driver)
    if not keywords:
        return []
    matched: list[Any] = []
    for item in items:
        text = f"{getattr(item, 'title', '')} {' '.join(getattr(item, 'tags', ())) } {getattr(item, 'relevance_reason', '')}"
        if any(_market_read_contains_keyword(text, keyword) for keyword in keywords):
            matched.append(item)
    return _market_read_latest_titles(tuple(matched), limit=limit)


def _market_read_driver_evidence_titles(
    *,
    attention_snapshot: Any | None,
    driver: str,
    limit: int = 3,
) -> list[str]:
    states = getattr(attention_snapshot, "states", {}) or {}
    summary = getattr(attention_snapshot, "driver_attention_summary", {}) or {}
    top_driver = str(summary.get("top_driver") or "")
    candidate_ids = [driver if driver and driver != "unknown" else top_driver, top_driver]
    ranked: list[tuple[int, int, str]] = []
    seen: set[str] = set()
    ordinal = 0
    for driver_id in dict.fromkeys(item for item in candidate_ids if item):
        state = states.get(driver_id)
        refs = getattr(state, "evidence_refs", ()) if state is not None else ()
        for ref in refs:
            title = _safe_market_read_title(ref.get("title") if isinstance(ref, dict) else "")
            if title and title not in seen:
                seen.add(title)
                ranked.append((_market_read_title_quality(ref, title), -ordinal, title))
                ordinal += 1
    ranked.sort(reverse=True)
    positive = [item for item in ranked if item[0] >= 0]
    selected = positive if positive else ranked
    return [title for _score, _index, title in selected[:limit]]


def _dedupe_market_read_strings(items: list[str], *, limit: int) -> list[str]:
    selected: list[str] = []
    seen: set[str] = set()
    for item in items:
        text = _safe_summary_text(item, limit=150)
        key = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
        if not text or not key or key in seen:
            continue
        seen.add(key)
        selected.append(text)
        if len(selected) >= limit:
            break
    return selected


def _market_read_timeline_points(analysis: Any | None, fixture: ScenarioFixture, *, limit: int = 4) -> list[str]:
    points: list[str] = []
    timeline = getattr(analysis, "timeline", None) if analysis is not None else None
    if isinstance(timeline, list):
        for item in timeline:
            if not isinstance(item, dict):
                continue
            event = _safe_summary_text(item.get("event"), limit=130)
            time_label = _safe_summary_text(item.get("time_myt"), limit=24)
            if event:
                points.append(f"{time_label} {event}".strip())
    if not points:
        for item in tuple(fixture.news)[:limit]:
            title = _safe_market_read_title(getattr(item, "title", ""))
            time_label = _safe_summary_text(getattr(item, "timestamp_myt", ""), limit=24)
            if title:
                points.append(f"{time_label} {title}".strip())
    return _dedupe_market_read_strings(points, limit=limit)


def _market_read_next_points(
    *,
    watchlist: list[str],
    calendar_titles: list[str],
    confirming: list[str],
    chain_status: EvidenceChainStatus,
    limit: int = 4,
) -> list[str]:
    points: list[str] = []
    if calendar_titles:
        points.extend([f"Calendar: {title}" for title in calendar_titles[:2]])
    if watchlist:
        points.extend([f"Confirm: {item}" for item in watchlist])
    if not confirming and "cross_market_sensors" in chain_status.context_only_inputs:
        points.append("Confirm: DXY, yields, oil, and risk sensors must agree with XAUUSD")
    if not points:
        points.append("Keep monitoring price, news, calendar, and sensor alignment")
    return _dedupe_market_read_strings(points, limit=limit)


def _market_read_risk_points(
    *,
    evidence_status: dict[str, str],
    chain_status: EvidenceChainStatus,
    limit: int = 4,
) -> list[str]:
    labels = {
        "dxy": "DXY",
        "us10y": "US10Y",
        "us2y": "US2Y",
        "oil": "Oil",
        "vix_equities": "VIX/equities",
        "news": "News",
    }
    points: list[str] = []
    for key, label in labels.items():
        status = str(evidence_status.get(key, "") or "").lower()
        if status in {"stale", "unavailable"}:
            points.append(f"{label} is {status}; confidence stays limited")
        elif status == "not_confirming":
            points.append(f"{label} is present but not confirming the gold move")
    for missing in chain_status.missing_required:
        points.append(f"Missing required input: {missing}")
    if not points and chain_status.context_only_inputs:
        points.append("Some inputs are context only, not confirmation")
    return _dedupe_market_read_strings(points, limit=limit)


def _build_analyst_read(
    *,
    fixture: ScenarioFixture,
    analysis: Any | None,
    stance: str,
    headline: str,
    thesis: str,
    direction: str,
    move: float,
    watchlist: list[str],
    news_titles: list[str],
    calendar_titles: list[str],
    confirming: list[str],
    chain_status: EvidenceChainStatus,
    evidence_status: dict[str, str],
) -> dict[str, Any]:
    trade_call_ready = stance == "current_read" and chain_status.can_show_current_conclusion
    if trade_call_ready:
        conclusion = "trade_call"
    elif stance in {"market_observation", "no_conclusion"}:
        conclusion = "market_observation"
    else:
        conclusion = "context_watch"
    now = _safe_summary_text(
        thesis
        or headline
        or f"XAUUSD is {direction} {move:+.2f}% while the agent waits for driver confirmation.",
        limit=220,
    )
    if not now and news_titles:
        now = news_titles[0]
    return {
        "schema": "market_read.v1",
        "conclusion_type": conclusion,
        "now": now,
        "past": _market_read_timeline_points(analysis, fixture),
        "next": _market_read_next_points(
            watchlist=watchlist,
            calendar_titles=calendar_titles,
            confirming=confirming,
            chain_status=chain_status,
        ),
        "risks": _market_read_risk_points(evidence_status=evidence_status, chain_status=chain_status),
        "trade_call_ready": trade_call_ready,
        "trade_call_blocker": "" if trade_call_ready else _safe_summary_text(chain_status.reason, limit=160),
    }


def _build_market_read(
    *,
    fixture: ScenarioFixture,
    provider_health: dict[str, ProviderHealth],
    attention_snapshot: Any | None,
    analysis: Any | None,
    chain_status: EvidenceChainStatus,
    previous_state: Any,
    evidence_status: dict[str, str],
) -> dict[str, Any]:
    driver = str(getattr(analysis, "main_driver", "unknown") or "unknown") if analysis is not None else "unknown"
    cause_status = str(getattr(analysis, "cause_status", "unconfirmed") or "unconfirmed") if analysis is not None else "unconfirmed"
    confidence = str(getattr(analysis, "confidence", "low") or "low") if analysis is not None else "low"
    bias = str(getattr(analysis, "bias", "neutral") or "neutral") if analysis is not None else "neutral"
    move = float(fixture.market.move_percent_15m or fixture.market.move_percent or 0.0)
    direction = "up" if move > 0 else "down" if move < 0 else "flat"
    live_price_ok = _market_read_provider_ok(provider_health, "xauusd")
    sensor_keys = ("dxy", "us10y", "us2y", "wti", "brent", "vix", "spx", "nasdaq")
    usable_sensors = [key for key in sensor_keys if _market_read_provider_ok(provider_health, key)]
    context_sensors = [
        key
        for key in sensor_keys
        if _market_read_evidence_status_for_sensor(evidence_status, key).lower() == "market_closed_context"
    ]
    confirming = [
        key
        for key, status in evidence_status.items()
        if str(status).lower() in {"confirming", "supporting", "accepted"}
    ]
    summary = getattr(attention_snapshot, "driver_attention_summary", {}) or {}
    top_driver = str(summary.get("top_driver") or "")
    news_titles = _market_read_driver_evidence_titles(
        attention_snapshot=attention_snapshot,
        driver=driver,
    ) or _market_read_driver_matched_titles(
        items=fixture.news,
        driver=driver if driver and driver != "unknown" else top_driver,
    ) or _market_read_latest_titles(fixture.news)
    calendar_titles = _market_read_latest_titles(fixture.calendar_events, limit=2)
    previous_driver = str(getattr(previous_state, "main_driver", "") or "")
    previous_bias = str(getattr(previous_state, "current_bias", "") or "")
    analysis_engine = str(getattr(analysis, "analysis_engine", "rule_based") or "rule_based") if analysis is not None else "not_run"
    llm_status = str(getattr(analysis, "llm_status", "not_used") or "not_used") if analysis is not None else "not_used"
    market_closed_xauusd_context = _is_market_closed_xauusd_context(provider_health.get("xauusd"))
    feed_gap_xauusd_context = _is_feed_gap_xauusd_context(provider_health.get("xauusd"))

    if not chain_status.can_show_current_conclusion and market_closed_xauusd_context:
        headline = "Market closed; news watch continues"
        stance = "context_only"
        thesis = (
            "XAUUSD is closed, so the agent keeps the last spot price as context while it reviews "
            "news, calendar events, and cross-market sensors for the next tradable read."
        )
    elif not chain_status.can_show_current_conclusion and (news_titles or calendar_titles):
        headline = (news_titles or calendar_titles)[0]
        stance = "market_observation"
        if feed_gap_xauusd_context:
            thesis = (
                f"{headline}. Recent XAUUSD context and the market story are still being tracked, "
                "but this is not a trade call until a fresh XAUUSD quote confirms the move."
            )
        elif live_price_ok:
            thesis = (
                f"{headline}. Live XAUUSD is available and the market story is being tracked, "
                "but this is not a trade call until recent price history confirms the move."
            )
        else:
            thesis = (
                f"{headline}. XAUUSD live price or recent history is unavailable, so this is not a trade call; "
                "the news/calendar story is being tracked for the next tradable read."
            )
    elif not chain_status.can_show_current_conclusion:
        headline = "Fresh price confirmation needed"
        stance = "context_only"
        thesis = (
            "News, calendar, and cross-market sensors are still reviewed, "
            "but a current XAUUSD trade read needs fresh live price and recent price history."
        )
    elif driver == "unknown" or cause_status in {"unconfirmed", "no_meaningful_change"}:
        if news_titles or calendar_titles:
            headline = (news_titles or calendar_titles)[0]
            stance = "market_observation"
            thesis = (
                f"{headline}. No trade call is published until XAUUSD price action and confirming "
                "market sensors line up with the news/calendar context."
            )
        else:
            headline = "No confirmed market driver yet"
            stance = "no_conclusion"
            thesis = (
                f"XAUUSD is {direction} {move:+.2f}%, but price, news, calendar, and sensor evidence "
                "do not agree enough to publish a directional market read."
            )
    else:
        driver_label = _market_read_driver_label(driver)
        headline = f"{driver_label.title()} leads the gold read"
        stance = "current_read"
        thesis = _safe_summary_text(
            getattr(analysis, "user_message", "")
            or getattr(analysis, "summary", "")
            or getattr(analysis, "causal_chain", ""),
            limit=220,
        )
        if not thesis:
            thesis = f"{driver_label.title()} is the main driver; current stance is {_market_read_bias_label(bias)}."

    if previous_driver and previous_driver not in {"unknown", driver}:
        continuity = (
            f"Previous stored read was {_market_read_driver_label(previous_driver)}"
            f"{f' / {_market_read_bias_label(previous_bias)}' if previous_bias else ''}; this run checks whether the story has changed."
        )
    elif previous_driver == driver and driver != "unknown":
        continuity = f"The {_market_read_driver_label(driver)} story is continuing from the previous stored read."
    else:
        continuity = "No prior confirmed read is being carried into this run."

    watchlist: list[str] = []
    if not live_price_ok:
        watchlist.append("fresh XAUUSD spot")
    if "news_context" not in chain_status.usable_inputs and not news_titles:
        watchlist.append("fresh market-moving headline")
    if "calendar_context" not in chain_status.usable_inputs and not calendar_titles:
        watchlist.append("upcoming USD calendar event")
    if not confirming:
        watchlist.append("DXY/yields confirmation")

    sensor_coverage = f"{len(usable_sensors)} of {len(sensor_keys)} usable"
    if context_sensors:
        sensor_coverage = f"{len(usable_sensors)} fresh / {len(context_sensors)} context"

    analyst_read = _build_analyst_read(
        fixture=fixture,
        analysis=analysis,
        stance=stance,
        headline=headline,
        thesis=thesis,
        direction=direction,
        move=move,
        watchlist=watchlist,
        news_titles=news_titles,
        calendar_titles=calendar_titles,
        confirming=confirming,
        chain_status=chain_status,
        evidence_status=evidence_status,
    )

    return {
        "status": stance,
        "headline": headline,
        "thesis": thesis,
        "bias": bias,
        "driver": driver,
        "driver_label": _market_read_driver_label(driver),
        "secondary_driver": str(getattr(analysis, "secondary_driver", "") or "") if analysis is not None else "",
        "cause_status": cause_status,
        "confidence": confidence,
        "move": {
            "direction": direction,
            "percent": round(move, 4),
            "window_minutes": fixture.market.window_minutes,
        },
        "coverage": {
            "live_price": "fresh" if live_price_ok else "market_closed_context" if market_closed_xauusd_context else "stale_or_missing",
            "recent_history": "ready"
            if "xauusd_recent_history" in chain_status.usable_inputs
            else "market_closed_context"
            if market_closed_xauusd_context
            else "missing",
            "sensors": sensor_coverage,
            "news": f"{len(fixture.news)} reviewed",
            "calendar": f"{len(fixture.calendar_events)} reviewed",
            "ai": "validated" if analysis_engine == "llm_validated" else f"rules ({llm_status})",
        },
        "evidence": {
            "confirming": confirming[:5],
            "missing": chain_status.missing_required,
            "context_only": chain_status.context_only_inputs[:6],
            "latest_news": news_titles,
            "calendar": calendar_titles,
        },
        "continuity": continuity,
        "watch_next": watchlist[:4],
        "analyst_read": analyst_read,
    }


def _apply_summary_items(
    rows: list[dict[str, Any]],
    summaries: Any,
    *,
    require_complete_title: bool = False,
) -> int:
    if not isinstance(summaries, list):
        return 0
    applied = 0
    for item in summaries:
        if not isinstance(item, dict):
            continue
        try:
            index = int(item.get("source_index", -1))
        except (TypeError, ValueError):
            continue
        if index < 0 or index >= len(rows):
            continue
        summary = _safe_summary_text(item.get("summary"))
        title = _safe_summary_text(item.get("summary_title"), limit=80)
        row_applied = False
        if summary:
            rows[index]["summary"] = summary
            rows[index]["summary_source"] = "local_ai"
            row_applied = True
        if title and (not require_complete_title or _is_complete_market_news_title(title)):
            rows[index]["summary_title"] = title
            rows[index]["summary_source"] = "local_ai"
            row_applied = True
        direction = _normalize_gold_impact_direction(
            item.get("impact_direction_on_gold")
            or item.get("xauusd_direction")
            or item.get("direction_on_gold")
            or item.get("direction")
        )
        if direction:
            current_direction = _normalize_gold_impact_direction(rows[index].get("impact_direction_on_gold"))
            if direction != "unknown" or not current_direction or current_direction == "unknown":
                rows[index]["impact_direction_on_gold"] = direction
                rows[index]["impact_direction_source"] = "local_ai"
                row_applied = True
        if row_applied:
            applied += 1
    return applied


def _normalize_gold_impact_direction(value: Any) -> str:
    text = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    if not text:
        return ""
    if text in {"bullish", "bullish_gold", "positive", "positive_gold", "up", "xauusd_bullish"}:
        return "bullish"
    if text in {"bearish", "bearish_gold", "negative", "negative_gold", "down", "xauusd_bearish"}:
        return "bearish"
    if text in {"neutral", "mixed", "balanced", "two_sided"}:
        return "neutral"
    if text in {"unknown", "unclear", "not_sure", "insufficient", "n_a", "na"}:
        return "unknown"
    return ""


def _apply_display_summaries(
    llm_client: Any,
    runtime_context: dict[str, Any],
    evidence_packet: dict[str, Any],
    analysis: Any,
) -> None:
    if llm_client is None or not hasattr(llm_client, "summarize_display"):
        runtime_context["display_summary_status"] = "not_used"
        return
    payload = {
        "evidence_packet": evidence_packet,
        "analysis": analysis.to_dict() if hasattr(analysis, "to_dict") else analysis,
        "news": runtime_context.get("news_rows", []),
        "calendar": runtime_context.get("calendar_rows", []),
        "related_assets": runtime_context.get("related_asset_bars", []),
    }
    try:
        summaries = llm_client.summarize_display(payload)
    except Exception:
        runtime_context["display_summary_status"] = "unavailable"
        return
    if not isinstance(summaries, dict):
        runtime_context["display_summary_status"] = "invalid"
        return

    applied = 0
    applied += _apply_summary_items(
        runtime_context.get("news_rows", []),
        summaries.get("news"),
        require_complete_title=True,
    )
    applied += _apply_summary_items(runtime_context.get("calendar_rows", []), summaries.get("calendar"))
    related_by_symbol: dict[str, list[dict[str, Any]]] = {}
    for row in runtime_context.get("related_asset_bars", []):
        symbol = str(row.get("symbol", "")).lower()
        if symbol:
            related_by_symbol.setdefault(symbol, []).append(row)
    related_summaries = summaries.get("related_assets")
    if isinstance(related_summaries, dict):
        for symbol, items in related_summaries.items():
            applied += _apply_summary_items(related_by_symbol.get(str(symbol).lower(), []), items)

    runtime_context["display_summary_status"] = "summarized" if applied else "empty"


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
        if str(state.driver_id).startswith("theme:") and state.current_state != "retired"
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
    market_read = _build_market_read(
        fixture=fixture,
        provider_health=provider_health,
        attention_snapshot=attention_snapshot,
        analysis=analysis,
        chain_status=chain_status,
        previous_state=previous_state,
        evidence_status=evidence.evidence_status,
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
        "market_read": market_read,
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


def _context_review_event_payload(
    *,
    fixture: ScenarioFixture,
    analysis: Any,
    chain_status: EvidenceChainStatus,
    data_mode: str,
) -> dict[str, Any]:
    latest_news = _market_read_latest_titles(fixture.news, limit=5)
    latest_calendar = _market_read_latest_titles(fixture.calendar_events, limit=3)
    headline = str(getattr(analysis, "summary", "") or getattr(analysis, "user_message", "") or chain_status.reason)
    return {
        "semantic_type": "context_review",
        "trade_conclusion": False,
        "data_mode": data_mode,
        "summary_title": "Market context reviewed",
        "summary": _safe_summary_text(headline, limit=180),
        "news_count": len(fixture.news),
        "calendar_count": len(fixture.calendar_events),
        "latest_news": latest_news,
        "latest_calendar": latest_calendar,
        "missing_required": chain_status.missing_required,
        "usable_inputs": chain_status.usable_inputs,
        "context_only_inputs": chain_status.context_only_inputs,
        "analysis": analysis.to_dict() if hasattr(analysis, "to_dict") else {},
    }


def _context_review_signature(payload: dict[str, Any]) -> str:
    analysis = payload.get("analysis") if isinstance(payload.get("analysis"), dict) else {}
    signature = {
        "data_mode": payload.get("data_mode"),
        "summary": payload.get("summary"),
        "news_count": payload.get("news_count"),
        "calendar_count": payload.get("calendar_count"),
        "latest_news": payload.get("latest_news") or [],
        "latest_calendar": payload.get("latest_calendar") or [],
        "missing_required": payload.get("missing_required") or [],
        "usable_inputs": payload.get("usable_inputs") or [],
        "context_only_inputs": payload.get("context_only_inputs") or [],
        "cause_status": analysis.get("cause_status"),
        "main_driver": analysis.get("main_driver"),
        "analysis_engine": analysis.get("analysis_engine"),
    }
    return hashlib.sha256(json.dumps(signature, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def _is_duplicate_context_review(timeline_store: TimelineStore, payload: dict[str, Any]) -> bool:
    latest = timeline_store.get_latest_timeline_event(event_type="context_review", label="market_context")
    latest_payload = latest.get("payload") if latest else None
    if not isinstance(latest_payload, dict):
        return False
    return _context_review_signature(latest_payload) == _context_review_signature(payload)


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
        news_row_count=_included_news_count(context.get("news_rows", [])),
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
    resolved_status_path = _status_path_from_env(status_path or config.monitor_status_path)
    state_store = JsonStateStore(state_path or config.state_store_path)
    timeline_store = TimelineStore(timeline_store_path or config.timeline_store_path)
    resolved_alerts_path = alerts_path or config.alerts_output_path
    sink = FileNotificationSink(resolved_alerts_path)
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
            "ctrader": _ctrader_activity(None),
            "history": _history_activity(backfill_required),
            "context": _context_activity(0, 0),
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
    runtime_context = _with_recent_market_history(
        runtime_context,
        timeline_store=timeline_store,
        anchor_time=anchor,
    )
    fixture = runtime_context["fixture"]
    provider_health = runtime_context["provider_health"]
    evidence_market_price_bars = runtime_context.get("evidence_market_price_bars", runtime_context.get("market_price_bars", []))
    _write_monitor_status(
        resolved_status_path,
        running=True,
        phase="running_evidence_gate",
        lastRunAt=anchor.isoformat(),
        message="Checking whether collected inputs form a usable evidence chain.",
        activity=_activity_snapshot(
            provider_health=provider_health,
            news_count=_included_news_count(runtime_context.get("news_rows", [])),
            calendar_count=len(runtime_context.get("calendar_rows", [])),
            backfill_required=backfill_required,
            llm_enabled=llm_enabled,
            news_rows=runtime_context.get("news_rows", []),
            calendar_rows=runtime_context.get("calendar_rows", []),
            market_price_bar_count=len(evidence_market_price_bars),
            related_asset_bar_count=len(runtime_context.get("related_asset_bars", [])),
            market_price_bars=evidence_market_price_bars,
            related_asset_bars=runtime_context.get("related_asset_bars", []),
            llm_model=str(getattr(getattr(active_llm_client, "config", None), "model", "") or ""),
            history_window_start=last_successful_run_at,
            history_window_end=anchor.isoformat(),
            selected_market_provider=runtime_context.get("selected_market_provider", "unavailable"),
            provider_chain_status=runtime_context.get("provider_chain_status", []),
            fallback_reason=runtime_context.get("fallback_reason", ""),
            llm_telemetry=getattr(active_llm_client, "get_telemetry", lambda: [])(),
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
            news_count=_included_news_count(runtime_context.get("news_rows", [])),
            calendar_count=len(runtime_context.get("calendar_rows", [])),
            backfill_required=backfill_required,
            llm_enabled=llm_enabled,
            news_rows=runtime_context.get("news_rows", []),
            calendar_rows=runtime_context.get("calendar_rows", []),
            market_price_bar_count=len(evidence_market_price_bars),
            related_asset_bar_count=len(runtime_context.get("related_asset_bars", [])),
            market_price_bars=evidence_market_price_bars,
            related_asset_bars=runtime_context.get("related_asset_bars", []),
            llm_model=str(getattr(getattr(active_llm_client, "config", None), "model", "") or ""),
            history_window_start=last_successful_run_at,
            history_window_end=anchor.isoformat(),
            selected_market_provider=runtime_context.get("selected_market_provider", "unavailable"),
            provider_chain_status=runtime_context.get("provider_chain_status", []),
            fallback_reason=runtime_context.get("fallback_reason", ""),
            evidence_status=evidence.evidence_status,
            allowed_candidate_drivers=evidence.allowed_candidate_drivers,
            blocked_drivers=evidence.blocked_drivers,
            attention_snapshot=attention_snapshot,
            llm_telemetry=getattr(active_llm_client, "get_telemetry", lambda: [])(),
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
        market_price_bar_count=len(evidence_market_price_bars),
        related_asset_bar_count=len(runtime_context.get("related_asset_bars", [])),
        news_row_count=_included_news_count(runtime_context.get("news_rows", [])),
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
        chain_status=pre_decision_chain_status,
    )
    packet = _build_packet(
        fixture,
        provider_health=provider_health,
        attention_snapshot=attention_snapshot,
        previous_state=previous_state,
        data_mode=data_mode,
        analysis=analysis,
        market_price_bar_count=len(evidence_market_price_bars),
        related_asset_bar_count=len(runtime_context.get("related_asset_bars", [])),
        news_row_count=_included_news_count(runtime_context.get("news_rows", [])),
        calendar_row_count=len(runtime_context.get("calendar_rows", [])),
        selected_market_provider=runtime_context.get("selected_market_provider", "unavailable"),
        provider_chain_status=runtime_context.get("provider_chain_status", []),
        fallback_reason=runtime_context.get("fallback_reason", ""),
    )
    if (
        str(getattr(analysis, "analysis_engine", "")) == "llm_validated"
        and bool(getattr(getattr(active_llm_client, "config", None), "display_summary_enabled", False))
    ):
        _apply_display_summaries(active_llm_client, runtime_context, packet, analysis)
    else:
        runtime_context["display_summary_status"] = "skipped_in_live_monitor"
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
            news_count=_included_news_count(runtime_context.get("news_rows", [])),
            calendar_count=len(runtime_context.get("calendar_rows", [])),
            backfill_required=backfill_required,
            llm_enabled=llm_enabled,
            llm_status=getattr(analysis, "llm_status", None),
            decision=decision,
            news_rows=runtime_context.get("news_rows", []),
            calendar_rows=runtime_context.get("calendar_rows", []),
            market_price_bar_count=len(evidence_market_price_bars),
            related_asset_bar_count=len(runtime_context.get("related_asset_bars", [])),
            market_price_bars=evidence_market_price_bars,
            related_asset_bars=runtime_context.get("related_asset_bars", []),
            chain_status=pre_decision_chain_status,
            analysis=analysis,
            llm_model=str(getattr(getattr(active_llm_client, "config", None), "model", "") or ""),
            alert_preflight=alert_preflight,
            history_window_start=last_successful_run_at,
            history_window_end=anchor.isoformat(),
            selected_market_provider=runtime_context.get("selected_market_provider", "unavailable"),
            provider_chain_status=runtime_context.get("provider_chain_status", []),
            fallback_reason=runtime_context.get("fallback_reason", ""),
            evidence_status=evidence.evidence_status,
            allowed_candidate_drivers=evidence.allowed_candidate_drivers,
            blocked_drivers=evidence.blocked_drivers,
            attention_snapshot=attention_snapshot,
            llm_telemetry=getattr(active_llm_client, "get_telemetry", lambda: [])(),
        ),
    )
    alert_payload: dict[str, Any] = {}
    telegram_result = {
        "sent": False,
        "status": "disabled",
        "error": "",
        "notification_level": decision.notification_level,
    }
    notification_fingerprint = ""
    if decision.should_notify:
        notification_fingerprint = _alert_fingerprint(alert_message, analysis, data_mode)
        reserved, reserve_reason = _reserve_notification_fingerprint(
            alerts_path=resolved_alerts_path,
            fingerprint=notification_fingerprint,
            now_iso=anchor.isoformat(),
            cooldown_minutes=cooldown_minutes or config.notification_cooldown_minutes,
        )
        if not reserved:
            decision = replace(
                decision,
                should_notify=False,
                notification_level="none",
                reason=reserve_reason,
            )
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
            "fingerprint": notification_fingerprint,
        }
    state_persisted = bool(pre_decision_chain_status.can_show_current_conclusion)
    if state_persisted:
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
    analysis_payload = analysis.to_dict()
    analysis_payload["market_read"] = packet.get("market_read", {})
    analysis_payload["llm_telemetry"] = getattr(active_llm_client, "get_telemetry", lambda: [])()
    analysis_payload["display_summary_status"] = runtime_context.get("display_summary_status", "")
    store_alert_audit = _should_store_alert_audit(analysis, decision)
    store_analysis_timeline = _should_store_analysis_timeline_event(
        chain_status=pre_decision_chain_status,
        analysis=analysis,
        decision=decision,
        backfill_required=backfill_required,
    )
    store_context_timeline = _should_store_context_timeline_event(
        chain_status=pre_decision_chain_status,
        news_row_count=_included_news_count(runtime_context.get("news_rows", [])),
        calendar_row_count=len(runtime_context.get("calendar_rows", [])),
    )
    context_timeline_payload: dict[str, Any] | None = None
    if store_context_timeline:
        context_timeline_payload = _context_review_event_payload(
            fixture=fixture,
            analysis=analysis,
            chain_status=pre_decision_chain_status,
            data_mode=data_mode,
        )
        if _is_duplicate_context_review(timeline_store, context_timeline_payload):
            store_context_timeline = False
    timeline_store.record_analysis_result(
        monitor_run_id,
        analysis_payload,
        rejected_driver=getattr(analysis, "rejected_driver", None),
        rejection_reason=getattr(analysis, "rejection_reason", None),
    )
    alert_record_id: int | None = None
    if store_alert_audit:
        stored_telegram_result = telegram_result
        if decision.should_notify and config.telegram_enabled:
            stored_telegram_result = {
                "sent": False,
                "status": "pending",
                "error": "",
                "notification_level": decision.notification_level,
            }
        alert_record_id = timeline_store.record_alert(
            monitor_run_id,
            {
                **alert_payload,
                "should_notify": decision.should_notify,
                "notification_level": decision.notification_level,
                "reason": decision.reason,
                "telegram": stored_telegram_result,
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
            "state_persisted": state_persisted,
        },
    )
    if store_analysis_timeline:
        market_read = packet.get("market_read", {}) if isinstance(packet.get("market_read"), dict) else {}
        market_read_headline = str(market_read.get("headline") or "").strip()
        timeline_summary_title = (
            market_read_headline
            or _safe_summary_text(getattr(analysis, "summary", None) or getattr(analysis, "user_message", ""))
            or str(getattr(analysis, "main_driver", "unknown")).replace("_", " ").title()
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
                "summary_title": timeline_summary_title,
                "summary": _safe_summary_text(
                    getattr(analysis, "summary", None)
                    or getattr(analysis, "user_message", "")
                    or getattr(analysis, "causal_chain", "")
                ),
                "summary_source": "local_ai"
                if str(getattr(analysis, "analysis_engine", "")) == "llm_validated"
                else "rule_based",
                "market_read": market_read,
                "cause_status": str(getattr(analysis, "cause_status", "") or ""),
                "confidence": str(getattr(analysis, "confidence", "") or ""),
                "bias": str(getattr(analysis, "bias", "") or ""),
                "analysis": analysis_payload,
            },
        )
    if store_context_timeline:
        assert context_timeline_payload is not None
        timeline_store.record_timeline_event(
            monitor_run_id,
            event_time=anchor.isoformat(),
            event_type="context_review",
            label="market_context",
            payload=context_timeline_payload,
        )
    storage_counts = {
        "marketPriceBars": len(runtime_context.get("market_price_bars", [])),
        "relatedAssetBars": len(runtime_context.get("related_asset_bars", [])),
        "newsItems": _included_news_count(runtime_context.get("news_rows", [])),
        "calendarEvents": len(runtime_context.get("calendar_rows", [])),
        "driverAttentionStates": len(attention_snapshot.states),
        "timelineEvents": (1 if store_analysis_timeline else 0) + (1 if store_context_timeline else 0),
        "alerts": 1 if store_alert_audit else 0,
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
                news_count=_included_news_count(runtime_context.get("news_rows", [])),
                calendar_count=len(runtime_context.get("calendar_rows", [])),
                backfill_required=backfill_required,
                llm_enabled=llm_enabled,
                llm_status=getattr(analysis, "llm_status", None),
                decision=decision,
                telegram_result=telegram_result,
                news_rows=runtime_context.get("news_rows", []),
                calendar_rows=runtime_context.get("calendar_rows", []),
                market_price_bar_count=len(evidence_market_price_bars),
                related_asset_bar_count=len(runtime_context.get("related_asset_bars", [])),
                market_price_bars=evidence_market_price_bars,
                related_asset_bars=runtime_context.get("related_asset_bars", []),
                chain_status=pre_decision_chain_status,
                analysis=analysis,
                llm_model=str(getattr(getattr(active_llm_client, "config", None), "model", "") or ""),
                alert_preflight=alert_preflight,
                history_window_start=last_successful_run_at,
                history_window_end=anchor.isoformat(),
                selected_market_provider=runtime_context.get("selected_market_provider", "unavailable"),
                provider_chain_status=runtime_context.get("provider_chain_status", []),
                fallback_reason=runtime_context.get("fallback_reason", ""),
                evidence_status=evidence.evidence_status,
                allowed_candidate_drivers=evidence.allowed_candidate_drivers,
                blocked_drivers=evidence.blocked_drivers,
                attention_snapshot=attention_snapshot,
                llm_telemetry=getattr(active_llm_client, "get_telemetry", lambda: [])(),
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
    if decision.should_notify:
        try:
            sink.emit(alert_payload)
        except Exception:
            pass
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
                try:
                    telegram_result = telegram.send(telegram_payload)
                except Exception as exc:
                    telegram_result = {
                        "sent": False,
                        "status": "failed",
                        "error": str(exc),
                        "notification_level": decision.notification_level,
                    }
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
            if notification_fingerprint:
                _complete_notification_fingerprint(
                    alerts_path=resolved_alerts_path,
                    fingerprint=notification_fingerprint,
                    telegram_result=telegram_result,
                )
        if alert_record_id is not None:
            timeline_store.update_alert(
                alert_record_id,
                {
                    **alert_payload,
                    "should_notify": decision.should_notify,
                    "notification_level": decision.notification_level,
                    "reason": decision.reason,
                    "telegram": telegram_result,
                    "alert_preflight": alert_preflight,
                },
            )
    storage_cleanup = timeline_store.maybe_run_storage_cleanup()
    storage_summary = timeline_store.get_storage_summary()
    if storage_cleanup is not None:
        storage_summary["lastCleanup"] = storage_cleanup
    final_activity = _activity_snapshot(
        provider_health=provider_health,
        news_count=_included_news_count(runtime_context.get("news_rows", [])),
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
        storage_summary=storage_summary,
        history_window_start=last_successful_run_at,
        history_window_end=anchor.isoformat(),
        selected_market_provider=runtime_context.get("selected_market_provider", "unavailable"),
        provider_chain_status=runtime_context.get("provider_chain_status", []),
        fallback_reason=runtime_context.get("fallback_reason", ""),
        evidence_status=evidence.evidence_status,
        allowed_candidate_drivers=evidence.allowed_candidate_drivers,
        blocked_drivers=evidence.blocked_drivers,
        attention_snapshot=attention_snapshot,
        llm_telemetry=getattr(active_llm_client, "get_telemetry", lambda: [])(),
    )
    current_monitor_status = (
        _read_monitor_status(resolved_status_path)
        if resolved_status_path is not None and resolved_status_path.exists()
        else {}
    )
    loop_is_active = (
        current_monitor_status.get("running") is True
        and current_monitor_status.get("autoStart") is True
    )
    final_status_updates = {
        "ok": True,
        "available": True,
        "running": loop_is_active,
        "phase": "run_completed" if loop_is_active else "stopped",
        "pid": current_monitor_status.get("pid") if loop_is_active else None,
        "autoStart": current_monitor_status.get("autoStart") if loop_is_active else current_monitor_status.get("autoStart", False),
        "lastRunAt": anchor.isoformat(),
        "lastSuccessAt": anchor.isoformat(),
        "nextRunAt": current_monitor_status.get("nextRunAt") if loop_is_active else None,
        "lastError": "",
        "message": (
            "Monitor pass completed; the loop remains active."
            if loop_is_active
            else "Monitor run completed."
        ),
        "activity": final_activity,
        "latestMonitorRunId": monitor_run_id,
    }
    from .self_audit import audit_market_agent

    final_status_updates["selfAudit"] = audit_market_agent(config, now=anchor)
    if backfill_required:
        final_status_updates["lastRecoveryAt"] = anchor.isoformat()
    _write_monitor_status(resolved_status_path, **final_status_updates)
    return {
        "monitor_run_id": monitor_run_id,
        "run_type": run_type,
        "backfill_required": backfill_required,
        "last_successful_run_at": last_successful_run_at,
        "evidence_packet": packet,
        "analysis": analysis_payload,
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
    resolved_status_path = _status_path_from_env(status_path or config.monitor_status_path)
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
            autoStart=True,
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
            try:
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
            except Exception as exc:
                failed_at = datetime.now().astimezone()
                failed_outcome = {
                    "ok": False,
                    "phase": "iteration_failed",
                    "message": f"Monitor iteration failed: {exc}",
                    "error": str(exc),
                    "run_started_at": (anchor or failed_at).isoformat(),
                }
                outcomes.append(failed_outcome)
                _write_monitor_status(
                    resolved_status_path,
                    ok=False,
                    available=True,
                    running=True,
                    autoStart=True,
                    phase="iteration_failed",
                    pid=os.getpid(),
                    lastError=str(exc),
                    message="Monitor iteration failed; the loop will retry on the next pass.",
                    lastRunAt=(anchor or failed_at).isoformat(),
                )
            iteration += 1
            if max_iterations is not None and iteration >= max_iterations:
                break
            if interval_seconds > 0:
                next_run = datetime.now().astimezone() + timedelta(seconds=interval_seconds)
                from .self_audit import audit_market_agent

                _write_monitor_status(
                    resolved_status_path,
                    running=True,
                    autoStart=True,
                    phase="idle_between_runs",
                    pid=os.getpid(),
                    nextRunAt=next_run.isoformat(),
                    message="Market watch is active; sources keep updating between analysis passes.",
                )
                _write_monitor_status(
                    resolved_status_path,
                    selfAudit=audit_market_agent(config),
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
