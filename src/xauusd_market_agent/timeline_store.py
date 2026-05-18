from __future__ import annotations

from dataclasses import asdict
import json
import sqlite3
from pathlib import Path
from typing import Any

from .models import DriverAttentionState


class TimelineStore:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        return connection

    def _init_schema(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS monitor_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_started_at TEXT NOT NULL,
                    run_type TEXT NOT NULL,
                    data_mode TEXT NOT NULL,
                    backfill_required INTEGER NOT NULL DEFAULT 0,
                    last_successful_run_at TEXT,
                    no_news_found INTEGER NOT NULL DEFAULT 0,
                    alert_suppressed_reason TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS provider_health (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    provider_key TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    FOREIGN KEY(monitor_run_id) REFERENCES monitor_runs(id)
                );
                CREATE TABLE IF NOT EXISTS market_price_bars (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    symbol TEXT NOT NULL,
                    data_timestamp TEXT NOT NULL,
                    open_price REAL,
                    high_price REAL,
                    low_price REAL,
                    close_price REAL NOT NULL,
                    move_percent REAL,
                    data_mode TEXT NOT NULL,
                    source_type TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    FOREIGN KEY(monitor_run_id) REFERENCES monitor_runs(id)
                );
                CREATE TABLE IF NOT EXISTS related_asset_bars (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    symbol TEXT NOT NULL,
                    data_timestamp TEXT NOT NULL,
                    change_value REAL NOT NULL,
                    change_unit TEXT NOT NULL,
                    data_mode TEXT NOT NULL,
                    source_type TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    FOREIGN KEY(monitor_run_id) REFERENCES monitor_runs(id)
                );
                CREATE TABLE IF NOT EXISTS news_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    published_at TEXT NOT NULL,
                    first_seen_at TEXT NOT NULL,
                    backfilled_at TEXT,
                    is_backfilled INTEGER NOT NULL,
                    source TEXT NOT NULL,
                    title TEXT NOT NULL,
                    link TEXT,
                    relevance_reason TEXT NOT NULL,
                    impact_direction_on_gold TEXT NOT NULL,
                    data_mode TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    FOREIGN KEY(monitor_run_id) REFERENCES monitor_runs(id)
                );
                CREATE TABLE IF NOT EXISTS calendar_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    scheduled_at TEXT NOT NULL,
                    source TEXT NOT NULL,
                    title TEXT NOT NULL,
                    relevance_reason TEXT NOT NULL,
                    impact_direction_on_gold TEXT NOT NULL,
                    data_mode TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    FOREIGN KEY(monitor_run_id) REFERENCES monitor_runs(id)
                );
                CREATE TABLE IF NOT EXISTS driver_attention_states (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    driver_id TEXT NOT NULL,
                    current_state TEXT NOT NULL,
                    priority TEXT NOT NULL,
                    relevance_score REAL NOT NULL,
                    confidence TEXT NOT NULL,
                    activation_reason TEXT,
                    deactivation_reason TEXT,
                    first_activated_at TEXT,
                    last_confirmed_at TEXT,
                    decay_deadline TEXT,
                    evidence_summary_json TEXT NOT NULL,
                    counter_evidence_json TEXT NOT NULL,
                    data_mode TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    FOREIGN KEY(monitor_run_id) REFERENCES monitor_runs(id)
                );
                CREATE TABLE IF NOT EXISTS evidence_packets (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    payload_json TEXT NOT NULL,
                    FOREIGN KEY(monitor_run_id) REFERENCES monitor_runs(id)
                );
                CREATE TABLE IF NOT EXISTS analysis_results (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    payload_json TEXT NOT NULL,
                    rejected_driver TEXT,
                    rejection_reason TEXT,
                    FOREIGN KEY(monitor_run_id) REFERENCES monitor_runs(id)
                );
                CREATE TABLE IF NOT EXISTS alerts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    should_notify INTEGER NOT NULL,
                    notification_level TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    FOREIGN KEY(monitor_run_id) REFERENCES monitor_runs(id)
                );
                CREATE TABLE IF NOT EXISTS state_transitions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    payload_json TEXT NOT NULL,
                    FOREIGN KEY(monitor_run_id) REFERENCES monitor_runs(id)
                );
                CREATE TABLE IF NOT EXISTS timeline_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    event_time TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    label TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    FOREIGN KEY(monitor_run_id) REFERENCES monitor_runs(id)
                );
                """
            )

    def get_last_successful_run_at(self) -> str | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT run_started_at FROM monitor_runs ORDER BY id DESC LIMIT 1"
            ).fetchone()
        return None if row is None else str(row["run_started_at"])

    def load_latest_driver_attention_states(self) -> dict[str, DriverAttentionState]:
        with self._connect() as connection:
            run_row = connection.execute(
                "SELECT id FROM monitor_runs ORDER BY id DESC LIMIT 1"
            ).fetchone()
            if run_row is None:
                return {}
            rows = connection.execute(
                "SELECT payload_json FROM driver_attention_states WHERE monitor_run_id = ?",
                (int(run_row["id"]),),
            ).fetchall()
        states: dict[str, DriverAttentionState] = {}
        for row in rows:
            payload = json.loads(str(row["payload_json"]))
            states[payload["driver_id"]] = DriverAttentionState(
                driver_id=payload["driver_id"],
                label=payload["label"],
                category=payload["category"],
                current_state=payload["current_state"],
                priority=payload["priority"],
                relevance_score=float(payload["relevance_score"]),
                activation_reason=payload["activation_reason"],
                deactivation_reason=payload["deactivation_reason"],
                first_activated_at=payload["first_activated_at"],
                last_confirmed_at=payload["last_confirmed_at"],
                last_evidence_at=payload["last_evidence_at"],
                decay_deadline=payload["decay_deadline"],
                linked_assets=tuple(payload["linked_assets"]),
                required_evidence_gates=tuple(payload["required_evidence_gates"]),
                optional_evidence_gates=tuple(payload["optional_evidence_gates"]),
                current_evidence_summary=payload["current_evidence_summary"],
                current_counter_evidence=payload["current_counter_evidence"],
                confidence=payload["confidence"],
                source_count=int(payload["source_count"]),
                related_news_count=int(payload["related_news_count"]),
                related_calendar_events=int(payload["related_calendar_events"]),
                notes=payload["notes"],
                data_mode=payload["data_mode"],
            )
        return states

    def record_monitor_run(
        self,
        *,
        run_started_at: str,
        run_type: str,
        data_mode: str,
        backfill_required: bool,
        last_successful_run_at: str | None,
        no_news_found: bool,
        alert_suppressed_reason: str,
    ) -> int:
        with self._connect() as connection:
            cursor = connection.execute(
                """
                INSERT INTO monitor_runs (
                    run_started_at, run_type, data_mode, backfill_required,
                    last_successful_run_at, no_news_found, alert_suppressed_reason, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_started_at,
                    run_type,
                    data_mode,
                    int(backfill_required),
                    last_successful_run_at,
                    int(no_news_found),
                    alert_suppressed_reason,
                    run_started_at,
                ),
            )
            connection.commit()
            return int(cursor.lastrowid)

    def record_provider_health(self, monitor_run_id: int, provider_health: dict[str, Any]) -> None:
        with self._connect() as connection:
            connection.executemany(
                "INSERT INTO provider_health (monitor_run_id, provider_key, payload_json) VALUES (?, ?, ?)",
                [
                    (monitor_run_id, key, json.dumps(value, ensure_ascii=False))
                    for key, value in provider_health.items()
                ],
            )
            connection.commit()

    def record_market_price_bars(self, monitor_run_id: int, bars: list[dict[str, Any]]) -> None:
        if not bars:
            return
        with self._connect() as connection:
            connection.executemany(
                """
                INSERT INTO market_price_bars (
                    monitor_run_id, symbol, data_timestamp, open_price, high_price,
                    low_price, close_price, move_percent, data_mode, source_type, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        monitor_run_id,
                        bar["symbol"],
                        bar["data_timestamp"],
                        bar.get("open_price"),
                        bar.get("high_price"),
                        bar.get("low_price"),
                        bar["close_price"],
                        bar.get("move_percent"),
                        bar["data_mode"],
                        bar["source_type"],
                        json.dumps(bar, ensure_ascii=False),
                    )
                    for bar in bars
                ],
            )
            connection.commit()

    def record_related_asset_bars(self, monitor_run_id: int, bars: list[dict[str, Any]]) -> None:
        if not bars:
            return
        with self._connect() as connection:
            connection.executemany(
                """
                INSERT INTO related_asset_bars (
                    monitor_run_id, symbol, data_timestamp, change_value, change_unit, data_mode, source_type, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        monitor_run_id,
                        bar["symbol"],
                        bar["data_timestamp"],
                        bar["change_value"],
                        bar["change_unit"],
                        bar["data_mode"],
                        bar["source_type"],
                        json.dumps(bar, ensure_ascii=False),
                    )
                    for bar in bars
                ],
            )
            connection.commit()

    def record_news_items(self, monitor_run_id: int, items: list[dict[str, Any]]) -> None:
        if not items:
            return
        with self._connect() as connection:
            connection.executemany(
                """
                INSERT INTO news_items (
                    monitor_run_id, published_at, first_seen_at, backfilled_at, is_backfilled,
                    source, title, link, relevance_reason, impact_direction_on_gold, data_mode, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        monitor_run_id,
                        item["published_at"],
                        item["first_seen_at"],
                        item.get("backfilled_at"),
                        int(item["is_backfilled"]),
                        item["source"],
                        item["title"],
                        item.get("link"),
                        item["relevance_reason"],
                        item["impact_direction_on_gold"],
                        item["data_mode"],
                        json.dumps(item, ensure_ascii=False),
                    )
                    for item in items
                ],
            )
            connection.commit()

    def record_calendar_events(self, monitor_run_id: int, items: list[dict[str, Any]]) -> None:
        if not items:
            return
        with self._connect() as connection:
            connection.executemany(
                """
                INSERT INTO calendar_events (
                    monitor_run_id, scheduled_at, source, title, relevance_reason,
                    impact_direction_on_gold, data_mode, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        monitor_run_id,
                        item["scheduled_at"],
                        item["source"],
                        item["title"],
                        item["relevance_reason"],
                        item["impact_direction_on_gold"],
                        item["data_mode"],
                        json.dumps(item, ensure_ascii=False),
                    )
                    for item in items
                ],
            )
            connection.commit()

    def record_driver_attention_states(self, monitor_run_id: int, states: dict[str, Any]) -> None:
        with self._connect() as connection:
            connection.executemany(
                """
                INSERT INTO driver_attention_states (
                    monitor_run_id, driver_id, current_state, priority, relevance_score, confidence,
                    activation_reason, deactivation_reason, first_activated_at, last_confirmed_at,
                    decay_deadline, evidence_summary_json, counter_evidence_json, data_mode, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        monitor_run_id,
                        driver_id,
                        payload["current_state"],
                        payload["priority"],
                        float(payload["relevance_score"]),
                        payload["confidence"],
                        payload["activation_reason"],
                        payload["deactivation_reason"],
                        payload["first_activated_at"],
                        payload["last_confirmed_at"],
                        payload["decay_deadline"],
                        json.dumps({"summary": payload["current_evidence_summary"]}, ensure_ascii=False),
                        json.dumps({"counter": payload["current_counter_evidence"]}, ensure_ascii=False),
                        payload["data_mode"],
                        json.dumps(payload, ensure_ascii=False),
                    )
                    for driver_id, payload in states.items()
                ],
            )
            connection.commit()

    def record_evidence_packet(self, monitor_run_id: int, payload: dict[str, Any]) -> None:
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO evidence_packets (monitor_run_id, payload_json) VALUES (?, ?)",
                (monitor_run_id, json.dumps(payload, ensure_ascii=False)),
            )
            connection.commit()

    def record_analysis_result(
        self,
        monitor_run_id: int,
        payload: dict[str, Any],
        *,
        rejected_driver: str | None = None,
        rejection_reason: str | None = None,
    ) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO analysis_results (monitor_run_id, payload_json, rejected_driver, rejection_reason)
                VALUES (?, ?, ?, ?)
                """,
                (monitor_run_id, json.dumps(payload, ensure_ascii=False), rejected_driver, rejection_reason),
            )
            connection.commit()

    def record_alert(self, monitor_run_id: int, notification: dict[str, Any]) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO alerts (monitor_run_id, should_notify, notification_level, reason, payload_json)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    monitor_run_id,
                    int(notification["should_notify"]),
                    notification["notification_level"],
                    notification["reason"],
                    json.dumps(notification, ensure_ascii=False),
                ),
            )
            connection.commit()

    def record_state_transition(self, monitor_run_id: int, payload: dict[str, Any]) -> None:
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO state_transitions (monitor_run_id, payload_json) VALUES (?, ?)",
                (monitor_run_id, json.dumps(payload, ensure_ascii=False)),
            )
            connection.commit()

    def record_timeline_event(
        self,
        monitor_run_id: int,
        *,
        event_time: str,
        event_type: str,
        label: str,
        payload: dict[str, Any],
    ) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO timeline_events (monitor_run_id, event_time, event_type, label, payload_json)
                VALUES (?, ?, ?, ?, ?)
                """,
                (monitor_run_id, event_time, event_type, label, json.dumps(payload, ensure_ascii=False)),
            )
            connection.commit()

    def get_timeline(self, start: str, end: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT event_time, event_type, label, payload_json
                FROM timeline_events
                WHERE event_time >= ? AND event_time <= ?
                ORDER BY event_time, id
                """,
                (start, end),
            ).fetchall()
        return [
            {
                "event_time": str(row["event_time"]),
                "event_type": str(row["event_type"]),
                "label": str(row["label"]),
                "payload": json.loads(str(row["payload_json"])),
            }
            for row in rows
        ]
