from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import errno
import json
import os
import sys
import sqlite3
from pathlib import Path
from typing import Any

from .config import MarketAgentConfig
from .llm_client import LocalLLMConfig
from .timeline_store import (
    DAY_REPLAY_DRIVER_ROWS,
    DAY_REPLAY_RELATED_ROWS_PER_SYMBOL,
    DAY_REPLAY_TIMELINE_ROWS,
    TimelineStore,
)


@dataclass(frozen=True)
class AuditCheck:
    name: str
    status: str
    detail: str

    def to_dict(self) -> dict[str, str]:
        return {"name": self.name, "status": self.status, "detail": self.detail}


def _parse_time(value: Any) -> datetime | None:
    try:
        return datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None


def _latest_json(connection: sqlite3.Connection, table: str) -> tuple[int | None, dict[str, Any]]:
    try:
        row = connection.execute(
            f"SELECT monitor_run_id, payload_json FROM {table} ORDER BY id DESC LIMIT 1"
        ).fetchone()
    except sqlite3.Error:
        return None, {}
    if row is None:
        return None, {}
    try:
        return int(row[0]), json.loads(row[1])
    except (TypeError, ValueError, json.JSONDecodeError):
        return int(row[0]), {}


def _json_for_run(connection: sqlite3.Connection, table: str, monitor_run_id: int | None) -> tuple[int | None, dict[str, Any]]:
    if monitor_run_id is None:
        return None, {}
    try:
        row = connection.execute(
            f"SELECT monitor_run_id, payload_json FROM {table} WHERE monitor_run_id = ? ORDER BY id DESC LIMIT 1",
            (monitor_run_id,),
        ).fetchone()
    except sqlite3.Error:
        return None, {}
    if row is None:
        return None, {}
    try:
        return int(row[0]), json.loads(row[1])
    except (TypeError, ValueError, json.JSONDecodeError):
        return int(row[0]), {}


def _count(connection: sqlite3.Connection, table: str) -> int:
    try:
        return int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
    except sqlite3.Error:
        return 0


def _count_for_run(connection: sqlite3.Connection, table: str, monitor_run_id: int | None) -> int:
    if monitor_run_id is None:
        return 0
    try:
        return int(
            connection.execute(
                f"SELECT COUNT(*) FROM {table} WHERE monitor_run_id = ?",
                (monitor_run_id,),
            ).fetchone()[0]
        )
    except sqlite3.Error:
        return 0


def _table_columns(connection: sqlite3.Connection, table: str) -> set[str]:
    try:
        rows = connection.execute(f"PRAGMA table_info({table})").fetchall()
    except sqlite3.Error:
        return set()
    return {str(row["name"] if isinstance(row, sqlite3.Row) else row[1]) for row in rows}


def _payloads_for_run(connection: sqlite3.Connection, table: str, monitor_run_id: int | None) -> list[dict[str, Any]]:
    if monitor_run_id is None or "payload_json" not in _table_columns(connection, table):
        return []
    try:
        rows = connection.execute(
            f"SELECT payload_json FROM {table} WHERE monitor_run_id = ? ORDER BY id",
            (monitor_run_id,),
        ).fetchall()
    except sqlite3.Error:
        return []
    payloads: list[dict[str, Any]] = []
    for row in rows:
        try:
            payload = json.loads(str(row["payload_json"]))
        except (TypeError, json.JSONDecodeError):
            continue
        if isinstance(payload, dict):
            payloads.append(payload)
    return payloads


def _visible_news_payloads(payloads: list[dict[str, Any]]) -> list[dict[str, Any]]:
    visible: list[dict[str, Any]] = []
    for payload in payloads:
        if payload.get("included") is False:
            continue
        reason = str(payload.get("filter_reason") or payload.get("reason") or "").lower()
        if "no_market_agent_keyword" in reason:
            continue
        visible.append(payload)
    return visible


def _has_local_ai_summary(payload: dict[str, Any]) -> bool:
    return bool(str(payload.get("summary_title") or "").strip()) and str(
        payload.get("summary_source") or payload.get("ai_summary_source") or ""
    ).lower() == "local_ai"


def _alert_suppressed_reason(connection: sqlite3.Connection, monitor_run_id: int | None) -> str:
    if monitor_run_id is None or "alert_suppressed_reason" not in _table_columns(connection, "monitor_runs"):
        return ""
    try:
        value = connection.execute(
            "SELECT alert_suppressed_reason FROM monitor_runs WHERE id = ?",
            (monitor_run_id,),
        ).fetchone()
    except sqlite3.Error:
        return ""
    if value is None:
        return ""
    return str(value["alert_suppressed_reason"] or "").strip()


def _range_end(connection: sqlite3.Connection, table: str, column: str) -> str:
    try:
        value = connection.execute(f"SELECT MAX({column}) FROM {table}").fetchone()[0]
    except sqlite3.Error:
        return ""
    return str(value or "")


def _calendar_dataset_end(calendar_dir: Path, year: int) -> str:
    path = calendar_dir / str(year) / f"{year}_calendar.json"
    if not path.exists():
        return ""
    try:
        rows = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return ""
    dates = [str(row.get("Date", "")) for row in rows if isinstance(row, dict) and row.get("Date")]
    return max(dates) if dates else ""


def _read_monitor_status(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    _normalize_monitor_status(payload)
    return payload


def _normalize_monitor_status(payload: dict[str, Any]) -> None:
    activity = payload.get("activity")
    if not isinstance(activity, dict):
        return
    _normalize_history_activity(activity)
    ctrader = activity.get("ctrader")
    if not isinstance(ctrader, dict):
        return
    provider_health = ctrader.get("providerHealth")
    if not isinstance(provider_health, dict):
        return
    metadata = provider_health.get("metadata")
    metadata = metadata if isinstance(metadata, dict) else {}
    classification = str(metadata.get("stale_classification") or "").lower()
    market_closed = metadata.get("market_closed") is True or classification == "market_closed"
    feed_paused = metadata.get("market_closed") is False or classification == "feed_paused"
    if market_closed or not feed_paused:
        return
    if str(ctrader.get("status") or "").lower() == "market_closed":
        ctrader["status"] = "stale"
    if str(ctrader.get("label") or "").lower() == "market closed":
        ctrader["label"] = "cTrader not refreshing"
    detail = str(ctrader.get("detail") or "")
    if "market reopens" in detail.lower() or "fixed until" in detail.lower():
        price = provider_health.get("current_value")
        try:
            price_text = f"{float(price):,.2f}"
        except (TypeError, ValueError):
            price_text = ""
        ctrader["detail"] = (
            f"Last XAUUSD price {price_text} is stale; cTrader has not produced a fresh live snapshot."
            if price_text
            else "Last XAUUSD price is stale; cTrader has not produced a fresh live snapshot."
        )


def _normalize_history_activity(activity: dict[str, Any]) -> None:
    history = activity.get("history")
    summary = activity.get("summary")
    if not isinstance(history, dict) or not isinstance(summary, dict):
        return
    symbol_rows = summary.get("symbolRows")
    if not isinstance(symbol_rows, dict):
        return
    try:
        xauusd_rows = int(symbol_rows.get("XAUUSD", 0) or 0)
        stored_rows = int(history.get("storedRows", 0) or 0)
    except (TypeError, ValueError):
        return
    sensor_rows = max(0, stored_rows - xauusd_rows)
    history["xauusdRows"] = xauusd_rows
    history["sensorRows"] = sensor_rows
    jobs = history.get("jobs")
    if isinstance(jobs, list):
        for job in jobs:
            if isinstance(job, dict) and str(job.get("title") or "") == "History fetch":
                job["output"] = f"{xauusd_rows} XAUUSD row(s), {sensor_rows} sensor row(s)"
    if xauusd_rows < 2 and str(history.get("status") or "") == "idle":
        history["detail"] = (
            "No backfill gap detected, but current XAUUSD recent history still needs another fresh bar."
        )


def _latest_monitor_run(connection: sqlite3.Connection) -> dict[str, Any]:
    try:
        row = connection.execute(
            "SELECT * FROM monitor_runs ORDER BY id DESC LIMIT 1"
        ).fetchone()
    except sqlite3.Error:
        return {}
    return dict(row) if row is not None else {}


def _latest_auditable_monitor_run(connection: sqlite3.Connection) -> tuple[sqlite3.Row | None, int | None]:
    try:
        rows = connection.execute(
            "SELECT id, run_started_at, data_mode, backfill_required, no_news_found FROM monitor_runs ORDER BY id DESC LIMIT 20"
        ).fetchall()
    except sqlite3.Error:
        return None, None
    if not rows:
        return None, None
    required_tables = ("provider_health", "evidence_packets", "analysis_results", "market_price_bars", "state_transitions")
    for row in rows:
        run_id = int(row["id"])
        if all(_count_for_run(connection, table, run_id) > 0 for table in required_tables):
            latest_id = int(rows[0]["id"])
            return row, latest_id if latest_id != run_id else None
    return rows[0], None


def _latest_payloads_by_key(
    connection: sqlite3.Connection,
    table: str,
    key_column: str,
    monitor_run_id: int | None,
) -> list[dict[str, Any]]:
    if monitor_run_id is None or "payload_json" not in _table_columns(connection, table):
        return []
    try:
        rows = connection.execute(
            f"SELECT {key_column}, payload_json FROM {table} WHERE monitor_run_id = ? ORDER BY id",
            (monitor_run_id,),
        ).fetchall()
    except sqlite3.Error:
        return []
    payloads: list[dict[str, Any]] = []
    for row in rows:
        try:
            payload = json.loads(str(row["payload_json"]))
        except (TypeError, json.JSONDecodeError):
            payload = {}
        if isinstance(payload, dict):
            payloads.append({key_column: row[key_column], **payload})
    return payloads


def read_provider_health_status(config: MarketAgentConfig | None = None) -> dict[str, Any]:
    cfg = config or MarketAgentConfig()
    if not cfg.timeline_store_path.exists():
        return {
            "ok": False,
            "available": False,
            "timeline_store_path": str(cfg.timeline_store_path),
            "run": None,
            "providers": [],
            "message": "Market Agent timeline database is missing.",
        }
    connection = sqlite3.connect(cfg.timeline_store_path)
    try:
        connection.row_factory = sqlite3.Row
        run = _latest_monitor_run(connection)
        run_id = int(run["id"]) if run.get("id") is not None else None
        providers = _latest_payloads_by_key(connection, "provider_health", "provider_key", run_id)
        _, evidence_packet = _latest_json(connection, "evidence_packets")
    finally:
        connection.close()
    evidence_status = evidence_packet.get("evidence_status") if isinstance(evidence_packet, dict) else {}
    evidence_status = evidence_status if isinstance(evidence_status, dict) else {}
    evidence_key_by_provider = {
        "dxy": "dxy",
        "us10y": "us10y",
        "us2y": "us2y",
        "wti": "oil",
        "brent": "oil",
        "vix": "vix_equities",
        "spx": "vix_equities",
        "nasdaq": "vix_equities",
        "news": "news",
    }
    for provider in providers:
        key = str(provider.get("provider_key") or "").lower()
        evidence_key = evidence_key_by_provider.get(key)
        effective_status = str(evidence_status.get(evidence_key) or "").strip()
        if not effective_status:
            stale_reason = str(provider.get("stale_reason") or "").lower()
            if "weekend closed window" in stale_reason or "market is closed" in stale_reason:
                effective_status = "market_closed_context"
            elif provider.get("is_available") is not True:
                effective_status = "unavailable"
            elif provider.get("is_stale") is True:
                effective_status = "stale"
            else:
                effective_status = "fresh"
        provider["effective_status"] = effective_status
        provider["usable_as_context"] = effective_status in {
            "fresh",
            "confirming",
            "confirms",
            "market_closed_context",
            "relevant_news_found",
        }
    return {
        "ok": True,
        "available": bool(run),
        "timeline_store_path": str(cfg.timeline_store_path),
        "run": run or None,
        "providers": providers,
    }


def _sensor_status_for_key(evidence_status: dict[str, Any], key: str) -> str:
    direct = str(evidence_status.get(key, "") or "")
    if direct:
        return direct
    if key in {"wti", "brent"}:
        return str(evidence_status.get("oil", "") or "")
    if key in {"vix", "spx", "nasdaq"}:
        return str(evidence_status.get("vix_equities", "") or "")
    return ""


def _normalize_market_read_coverage(analysis: dict[str, Any], evidence_packet: dict[str, Any]) -> None:
    market_read = analysis.get("market_read")
    if not isinstance(market_read, dict):
        return
    coverage = market_read.get("coverage")
    if not isinstance(coverage, dict):
        return
    sensors = str(coverage.get("sensors", "") or "")
    if "context" in sensors:
        return
    evidence_status = evidence_packet.get("evidence_status")
    if not isinstance(evidence_status, dict):
        return
    sensor_keys = ("dxy", "us10y", "us2y", "wti", "brent", "vix", "spx", "nasdaq")
    context_count = sum(
        1
        for key in sensor_keys
        if _sensor_status_for_key(evidence_status, key).lower() == "market_closed_context"
    )
    if context_count <= 0:
        return
    fresh_count = 0
    for key in sensor_keys:
        if _sensor_status_for_key(evidence_status, key).lower() in {"confirming", "supporting", "accepted"}:
            fresh_count += 1
    coverage["sensors"] = f"{fresh_count} fresh / {context_count} context"


def read_current_status(config: MarketAgentConfig | None = None) -> dict[str, Any]:
    cfg = config or MarketAgentConfig()
    monitor_status = _read_monitor_status(cfg.monitor_status_path)
    if not cfg.timeline_store_path.exists():
        return {
            "ok": False,
            "available": False,
            "timeline_store_path": str(cfg.timeline_store_path),
            "monitor_status": monitor_status,
            "message": "Market Agent timeline database is missing.",
        }
    connection = sqlite3.connect(cfg.timeline_store_path)
    try:
        connection.row_factory = sqlite3.Row
        run = _latest_monitor_run(connection)
        run_id = int(run["id"]) if run.get("id") is not None else None
        _, evidence_packet = _latest_json(connection, "evidence_packets")
        _, analysis = _latest_json(connection, "analysis_results")
        counts = {
            "provider_health": _count_for_run(connection, "provider_health", run_id),
            "price": _count_for_run(connection, "market_price_bars", run_id),
            "news": _count_for_run(connection, "news_items", run_id),
            "calendar": _count_for_run(connection, "calendar_events", run_id),
            "timeline": _count_for_run(connection, "timeline_events", run_id),
            "alerts": _count_for_run(connection, "alerts", run_id),
        }
    finally:
        connection.close()
    chain = evidence_packet.get("evidence_chain_status") if isinstance(evidence_packet, dict) else {}
    chain = chain if isinstance(chain, dict) else {}
    analysis_payload = dict(analysis) if isinstance(analysis, dict) else {}
    evidence_payload = evidence_packet if isinstance(evidence_packet, dict) else {}
    _normalize_market_read_coverage(analysis_payload, evidence_payload)
    return {
        "ok": True,
        "available": bool(run),
        "timeline_store_path": str(cfg.timeline_store_path),
        "monitor_status": monitor_status,
        "run": run or None,
        "evidence_chain_status": chain,
        "evidence_status": evidence_packet.get("evidence_status") if isinstance(evidence_packet, dict) else {},
        "analysis": {
            key: analysis_payload.get(key)
            for key in (
                "analysis_engine",
                "llm_status",
                "bias",
                "main_driver",
                "cause_status",
                "confidence",
                "summary",
                "user_message",
                "should_notify",
                "notification_level",
                "market_read",
            )
            if key in analysis_payload
        },
        "storage_counts": counts,
    }


def _pid_is_alive(pid_value: Any) -> bool | None:
    try:
        pid = int(pid_value)
    except (TypeError, ValueError):
        return None
    if pid <= 0:
        return None
    if sys.platform == "win32":
        try:
            import ctypes
            from ctypes import wintypes

            process_query_limited_information = 0x1000
            still_active = 259
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
            if not handle:
                return False
            try:
                exit_code = wintypes.DWORD()
                if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                    return None
                return int(exit_code.value) == still_active
            finally:
                kernel32.CloseHandle(handle)
        except Exception:
            return None
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError as exc:
        if exc.errno in {errno.ESRCH, errno.EINVAL}:
            return False
        return None
    return True


def audit_market_agent(config: MarketAgentConfig | None = None, *, now: datetime | None = None) -> dict[str, Any]:
    cfg = config or MarketAgentConfig()
    anchor = now or datetime.now().astimezone()
    checks: list[AuditCheck] = []
    monitor_status = _read_monitor_status(cfg.monitor_status_path)
    if monitor_status:
        running = monitor_status.get("running") is True
        phase = str(monitor_status.get("phase") or "unknown")
        auto_start = monitor_status.get("autoStart") is True
        next_run_at = monitor_status.get("nextRunAt") or "--"
        last_run_at = monitor_status.get("lastRunAt") or monitor_status.get("latestStoredRunAt") or "--"
        next_run_time = _parse_time(next_run_at)
        interval_seconds = monitor_status.get("intervalSeconds")
        interval_seconds = interval_seconds if isinstance(interval_seconds, (int, float)) else 60
        next_run_overdue = (
            next_run_time is not None
            and phase in {"already_running", "idle_between_runs"}
            and (anchor - next_run_time).total_seconds() > max(90, float(interval_seconds) * 2)
        )
        pid_value = monitor_status.get("pid") or monitor_status.get("monitorOwnerPid")
        has_pid = pid_value is not None
        pid_alive = _pid_is_alive(pid_value)
        if running:
            if pid_alive is False:
                checks.append(
                    AuditCheck(
                        "monitor_loop",
                        "warn",
                        f"Monitor status claims running, but pid={pid_value} is not alive; phase={phase}.",
                    )
                )
            elif next_run_overdue:
                checks.append(
                    AuditCheck(
                        "monitor_loop",
                        "warn",
                        f"Monitor status claims running, but next_run={next_run_at} is overdue; phase={phase}.",
                    )
                )
            elif phase in {"already_running", "idle_between_runs"} and not has_pid:
                checks.append(
                    AuditCheck(
                        "monitor_loop",
                        "warn",
                        f"Monitor status claims running, but no monitor process id is recorded; phase={phase}.",
                    )
                )
            else:
                if phase in {"already_running", "idle_between_runs"}:
                    detail = f"Monitor loop is running; phase={phase}, next_run={next_run_at}."
                else:
                    detail = f"Monitor loop is running; phase={phase}, current pass is active."
                checks.append(
                    AuditCheck(
                        "monitor_loop",
                        "pass",
                        detail,
                    )
                )
        else:
            auto_start_detail = "auto-start expected" if auto_start else "auto-start disabled"
            checks.append(
                AuditCheck(
                    "monitor_loop",
                    "warn",
                    f"Monitor loop is stopped; phase={phase}, last_run={last_run_at}, {auto_start_detail}.",
                )
            )
    path = cfg.timeline_store_path
    if not path.exists():
        return {
            "status": "action_required",
            "checked_at": anchor.isoformat(),
            "summary": "Market Agent timeline database is missing.",
            "checks": [AuditCheck("timeline_store", "fail", f"Missing {path}").to_dict()],
        }

    connection = sqlite3.connect(path)
    try:
        connection.row_factory = sqlite3.Row
        latest_run, skipped_newer_run_id = _latest_auditable_monitor_run(connection)
        latest_run_id: int | None = None
        if latest_run is None:
            checks.append(AuditCheck("monitor_runs", "fail", "No monitor run has been stored."))
        else:
            latest_run_id = int(latest_run["id"])
            run_time = _parse_time(latest_run["run_started_at"])
            age_minutes = (
                (anchor - run_time).total_seconds() / 60 if run_time is not None else 1_000_000.0
            )
            status = "pass" if age_minutes <= 5 else "warn"
            checks.append(
                AuditCheck(
                    "latest_run",
                    status,
                    (
                        f"Run {latest_run['id']} at {latest_run['run_started_at']} mode={latest_run['data_mode']}."
                        + (
                            f" Audit skipped newer incomplete run {skipped_newer_run_id}."
                            if skipped_newer_run_id is not None
                            else ""
                        )
                    ),
                )
            )

        evidence_run_id, packet = _json_for_run(connection, "evidence_packets", latest_run_id)
        provider_health = packet.get("provider_health") if isinstance(packet, dict) else {}
        provider_health = provider_health if isinstance(provider_health, dict) else {}
        xauusd_health = provider_health.get("xauusd") if isinstance(provider_health, dict) else {}
        xauusd_health = xauusd_health if isinstance(xauusd_health, dict) else {}
        xauusd_metadata = xauusd_health.get("metadata") if isinstance(xauusd_health.get("metadata"), dict) else {}
        xauusd_market_closed = (
            xauusd_metadata.get("market_closed") is True
            or str(xauusd_metadata.get("stale_classification", "")).lower() == "market_closed"
            or "weekend closed window" in str(xauusd_health.get("stale_reason", "")).lower()
        )
        chain = packet.get("evidence_chain_status") if isinstance(packet, dict) else {}
        chain = chain if isinstance(chain, dict) else {}
        missing = chain.get("missing_required") if isinstance(chain.get("missing_required"), list) else []
        can_show = chain.get("can_show_current_conclusion") is not False
        if can_show:
            checks.append(AuditCheck("evidence_gate", "pass", "Current conclusion inputs are usable."))
        elif "live_xauusd_spot" in missing and xauusd_market_closed:
            checks.append(
                AuditCheck(
                    "evidence_gate",
                    "pass",
                    "XAUUSD market is closed; news, calendar, and context continue while the next trade read waits for fresh price action.",
                )
            )
        elif "live_xauusd_spot" in missing:
            checks.append(
                AuditCheck(
                    "evidence_gate",
                    "warn",
                    "Live XAUUSD is missing; news/calendar can still update context, but no current market conclusion is shown.",
                )
            )
        else:
            checks.append(AuditCheck("evidence_gate", "warn", f"Evidence gate is context-only: {missing}."))

        calendar_health = provider_health.get("calendar") if isinstance(provider_health, dict) else {}
        calendar_health = calendar_health if isinstance(calendar_health, dict) else {}
        calendar_dir = Path(str(calendar_health.get("metadata", {}).get("calendar_dir") or cfg.calendar_dir))
        dataset_end = _calendar_dataset_end(calendar_dir, anchor.year)
        calendar_source_healthy = bool(dataset_end and dataset_end >= anchor.date().isoformat())
        if calendar_source_healthy:
            checks.append(AuditCheck("calendar_source", "pass", f"Calendar dataset reaches {dataset_end}."))
        else:
            checks.append(
                AuditCheck(
                    "calendar_source",
                    "fail",
                    f"Calendar dataset does not reach today; dir={calendar_dir}, end={dataset_end or 'unknown'}.",
                )
            )

        calendar_rows = len(packet.get("calendar_events") or []) if isinstance(packet, dict) else 0
        if calendar_rows:
            checks.append(AuditCheck("calendar_context", "pass", f"{calendar_rows} calendar event(s) in current window."))
        elif calendar_source_healthy:
            checks.append(AuditCheck("calendar_context", "pass", "Calendar source is current; no event is scheduled in this evidence window."))
        else:
            checks.append(AuditCheck("calendar_context", "warn", "No calendar event in current evidence window."))

        news_rows = len(packet.get("news") or []) if isinstance(packet, dict) else 0
        checks.append(
            AuditCheck(
                "news_context",
                "pass" if news_rows else "warn",
                f"{news_rows} relevant headline(s) in current window.",
            )
        )

        analysis_run_id, analysis = _json_for_run(connection, "analysis_results", latest_run_id)
        llm_config = LocalLLMConfig()
        if analysis:
            llm_enabled = llm_config.enabled
            analysis_engine = str(analysis.get("analysis_engine", "unknown"))
            llm_status = str(analysis.get("llm_status", "unknown"))
            if llm_enabled and analysis_engine != "llm_validated":
                checks.append(
                    AuditCheck(
                        "ai_or_rule_analysis",
                        "warn",
                        f"Run {analysis_run_id}: Local AI is enabled but latest result is {analysis_engine} / {llm_status}.",
                    )
                )
            else:
                checks.append(
                    AuditCheck(
                        "ai_or_rule_analysis",
                        "pass",
                        f"Run {analysis_run_id}: {analysis_engine} / {llm_status}.",
                    )
                )
        else:
            checks.append(
                AuditCheck("ai_or_rule_analysis", "fail", "No analysis result stored.")
            )

        if llm_config.enabled and llm_config.display_summary_enabled:
            visible_news = _visible_news_payloads(_payloads_for_run(connection, "news_items", latest_run_id))
            summarized_news = [item for item in visible_news if _has_local_ai_summary(item)]
            if visible_news:
                status = "pass" if len(summarized_news) == len(visible_news) else "warn"
                checks.append(
                    AuditCheck(
                        "display_summaries",
                        status,
                        (
                            f"{len(summarized_news)}/{len(visible_news)} visible news item(s) have Local AI "
                            "short titles stored for the current run."
                        ),
                    )
                )
            else:
                checks.append(
                    AuditCheck(
                        "display_summaries",
                        "pass",
                        "Display summary is enabled; no visible news item needs a Local AI short title in the current run.",
                    )
                )

        storage_counts = {
            "market_price_bars": _count(connection, "market_price_bars"),
            "news_items": _count(connection, "news_items"),
            "calendar_events": _count(connection, "calendar_events"),
            "timeline_events": _count(connection, "timeline_events"),
        }
        current_counts = {
            "provider_health": _count_for_run(connection, "provider_health", latest_run_id),
            "evidence_packets": _count_for_run(connection, "evidence_packets", latest_run_id),
            "analysis_results": _count_for_run(connection, "analysis_results", latest_run_id),
            "market_price_bars": _count_for_run(connection, "market_price_bars", latest_run_id),
            "news_items": _count_for_run(connection, "news_items", latest_run_id),
            "calendar_events": _count_for_run(connection, "calendar_events", latest_run_id),
            "state_transitions": _count_for_run(connection, "state_transitions", latest_run_id),
            "timeline_events": _count_for_run(connection, "timeline_events", latest_run_id),
            "alerts": _count_for_run(connection, "alerts", latest_run_id),
        }
        notification_trace_supported = "alert_suppressed_reason" in _table_columns(connection, "monitor_runs")
        notification_reason = _alert_suppressed_reason(connection, latest_run_id) if notification_trace_supported else ""
        alert_decision_trace = (
            "alert_row"
            if current_counts["alerts"] > 0
            else "suppressed_reason"
            if notification_reason
            else "missing"
        )
        required_current = ("provider_health", "evidence_packets", "analysis_results", "market_price_bars", "state_transitions")
        missing_current = [key for key in required_current if current_counts[key] == 0]
        packet_news_count = len(packet.get("news") or []) if isinstance(packet, dict) else 0
        packet_calendar_count = len(packet.get("calendar_events") or []) if isinstance(packet, dict) else 0
        context_mismatch: list[str] = []
        if packet_news_count and current_counts["news_items"] == 0:
            context_mismatch.append("news_items")
        if packet_calendar_count and current_counts["calendar_events"] == 0:
            context_mismatch.append("calendar_events")
        if missing_current:
            checks.append(
                AuditCheck(
                    "current_run_storage",
                    "fail",
                    f"Run {latest_run_id} is missing required stored artifact(s): {', '.join(missing_current)}.",
                )
            )
        elif context_mismatch:
            checks.append(
                AuditCheck(
                    "current_run_storage",
                    "warn",
                    f"Run {latest_run_id} packet has context that was not stored in: {', '.join(context_mismatch)}.",
                )
            )
        else:
            checks.append(
                AuditCheck(
                    "current_run_storage",
                    "pass",
                    (
                        f"Run {latest_run_id} stored provider={current_counts['provider_health']}, "
                        f"price={current_counts['market_price_bars']}, news={current_counts['news_items']}, "
                        f"calendar={current_counts['calendar_events']}, timeline={current_counts['timeline_events']}, "
                        f"alerts={current_counts['alerts']}, alert_decision={alert_decision_trace}."
                    ),
                )
            )
        if notification_trace_supported:
            if current_counts["alerts"] > 0:
                checks.append(
                    AuditCheck(
                        "notification_decision",
                        "pass",
                        f"Run {latest_run_id} stored {current_counts['alerts']} alert audit record(s).",
                    )
                )
            elif notification_reason:
                checks.append(
                    AuditCheck(
                        "notification_decision",
                        "pass",
                        f"No alert sent for run {latest_run_id}: {notification_reason}",
                    )
                )
            else:
                checks.append(
                    AuditCheck(
                        "notification_decision",
                        "warn",
                        f"Run {latest_run_id} has no alert audit row and no alert suppression reason.",
                    )
                )
        replay_ok = current_counts["market_price_bars"] > 0 and storage_counts["market_price_bars"] > 0
        checks.append(
            AuditCheck(
                "replay_storage",
                "pass" if replay_ok else "fail",
                (
                    f"current_run price={current_counts['market_price_bars']}, timeline={current_counts['timeline_events']}; "
                    f"total timeline={storage_counts['timeline_events']}, price={storage_counts['market_price_bars']}, "
                    f"news={storage_counts['news_items']}, calendar={storage_counts['calendar_events']}."
                ),
            )
        )
        latest_run_time = _parse_time(latest_run["run_started_at"]) if latest_run is not None else None
        replay_shape_supported = (
            {"symbol", "data_timestamp", "payload_json"}.issubset(_table_columns(connection, "market_price_bars"))
            and {"symbol", "data_timestamp", "payload_json"}.issubset(_table_columns(connection, "related_asset_bars"))
            and {"event_time", "event_type", "label", "payload_json"}.issubset(_table_columns(connection, "timeline_events"))
            and "payload_json" in _table_columns(connection, "driver_attention_states")
        )
        if latest_run_time is not None and replay_shape_supported:
            day_start = latest_run_time.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
            day_end = latest_run_time.replace(hour=23, minute=59, second=59, microsecond=0).isoformat()
            try:
                replay = TimelineStore(path, calendar_dir=cfg.calendar_dir).get_market_replay(day_start, day_end)
                related_count = sum(len(rows) for rows in replay.get("related_assets", {}).values() if isinstance(rows, list))
                timeline_count = len(replay.get("timeline_events") or [])
                driver_count = len(replay.get("driver_attention_timeline") or [])
                related_budget = DAY_REPLAY_RELATED_ROWS_PER_SYMBOL * 8
                oversized = (
                    related_count > related_budget
                    or timeline_count > DAY_REPLAY_TIMELINE_ROWS
                    or driver_count > DAY_REPLAY_DRIVER_ROWS
                )
                checks.append(
                    AuditCheck(
                        "replay_query_shape",
                        "warn" if oversized else "pass",
                        (
                            f"Day replay payload rows: related={related_count}, "
                            f"timeline={timeline_count}, driver_attention={driver_count}."
                        ),
                    )
                )
            except Exception as exc:
                checks.append(
                    AuditCheck(
                        "replay_query_shape",
                        "warn",
                        f"Could not verify day replay payload shape: {exc}",
                    )
                )

        latest_timeline = _range_end(connection, "timeline_events", "event_time")
    finally:
        connection.close()

    fail_count = sum(1 for check in checks if check.status == "fail")
    warn_count = sum(1 for check in checks if check.status == "warn")
    status = "action_required" if fail_count else "degraded" if warn_count else "healthy"
    monitor_loop_check = next((check for check in checks if check.name == "monitor_loop"), None)
    if status == "healthy":
        summary = "Market Agent is collecting price, news, calendar, analysis, and replay data."
    elif monitor_loop_check is not None and monitor_loop_check.status == "warn":
        summary = "Market Agent monitor loop is stopped; stored context is available, but automatic updates are not running."
    elif status == "degraded":
        summary = "Market Agent is running with partial inputs; context still updates while current market conclusions wait for required live evidence."
    else:
        summary = "Market Agent has a broken required input and needs attention."
    return {
        "status": status,
        "checked_at": anchor.isoformat(),
        "summary": summary,
        "latest_evidence_run_id": evidence_run_id,
        "latest_timeline_event_at": latest_timeline,
        "checks": [check.to_dict() for check in checks],
    }
