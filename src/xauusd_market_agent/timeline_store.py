from __future__ import annotations

from dataclasses import asdict
import json
import sqlite3
from pathlib import Path
from typing import Any

from .models import DriverAttentionState


class TimelineStore:
    def __init__(self, path: Path, calendar_dir: Path | None = None) -> None:
        self.path = Path(path)
        self.calendar_dir = Path(calendar_dir) if calendar_dir is not None else None
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
                    bid_price REAL,
                    ask_price REAL,
                    move_percent REAL,
                    source TEXT,
                    source_type TEXT NOT NULL,
                    data_mode TEXT NOT NULL,
                    is_stale INTEGER NOT NULL DEFAULT 0,
                    stale_reason TEXT NOT NULL DEFAULT '',
                    payload_json TEXT NOT NULL,
                    FOREIGN KEY(monitor_run_id) REFERENCES monitor_runs(id)
                );
                CREATE TABLE IF NOT EXISTS related_asset_bars (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    monitor_run_id INTEGER NOT NULL,
                    symbol TEXT NOT NULL,
                    data_timestamp TEXT NOT NULL,
                    value REAL,
                    change_15m REAL,
                    change_30m REAL,
                    change_60m REAL,
                    change_value REAL,
                    change_unit TEXT NOT NULL,
                    source TEXT,
                    source_type TEXT NOT NULL,
                    data_mode TEXT NOT NULL,
                    is_stale INTEGER NOT NULL DEFAULT 0,
                    stale_reason TEXT NOT NULL DEFAULT '',
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
                CREATE INDEX IF NOT EXISTS idx_monitor_runs_started_at ON monitor_runs(run_started_at);
                CREATE INDEX IF NOT EXISTS idx_market_price_symbol_time ON market_price_bars(symbol, data_timestamp);
                CREATE INDEX IF NOT EXISTS idx_market_price_run ON market_price_bars(monitor_run_id);
                CREATE INDEX IF NOT EXISTS idx_related_asset_symbol_time ON related_asset_bars(symbol, data_timestamp);
                CREATE INDEX IF NOT EXISTS idx_related_asset_run ON related_asset_bars(monitor_run_id);
                CREATE INDEX IF NOT EXISTS idx_news_published_at ON news_items(published_at);
                CREATE INDEX IF NOT EXISTS idx_news_run ON news_items(monitor_run_id);
                CREATE INDEX IF NOT EXISTS idx_calendar_scheduled_at ON calendar_events(scheduled_at);
                CREATE INDEX IF NOT EXISTS idx_calendar_run ON calendar_events(monitor_run_id);
                CREATE INDEX IF NOT EXISTS idx_driver_attention_run ON driver_attention_states(monitor_run_id);
                CREATE INDEX IF NOT EXISTS idx_timeline_event_time ON timeline_events(event_time);
                """
            )

    def _rows_to_payloads(self, rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
        return [json.loads(str(row["payload_json"])) for row in rows]

    def get_last_successful_run_at(self) -> str | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT run_started_at FROM monitor_runs ORDER BY id DESC LIMIT 1"
            ).fetchone()
        return None if row is None else str(row["run_started_at"])

    def get_storage_summary(self) -> dict[str, Any]:
        tables = (
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
        )
        with self._connect() as connection:
            counts = {
                table: int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
                for table in tables
            }
            ranges = {
                "monitorRuns": connection.execute(
                    "SELECT MIN(run_started_at), MAX(run_started_at) FROM monitor_runs"
                ).fetchone(),
                "marketPriceBars": connection.execute(
                    "SELECT MIN(data_timestamp), MAX(data_timestamp) FROM market_price_bars"
                ).fetchone(),
                "relatedAssetBars": connection.execute(
                    "SELECT MIN(data_timestamp), MAX(data_timestamp) FROM related_asset_bars"
                ).fetchone(),
                "newsItems": connection.execute(
                    "SELECT MIN(published_at), MAX(published_at) FROM news_items"
                ).fetchone(),
                "calendarEvents": connection.execute(
                    "SELECT MIN(scheduled_at), MAX(scheduled_at) FROM calendar_events"
                ).fetchone(),
            }
            page_size = int(connection.execute("PRAGMA page_size").fetchone()[0])
            page_count = int(connection.execute("PRAGMA page_count").fetchone()[0])
            freelist_count = int(connection.execute("PRAGMA freelist_count").fetchone()[0])
        file_bytes = self.path.stat().st_size if self.path.exists() else 0
        free_bytes = freelist_count * page_size
        compaction_status = "available" if free_bytes > 1024 * 1024 else "not_needed"
        return {
            "path": str(self.path),
            "databaseBytes": file_bytes,
            "allocatedBytes": page_count * page_size,
            "freeBytes": free_bytes,
            "counts": {
                "monitorRuns": counts["monitor_runs"],
                "providerHealth": counts["provider_health"],
                "marketPriceBars": counts["market_price_bars"],
                "relatedAssetBars": counts["related_asset_bars"],
                "newsItems": counts["news_items"],
                "calendarEvents": counts["calendar_events"],
                "driverAttentionStates": counts["driver_attention_states"],
                "evidencePackets": counts["evidence_packets"],
                "analysisResults": counts["analysis_results"],
                "alerts": counts["alerts"],
                "stateTransitions": counts["state_transitions"],
                "timelineEvents": counts["timeline_events"],
            },
            "ranges": {
                key: {
                    "start": None if row is None else row[0],
                    "end": None if row is None else row[1],
                }
                for key, row in ranges.items()
            },
            "compaction": {
                "status": compaction_status,
                "mode": "indexed_range_reads",
                "detail": (
                    "SQLite keeps raw evidence per monitor run. Replay loads only the selected range; "
                    "VACUUM is only useful when free space grows."
                ),
            },
        }

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
                theme_id=payload.get("theme_id", ""),
                lifecycle=payload.get("lifecycle", ""),
                source_terms=tuple(payload.get("source_terms", [])),
                related_sensor_ids=tuple(payload.get("related_sensor_ids", [])),
                requested_sensor_ids=tuple(payload.get("requested_sensor_ids", [])),
                promotion_reason=payload.get("promotion_reason", ""),
                rejection_reason=payload.get("rejection_reason", ""),
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
        if not provider_health:
            return
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
                    low_price, close_price, bid_price, ask_price, move_percent, source,
                    source_type, data_mode, is_stale, stale_reason, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                        bar.get("bid_price"),
                        bar.get("ask_price"),
                        bar.get("move_percent"),
                        bar.get("source"),
                        bar["source_type"],
                        bar["data_mode"],
                        int(bool(bar.get("is_stale", False))),
                        bar.get("stale_reason", ""),
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
                    monitor_run_id, symbol, data_timestamp, value, change_15m, change_30m,
                    change_60m, change_value, change_unit, source, source_type, data_mode,
                    is_stale, stale_reason, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        monitor_run_id,
                        bar["symbol"],
                        bar["data_timestamp"],
                        bar.get("value"),
                        bar.get("change_15m"),
                        bar.get("change_30m"),
                        bar.get("change_60m"),
                        bar.get("change_value"),
                        bar["change_unit"],
                        bar.get("source"),
                        bar["source_type"],
                        bar["data_mode"],
                        int(bool(bar.get("is_stale", False))),
                        bar.get("stale_reason", ""),
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
                        int(bool(item["is_backfilled"])),
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
        if not states:
            return
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

    @staticmethod
    def _normalized_replay_value(value: Any) -> str:
        return "".join(char if char.isalnum() else "_" for char in str(value or "").strip().lower()).strip("_")

    @classmethod
    def _timeline_impact(cls, row: dict[str, Any]) -> float | None:
        payload = row.get("payload")
        if not isinstance(payload, dict):
            return None
        for value in (
            payload.get("impact_percent"),
            payload.get("segment", {}).get("move_percent") if isinstance(payload.get("segment"), dict) else None,
        ):
            try:
                return float(value)
            except (TypeError, ValueError):
                continue
        return None

    @classmethod
    def _is_month_summary_event(cls, row: dict[str, Any]) -> bool:
        payload = row.get("payload")
        if not isinstance(payload, dict):
            return False
        event_type = cls._normalized_replay_value(row.get("event_type"))
        label = cls._normalized_replay_value(row.get("label"))
        semantic_type = cls._normalized_replay_value(payload.get("semantic_type"))
        driver = cls._normalized_replay_value(payload.get("main_driver") or payload.get("driver"))
        if "recovery" in semantic_type or "recovery" in event_type or "backfill" in label:
            return False
        if not driver or driver in {"unknown", "no_state_change"}:
            return False
        if semantic_type in {"breakout", "reversal"}:
            return True
        if "alert" in event_type:
            impact = cls._timeline_impact(row)
            return True if impact is None else abs(impact) >= 0.2
        impact = cls._timeline_impact(row)
        return False if impact is None else abs(impact) >= 0.35

    @classmethod
    def _month_summary_events(cls, timeline_events: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [row for row in timeline_events if cls._is_month_summary_event(row)]

    def get_price_series(self, symbol: str, start: str, end: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT payload_json
                FROM market_price_bars
                WHERE symbol = ? AND data_timestamp >= ? AND data_timestamp <= ?
                ORDER BY data_timestamp, id
                """,
                (symbol, start, end),
            ).fetchall()
        return self._rows_to_payloads(rows)

    def get_related_asset_series(self, symbol: str, start: str, end: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT payload_json
                FROM related_asset_bars
                WHERE symbol = ? AND data_timestamp >= ? AND data_timestamp <= ?
                ORDER BY data_timestamp, id
                """,
                (symbol, start, end),
            ).fetchall()
        return self._rows_to_payloads(rows)

    def get_news_items(self, start: str, end: str, include_filtered: bool = True) -> list[dict[str, Any]]:
        del include_filtered
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT payload_json
                FROM news_items
                WHERE published_at >= ? AND published_at <= ?
                ORDER BY published_at, id
                """,
                (start, end),
            ).fetchall()
        return self._rows_to_payloads(rows)

    def get_calendar_events(self, start: str, end: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT payload_json
                FROM calendar_events
                WHERE scheduled_at >= ? AND scheduled_at <= ?
                ORDER BY scheduled_at, id
                """,
                (start, end),
            ).fetchall()
        return self._rows_to_payloads(rows)

    def _calendar_dirs(self) -> list[Path]:
        candidates: list[Path] = []
        if self.calendar_dir is not None:
            candidates.append(self.calendar_dir)
        candidates.extend(
            [
                self.path.parent / "data" / "Economic_Calendar",
                self.path.parent.parent / "data" / "Economic_Calendar",
            ]
        )
        unique: list[Path] = []
        for candidate in candidates:
            if candidate.exists() and candidate not in unique:
                unique.append(candidate)
        return unique

    @staticmethod
    def _calendar_text(row: dict[str, Any], key: str) -> str:
        value = row.get(key)
        return "" if value is None else str(value).strip()

    @classmethod
    def _calendar_currency(cls, row: dict[str, Any]) -> str:
        return cls._calendar_text(row, "Cur.") or cls._calendar_text(row, "Currency")

    def _get_existing_calendar_context(self, start: str, end: str) -> list[dict[str, Any]]:
        try:
            start_year = int(start[:4])
            end_year = int(end[:4])
        except ValueError:
            return []
        rows: list[dict[str, Any]] = []
        for calendar_dir in self._calendar_dirs():
            for year in range(start_year, end_year + 1):
                path = calendar_dir / str(year) / f"{year}_calendar.json"
                if not path.exists():
                    continue
                payload = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(payload, list):
                    continue
                for item in payload:
                    if not isinstance(item, dict):
                        continue
                    date = self._calendar_text(item, "Date")
                    time = self._calendar_text(item, "Time")
                    title = self._calendar_text(item, "Event")
                    if not date or not time or not title:
                        continue
                    if time.lower() == "all day":
                        scheduled_at = f"{date}T00:00:00+08:00"
                    elif len(time) == 5:
                        scheduled_at = f"{date}T{time}:00+08:00"
                    else:
                        continue
                    if not (start <= scheduled_at <= end):
                        continue
                    rows.append(
                        {
                            "scheduled_at": scheduled_at,
                            "source": "Economic Calendar",
                            "source_type": "existing_calendar",
                            "title": title,
                            "currency": self._calendar_currency(item),
                            "impact": self._calendar_text(item, "Imp."),
                            "context_type": (
                                "liquidity_context"
                                if self._calendar_text(item, "Imp.").lower() == "holiday"
                                else "calendar_context"
                            ),
                            "actual": self._calendar_text(item, "Actual"),
                            "forecast": self._calendar_text(item, "Forecast"),
                            "previous": self._calendar_text(item, "Previous"),
                            "relevance_reason": "Existing Economic Calendar event. Relevance requires evidence or AI review.",
                            "impact_direction_on_gold": "unknown",
                            "data_mode": "calendar_context",
                            "review_status": "unreviewed_context",
                            "storage_status": "read_from_existing_calendar",
                            "source_path": str(calendar_dir),
                        }
                    )
            if rows:
                break
        return sorted(rows, key=lambda row: str(row.get("scheduled_at", "")))

    def get_driver_attention_timeline(self, start: str, end: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT driver_attention_states.payload_json
                FROM driver_attention_states
                INNER JOIN monitor_runs ON monitor_runs.id = driver_attention_states.monitor_run_id
                WHERE monitor_runs.run_started_at >= ? AND monitor_runs.run_started_at <= ?
                ORDER BY monitor_runs.run_started_at, driver_attention_states.id
                """,
                (start, end),
            ).fetchall()
        return self._rows_to_payloads(rows)

    def get_evidence_for_run(self, monitor_run_id: int) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload_json FROM evidence_packets WHERE monitor_run_id = ? ORDER BY id DESC LIMIT 1",
                (monitor_run_id,),
            ).fetchone()
        return None if row is None else json.loads(str(row["payload_json"]))

    def get_suppressed_alerts(self, start: str, end: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT alerts.payload_json
                FROM alerts
                INNER JOIN monitor_runs ON monitor_runs.id = alerts.monitor_run_id
                WHERE monitor_runs.run_started_at >= ? AND monitor_runs.run_started_at <= ?
                  AND alerts.should_notify = 0
                ORDER BY monitor_runs.run_started_at, alerts.id
                """,
                (start, end),
            ).fetchall()
        return self._rows_to_payloads(rows)

    def get_state_transitions(self, start: str, end: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT state_transitions.payload_json
                FROM state_transitions
                INNER JOIN monitor_runs ON monitor_runs.id = state_transitions.monitor_run_id
                WHERE monitor_runs.run_started_at >= ? AND monitor_runs.run_started_at <= ?
                ORDER BY monitor_runs.run_started_at, state_transitions.id
                """,
                (start, end),
            ).fetchall()
        return self._rows_to_payloads(rows)

    def get_market_replay(self, start: str, end: str) -> dict[str, Any]:
        with self._connect() as connection:
            xau_rows = connection.execute(
                """
                SELECT payload_json
                FROM market_price_bars
                WHERE data_timestamp >= ? AND data_timestamp <= ?
                ORDER BY data_timestamp, id
                """,
                (start, end),
            ).fetchall()
        related_symbols = ("dxy", "us10y", "us2y", "wti", "brent", "vix", "spx", "nasdaq")
        related = {
            symbol: self.get_related_asset_series(symbol, start, end)
            for symbol in related_symbols
        }
        timeline_events = self.get_timeline(start, end)
        calendar_events = self._get_existing_calendar_context(start, end)
        if not calendar_events:
            calendar_events = self.get_calendar_events(start, end)
        return {
            "price_series": self._rows_to_payloads(xau_rows),
            "related_assets": related,
            "news_items": self.get_news_items(start, end),
            "calendar_events": calendar_events,
            "driver_attention_timeline": self.get_driver_attention_timeline(start, end),
            "timeline_events": timeline_events,
            "month_summary_events": self._month_summary_events(timeline_events),
            "state_transitions": self.get_state_transitions(start, end),
            "suppressed_alerts": self.get_suppressed_alerts(start, end),
        }
