from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any


def _load_alert_file_rows(path: Path) -> list[dict[str, Any]]:
    if not Path(path).exists():
        return []
    rows: list[dict[str, Any]] = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        rows.append(json.loads(line))
    return rows


def _text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _nested(mapping: dict[str, Any], *keys: str) -> Any:
    current: Any = mapping
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def _first_text(*values: Any) -> str:
    for value in values:
        text = _text(value)
        if text:
            return text
    return ""


def _set_if_missing(payload: dict[str, Any], key: str, value: Any) -> None:
    if _text(payload.get(key)):
        return
    text = _text(value)
    if text:
        payload[key] = text


def _enrich_alert_payload(payload: dict[str, Any], analysis: dict[str, Any] | None) -> None:
    if not analysis:
        return
    _set_if_missing(
        payload,
        "message",
        _first_text(
            analysis.get("user_message"),
            analysis.get("summary"),
            analysis.get("causal_chain"),
            _nested(analysis, "market_read", "thesis"),
            _nested(analysis, "market_read", "headline"),
        ),
    )
    for key in ("bias", "main_driver", "secondary_driver", "cause_status", "confidence"):
        _set_if_missing(payload, key, analysis.get(key))
    if "analysis" not in payload:
        payload["analysis"] = {
            key: analysis.get(key)
            for key in ("analysis_engine", "llm_status", "summary")
            if analysis.get(key) is not None
        }


def _load_sqlite_alert_rows(path: Path, limit: int) -> list[dict[str, Any]]:
    if not Path(path).exists():
        return []
    connection: sqlite3.Connection | None = None
    try:
        connection = sqlite3.connect(path)
        connection.row_factory = sqlite3.Row
        rows = connection.execute(
            """
            SELECT
                alerts.monitor_run_id,
                monitor_runs.run_started_at,
                alerts.payload_json,
                analysis_results.payload_json AS analysis_payload_json
            FROM alerts
            INNER JOIN monitor_runs ON monitor_runs.id = alerts.monitor_run_id
            LEFT JOIN analysis_results ON analysis_results.id = (
                SELECT latest_analysis.id
                FROM analysis_results AS latest_analysis
                WHERE latest_analysis.monitor_run_id = alerts.monitor_run_id
                ORDER BY latest_analysis.id DESC
                LIMIT 1
            )
            WHERE alerts.should_notify = 1
            ORDER BY monitor_runs.run_started_at DESC, alerts.id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    except sqlite3.Error:
        return []
    finally:
        if connection is not None:
            connection.close()
    payloads: list[dict[str, Any]] = []
    for row in rows:
        try:
            payload = json.loads(str(row["payload_json"]))
        except (TypeError, json.JSONDecodeError):
            continue
        if not isinstance(payload, dict):
            continue
        analysis: dict[str, Any] | None = None
        try:
            analysis_payload = json.loads(str(row["analysis_payload_json"]))
            if isinstance(analysis_payload, dict):
                analysis = analysis_payload
        except (TypeError, json.JSONDecodeError):
            analysis = None
        _enrich_alert_payload(payload, analysis)
        payload.setdefault("monitor_run_id", int(row["monitor_run_id"]))
        payload.setdefault("run_started_at", str(row["run_started_at"]))
        payload.setdefault("time", str(row["run_started_at"]))
        payloads.append(payload)
    return payloads


def _alert_history_key(item: dict[str, Any], fallback_index: int) -> tuple[str, str, str, str]:
    message = str(item.get("message") or "").strip()
    driver = str(item.get("main_driver") or "").strip()
    cause = str(item.get("cause_status") or "").strip()
    level = str(item.get("notification_level") or "").strip()
    if message or driver or cause or level:
        return (
            message.lower(),
            driver.lower(),
            cause.lower(),
            level.lower(),
        )
    return ("row", str(fallback_index), "", "")


def _alert_time(item: dict[str, Any]) -> str:
    return str(item.get("time") or item.get("run_started_at") or "").strip()


def _collapse_alert_repeats(rows: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    sorted_rows = sorted(rows, key=_alert_time, reverse=True)
    collapsed: dict[tuple[str, str, str, str], dict[str, Any]] = {}
    counts: dict[tuple[str, str, str, str], int] = {}
    first_seen: dict[tuple[str, str, str, str], str] = {}
    last_seen: dict[tuple[str, str, str, str], str] = {}
    for index, row in enumerate(sorted_rows):
        key = _alert_history_key(row, index)
        time = _alert_time(row)
        if key not in collapsed:
            collapsed[key] = dict(row)
            counts[key] = 1
            first_seen[key] = time
            last_seen[key] = time
            continue
        counts[key] += 1
        if time:
            first_seen[key] = time
    rows_out: list[dict[str, Any]] = []
    for key, row in collapsed.items():
        repeat_count = counts[key]
        row["repeat_count"] = repeat_count
        row["quiet_repeat_count"] = max(0, repeat_count - 1)
        if first_seen[key]:
            row["first_seen_at"] = first_seen[key]
        if last_seen[key]:
            row["last_seen_at"] = last_seen[key]
        rows_out.append(row)
    return sorted(rows_out, key=_alert_time, reverse=True)[:limit]


def load_alert_history(path: Path, timeline_store_path: Path | None = None, limit: int = 100) -> list[dict[str, Any]]:
    rows = _load_alert_file_rows(path)
    if timeline_store_path is not None:
        rows.extend(_load_sqlite_alert_rows(timeline_store_path, limit))
    return _collapse_alert_repeats(rows, limit)
