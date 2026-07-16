from __future__ import annotations

from dataclasses import asdict
from datetime import datetime, timedelta, timezone
import json
import math
import re
import sqlite3
from pathlib import Path
from typing import Any

from .models import DriverAttentionState
from .providers.calendar_events import is_market_agent_calendar_row

DAY_REPLAY_TIMELINE_ROWS = 240
DAY_REPLAY_NEWS_ROWS = 360
DAY_REPLAY_RELATED_ROWS_PER_SYMBOL = 180
DAY_REPLAY_DRIVER_ROWS = 120
DAY_REPLAY_STATE_ROWS = 120
DAY_REPLAY_ALERT_ROWS = 80
MONTH_REPLAY_PRICE_ROWS = 5000
MONTH_REPLAY_RELATED_ROWS_PER_SYMBOL = 180
MONTH_REPLAY_NEWS_ROWS = 360
MONTH_REPLAY_TIMELINE_ROWS = 600
MONTH_REPLAY_DRIVER_ROWS = 600
MONTH_REPLAY_STATE_ROWS = 240
MONTH_REPLAY_ALERT_ROWS = 200
STORAGE_AUTO_CLEANUP_INTERVAL_HOURS = 6
STORAGE_AUTO_CLEANUP_MIN_BYTES = 1024 * 1024 * 1024
STORAGE_DEFAULT_RETENTION_DAYS = 45
STORAGE_AI_RETENTION_DAYS = 21


class TimelineStore:
    def __init__(self, path: Path, calendar_dir: Path | None = None) -> None:
        self.path = Path(path)
        self.calendar_dir = Path(calendar_dir) if calendar_dir is not None else None
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._try_enable_wal()
        self._init_schema()

    def _try_enable_wal(self) -> None:
        try:
            with sqlite3.connect(self.path, timeout=1.0) as connection:
                connection.execute("PRAGMA busy_timeout = 1000")
                connection.execute("PRAGMA journal_mode = WAL")
                connection.execute("PRAGMA synchronous = NORMAL")
        except sqlite3.OperationalError:
            return

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 30000")
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
                CREATE TABLE IF NOT EXISTS storage_maintenance_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    started_at TEXT NOT NULL,
                    finished_at TEXT,
                    reason TEXT NOT NULL,
                    before_bytes INTEGER NOT NULL,
                    after_bytes INTEGER,
                    rows_deleted INTEGER NOT NULL DEFAULT 0,
                    vacuumed INTEGER NOT NULL DEFAULT 0,
                    payload_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_monitor_runs_started_at ON monitor_runs(run_started_at);
                CREATE INDEX IF NOT EXISTS idx_market_price_symbol_time ON market_price_bars(symbol, data_timestamp);
                CREATE INDEX IF NOT EXISTS idx_market_price_run ON market_price_bars(monitor_run_id);
                CREATE INDEX IF NOT EXISTS idx_related_asset_symbol_time ON related_asset_bars(symbol, data_timestamp);
                CREATE INDEX IF NOT EXISTS idx_related_asset_dedupe
                    ON related_asset_bars(symbol, data_timestamp, source, source_type);
                CREATE INDEX IF NOT EXISTS idx_related_asset_run ON related_asset_bars(monitor_run_id);
                CREATE INDEX IF NOT EXISTS idx_news_published_at ON news_items(published_at);
                CREATE INDEX IF NOT EXISTS idx_news_dedupe ON news_items(source, title, link, published_at);
                CREATE INDEX IF NOT EXISTS idx_news_run ON news_items(monitor_run_id);
                CREATE INDEX IF NOT EXISTS idx_calendar_scheduled_at ON calendar_events(scheduled_at);
                CREATE INDEX IF NOT EXISTS idx_calendar_dedupe ON calendar_events(scheduled_at, source, title);
                CREATE INDEX IF NOT EXISTS idx_calendar_run ON calendar_events(monitor_run_id);
                CREATE INDEX IF NOT EXISTS idx_driver_attention_run ON driver_attention_states(monitor_run_id);
                CREATE INDEX IF NOT EXISTS idx_driver_attention_driver_run ON driver_attention_states(driver_id, monitor_run_id);
                CREATE INDEX IF NOT EXISTS idx_state_transitions_run ON state_transitions(monitor_run_id);
                CREATE INDEX IF NOT EXISTS idx_alerts_run ON alerts(monitor_run_id);
                CREATE INDEX IF NOT EXISTS idx_timeline_event_time ON timeline_events(event_time);
                """
            )

    def _rows_to_payloads(self, rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
        return [json.loads(str(row["payload_json"])) for row in rows]

    @staticmethod
    def _chunked(values: list[Any], size: int = 500) -> list[list[Any]]:
        return [values[index : index + size] for index in range(0, len(values), size)]

    @staticmethod
    def _dedupe_text(value: Any) -> str:
        return " ".join(str(value or "").strip().split())

    @classmethod
    def _related_asset_storage_key(cls, item: dict[str, Any]) -> tuple[str, str, str, str]:
        return (
            cls._dedupe_text(item.get("symbol")).lower(),
            cls._dedupe_text(item.get("data_timestamp")),
            cls._dedupe_text(item.get("source")).lower(),
            cls._dedupe_text(item.get("source_type")).lower(),
        )

    @classmethod
    def _news_storage_key(cls, item: dict[str, Any]) -> tuple[str, str, str, str]:
        return (
            cls._dedupe_text(item.get("source")).lower(),
            cls._dedupe_text(item.get("title")).lower(),
            cls._dedupe_text(item.get("link")).lower(),
            cls._dedupe_text(item.get("published_at")),
        )

    @classmethod
    def _calendar_storage_key(cls, item: dict[str, Any]) -> tuple[str, str, str]:
        return (
            cls._dedupe_text(item.get("scheduled_at")),
            cls._dedupe_text(item.get("source")).lower(),
            cls._dedupe_text(item.get("title")).lower(),
        )

    @staticmethod
    def _driver_state_storage_key(driver_id: str, payload: dict[str, Any]) -> tuple[Any, ...]:
        return (
            driver_id,
            payload.get("current_state"),
            payload.get("priority"),
            payload.get("relevance_score"),
            payload.get("confidence"),
            payload.get("activation_reason"),
            payload.get("deactivation_reason"),
            payload.get("first_activated_at"),
            payload.get("last_confirmed_at"),
            payload.get("decay_deadline"),
            json.dumps(payload.get("current_evidence_summary", []), sort_keys=True, ensure_ascii=False),
            json.dumps(payload.get("current_counter_evidence", []), sort_keys=True, ensure_ascii=False),
            payload.get("data_mode"),
        )

    @staticmethod
    def _repair_display_text(value: Any) -> Any:
        if not isinstance(value, str) or "\ufffd" not in value:
            return value
        text = re.sub(r"(?<=[A-Za-z])\ufffd(?=[A-Za-z])", "'", value)
        text = re.sub(r"\s+\ufffd\s+", " - ", text)
        text = text.replace("\ufffd", "'")
        return " ".join(text.split())

    @classmethod
    def _repair_news_display_fields(cls, item: dict[str, Any]) -> dict[str, Any]:
        repaired = dict(item)
        for key in ("title", "summary_title", "summary", "short_summary", "preview", "description", "source"):
            if key in repaired:
                repaired[key] = cls._repair_display_text(repaired[key])
        title = str(repaired.get("title") or "")
        summary_title = str(repaired.get("summary_title") or "")
        if summary_title and not cls._is_complete_market_news_title(summary_title) and cls._is_complete_market_news_title(title):
            repaired.pop("summary_title", None)
        return repaired

    _MARKET_TITLE_VERBS = re.compile(
        r"\b("
        r"is|are|was|were|be|being|been|will|would|could|should|may|might|can|"
        r"says|said|warns|warned|signals|signaled|announces|announced|expects|expected|"
        r"hits|hit|jumps|jumped|falls|fell|drops|dropped|slips|slipped|rises|rose|"
        r"surges|surged|eases|eased|extends|extended|keep|keeps|kept|weighs|weighed|"
        r"drives|drove|pressure|pressures|pressured|opens|opened|closes|closed|cuts|cut|"
        r"raises|raised|denies|denied|confirms|confirmed|threatens|threatened|"
        r"disrupts|disrupted|sanctions|sanctioned|lifts|lifted|pushes|pushed|"
        r"leaves|left|returns|returned"
        r")\b",
        re.IGNORECASE,
    )

    @classmethod
    def _is_complete_market_news_title(cls, value: Any) -> bool:
        text = str(value or "").strip()
        if not text:
            return False
        words = re.findall(r"[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?", text)
        if len(words) >= 7:
            return True
        if len(words) < 5:
            return False
        return bool(cls._MARKET_TITLE_VERBS.search(text))

    @staticmethod
    def _normalize_news_key_part(value: Any) -> str:
        return " ".join(str(value or "").strip().casefold().split())

    _NEWS_FINGERPRINT_STOPWORDS = {
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "for",
        "from",
        "in",
        "into",
        "is",
        "it",
        "its",
        "just",
        "more",
        "of",
        "on",
        "over",
        "report",
        "s",
        "says",
        "than",
        "that",
        "the",
        "their",
        "to",
        "with",
    }

    _NEWS_TOKEN_STEMS = {
        "loses": "lose",
        "losing": "lose",
        "lost": "lose",
        "falls": "fall",
        "fell": "fall",
        "falling": "fall",
        "jumps": "jump",
        "jumped": "jump",
        "jumping": "jump",
        "rises": "rise",
        "rose": "rise",
        "rising": "rise",
        "extends": "extend",
        "extended": "extend",
        "extending": "extend",
        "changes": "change",
        "changed": "change",
        "changing": "change",
        "announces": "announce",
        "announced": "announce",
        "announcing": "announce",
    }

    @classmethod
    def _news_story_fingerprint(cls, value: Any) -> str:
        text = cls._normalize_news_key_part(value)
        if not text:
            return ""
        text = text.replace("short-seller", "short seller")
        tokens = re.findall(r"[a-z0-9]+", text)
        normalized: list[str] = []
        for token in tokens:
            token = cls._NEWS_TOKEN_STEMS.get(token, token)
            if token in cls._NEWS_FINGERPRINT_STOPWORDS:
                continue
            normalized.append(token)
        if len(normalized) < 5:
            return ""
        return " ".join(normalized[:14])

    @classmethod
    def _news_dedupe_key(cls, item: dict[str, Any], fallback_index: int) -> tuple[str, str, str, str]:
        title = cls._normalize_news_key_part(item.get("title") or item.get("summary_title"))
        story = cls._news_story_fingerprint(item.get("title") or item.get("summary_title"))
        source = cls._normalize_news_key_part(item.get("source"))
        published_at = str(item.get("published_at") or "").strip()
        link = cls._normalize_news_key_part(item.get("link"))
        if not title and not link:
            return ("row", str(fallback_index), "", "")
        if story:
            return ("story", story, source, "")
        if title and (source or link):
            return (title, source, link, "")
        return (title, source, published_at, link)

    @staticmethod
    def _parse_timestamp(value: Any) -> datetime | None:
        if not isinstance(value, str) or not value.strip():
            return None
        text = value.strip()
        if text.endswith("Z"):
            text = f"{text[:-1]}+00:00"
        if "." in text:
            head, tail = text.split(".", 1)
            fraction = []
            rest_start = 0
            for index, char in enumerate(tail):
                if not char.isdigit():
                    rest_start = index
                    break
                fraction.append(char)
            else:
                rest_start = len(tail)
            if len(fraction) > 6:
                text = f"{head}.{''.join(fraction[:6])}{tail[rest_start:]}"
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)

    @classmethod
    def _range_variants(cls, start: str, end: str) -> tuple[tuple[str, str], ...]:
        variants: list[tuple[str, str]] = [(start, end)]
        start_dt = cls._parse_timestamp(start)
        end_dt = cls._parse_timestamp(end)
        if start_dt is not None and end_dt is not None:
            myt = timezone(timedelta(hours=8))
            variants.extend(
                [
                    (start_dt.isoformat(timespec="seconds"), end_dt.isoformat(timespec="seconds")),
                    (
                        start_dt.astimezone(myt).isoformat(timespec="seconds"),
                        end_dt.astimezone(myt).isoformat(timespec="seconds"),
                    ),
                ]
            )
        deduped: list[tuple[str, str]] = []
        seen: set[tuple[str, str]] = set()
        for item in variants:
            if item in seen:
                continue
            seen.add(item)
            deduped.append(item)
        return tuple(deduped)

    @classmethod
    def _range_where(cls, column: str, start: str, end: str) -> tuple[str, tuple[str, ...]]:
        return (
            f"""(
                (
                    julianday({column}) IS NOT NULL
                    AND julianday({column}) >= julianday(?)
                    AND julianday({column}) <= julianday(?)
                )
                OR (
                    julianday({column}) IS NULL
                    AND {column} >= ?
                    AND {column} <= ?
                )
            )""",
            (start, end, start, end),
        )

    @classmethod
    def _timestamp_score(cls, value: Any) -> tuple[int, float, str]:
        parsed = cls._parse_timestamp(value)
        if parsed is None:
            return (0, 0.0, str(value or ""))
        return (1, parsed.timestamp(), str(value or ""))

    @classmethod
    def _news_seen_at(cls, item: dict[str, Any]) -> str:
        for key in ("fetched_at", "last_seen_at", "first_seen_at", "backfilled_at", "published_at"):
            value = item.get(key)
            if value is not None and str(value).strip():
                return str(value).strip()
        return ""

    @classmethod
    def _news_first_seen_at(cls, item: dict[str, Any]) -> str:
        for key in ("first_seen_at", "backfilled_at", "published_at"):
            value = item.get(key)
            if value is not None and str(value).strip():
                return str(value).strip()
        return ""

    @classmethod
    def _news_item_preference(cls, item: dict[str, Any]) -> tuple[int, int, int, float, str]:
        has_summary = any(
            str(item.get(key) or "").strip()
            for key in ("summary", "short_summary", "summary_source", "ai_summary_source")
        )
        review_status = str(item.get("review_status") or "").casefold()
        included = item.get("included") is True or "included" in review_status
        seen_score = cls._timestamp_score(cls._news_seen_at(item))
        return (1 if has_summary else 0, 1 if included else 0, seen_score[0], seen_score[1], seen_score[2])

    @classmethod
    def _dedupe_news_items(cls, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        groups: dict[tuple[str, str, str, str], list[dict[str, Any]]] = {}
        order: list[tuple[str, str, str, str]] = []
        for index, item in enumerate(items):
            key = cls._news_dedupe_key(item, index)
            if key not in groups:
                groups[key] = []
                order.append(key)
            groups[key].append(item)

        merged_items: list[dict[str, Any]] = []
        for key in order:
            group = groups[key]
            best = dict(max(group, key=cls._news_item_preference))
            first_seen_pairs = [
                (cls._timestamp_score(cls._news_first_seen_at(item)), cls._news_first_seen_at(item))
                for item in group
            ]
            valid_first_seen_pairs = [pair for pair in first_seen_pairs if pair[1]]
            seen_pairs = [(cls._timestamp_score(cls._news_seen_at(item)), cls._news_seen_at(item)) for item in group]
            valid_seen_pairs = [pair for pair in seen_pairs if pair[1]]
            first_seen_at = min(valid_first_seen_pairs, key=lambda pair: pair[0])[1] if valid_first_seen_pairs else ""
            last_seen_at = max(valid_seen_pairs, key=lambda pair: pair[0])[1] if valid_seen_pairs else ""
            monitor_run_ids = sorted(
                {
                    int(run_id)
                    for item in group
                    for run_id in [
                        item.get("monitor_run_id"),
                        *(
                            item.get("monitor_run_ids", [])
                            if isinstance(item.get("monitor_run_ids"), list)
                            else []
                        ),
                    ]
                    if isinstance(run_id, int)
                }
            )
            storage_row_ids = sorted(
                {
                    int(row_id)
                    for item in group
                    for row_id in [item.get("storage_row_id")]
                    if isinstance(row_id, int)
                }
            )
            if first_seen_at:
                best["first_seen_at"] = first_seen_at
            if last_seen_at:
                best["last_seen_at"] = last_seen_at
                best["fetched_at"] = last_seen_at
            seen_count = sum(max(1, int(item.get("seen_count") or 1)) for item in group)
            best["seen_count"] = seen_count
            best["duplicate_count"] = max(0, seen_count - 1)
            if monitor_run_ids:
                best["monitor_run_ids"] = monitor_run_ids
            if storage_row_ids:
                best["storage_row_ids"] = storage_row_ids
            merged_items.append(best)
        return merged_items

    def get_last_successful_run_at(self) -> str | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT run_started_at
                FROM monitor_runs
                ORDER BY julianday(run_started_at) DESC, run_started_at DESC, id DESC
                LIMIT 1
                """
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

    def _delete_duplicate_rows(
        self,
        connection: sqlite3.Connection,
        *,
        table: str,
        group_expression: str,
    ) -> int:
        before = int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        connection.execute(
            f"""
            DELETE FROM {table}
            WHERE id NOT IN (
                SELECT MAX(id)
                FROM {table}
                GROUP BY {group_expression}
            )
            """
        )
        after = int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        return max(0, before - after)

    def run_storage_cleanup(
        self,
        *,
        reason: str = "manual",
        retention_days: int = STORAGE_DEFAULT_RETENTION_DAYS,
        ai_retention_days: int = STORAGE_AI_RETENTION_DAYS,
        vacuum: bool = False,
    ) -> dict[str, Any]:
        started_at = datetime.now(timezone.utc).isoformat()
        before_bytes = self.path.stat().st_size if self.path.exists() else 0
        deleted: dict[str, int] = {}
        with self._connect() as connection:
            maintenance_id = int(
                connection.execute(
                    """
                    INSERT INTO storage_maintenance_runs (
                        started_at, reason, before_bytes, payload_json
                    ) VALUES (?, ?, ?, ?)
                    """,
                    (
                        started_at,
                        reason,
                        before_bytes,
                        json.dumps(
                            {
                                "retention_days": retention_days,
                                "ai_retention_days": ai_retention_days,
                            },
                            ensure_ascii=False,
                        ),
                    ),
                ).lastrowid
            )
            deleted["related_asset_bars_duplicates"] = self._delete_duplicate_rows(
                connection,
                table="related_asset_bars",
                group_expression="symbol, data_timestamp, COALESCE(source, ''), source_type",
            )
            deleted["news_items_duplicates"] = self._delete_duplicate_rows(
                connection,
                table="news_items",
                group_expression="source, title, COALESCE(link, ''), published_at",
            )
            deleted["calendar_events_duplicates"] = self._delete_duplicate_rows(
                connection,
                table="calendar_events",
                group_expression="scheduled_at, source, title",
            )
            deleted["market_price_bars_duplicates"] = self._delete_duplicate_rows(
                connection,
                table="market_price_bars",
                group_expression="symbol, data_timestamp, COALESCE(source, ''), source_type",
            )
            deleted["driver_attention_state_duplicates"] = self._delete_duplicate_rows(
                connection,
                table="driver_attention_states",
                group_expression=(
                    "driver_id, current_state, priority, relevance_score, confidence, "
                    "COALESCE(activation_reason, ''), COALESCE(deactivation_reason, ''), "
                    "COALESCE(first_activated_at, ''), COALESCE(last_confirmed_at, ''), "
                    "COALESCE(decay_deadline, ''), evidence_summary_json, counter_evidence_json, "
                    "data_mode, payload_json"
                ),
            )

            cutoff = (datetime.now(timezone.utc) - timedelta(days=max(1, retention_days))).isoformat()
            ai_cutoff = (datetime.now(timezone.utc) - timedelta(days=max(1, ai_retention_days))).isoformat()

            run_ids = [
                int(row["id"])
                for row in connection.execute(
                    "SELECT id FROM monitor_runs WHERE julianday(run_started_at) < julianday(?)",
                    (cutoff,),
                ).fetchall()
            ]
            ai_run_ids = [
                int(row["id"])
                for row in connection.execute(
                    """
                    SELECT id
                    FROM monitor_runs
                    WHERE julianday(run_started_at) < julianday(?)
                      AND julianday(run_started_at) >= julianday(?)
                    """,
                    (ai_cutoff, cutoff),
                ).fetchall()
            ]

            for table in (
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
            ):
                deleted[f"{table}_expired"] = self._delete_rows_for_run_ids(connection, table, run_ids)

            for table in ("evidence_packets", "analysis_results", "state_transitions"):
                deleted[f"{table}_ai_expired"] = self._delete_rows_for_run_ids(connection, table, ai_run_ids)

            deleted["monitor_runs_expired"] = self._delete_rows_for_run_ids(connection, "monitor_runs", run_ids)
            total_deleted = sum(deleted.values())
            connection.execute(
                """
                UPDATE storage_maintenance_runs
                SET finished_at = ?, rows_deleted = ?, payload_json = ?
                WHERE id = ?
                """,
                (
                    datetime.now(timezone.utc).isoformat(),
                    total_deleted,
                    json.dumps({"deleted": deleted}, ensure_ascii=False),
                    maintenance_id,
                ),
            )
            connection.commit()

        vacuumed = False
        if vacuum:
            with self._connect() as connection:
                free_pages = int(connection.execute("PRAGMA freelist_count").fetchone()[0])
            if free_pages > 1024:
                with sqlite3.connect(self.path, timeout=120.0) as connection:
                    connection.execute("VACUUM")
                vacuumed = True

        after_bytes = self.path.stat().st_size if self.path.exists() else 0
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE storage_maintenance_runs
                SET after_bytes = ?, vacuumed = ?
                WHERE id = ?
                """,
                (after_bytes, int(vacuumed), maintenance_id),
            )
            connection.commit()
        return {
            "reason": reason,
            "before_bytes": before_bytes,
            "after_bytes": after_bytes,
            "rows_deleted": sum(deleted.values()),
            "deleted": deleted,
            "vacuumed": vacuumed,
        }

    def _delete_rows_for_run_ids(self, connection: sqlite3.Connection, table: str, run_ids: list[int]) -> int:
        if not run_ids:
            return 0
        column = "id" if table == "monitor_runs" else "monitor_run_id"
        deleted = 0
        for chunk in self._chunked(run_ids):
            placeholders = ",".join("?" for _ in chunk)
            before_changes = connection.total_changes
            connection.execute(f"DELETE FROM {table} WHERE {column} IN ({placeholders})", chunk)
            deleted += connection.total_changes - before_changes
        return deleted

    def maybe_run_storage_cleanup(self) -> dict[str, Any] | None:
        if not self.path.exists() or self.path.stat().st_size < STORAGE_AUTO_CLEANUP_MIN_BYTES:
            return None
        with self._connect() as connection:
            row = connection.execute(
                "SELECT finished_at FROM storage_maintenance_runs ORDER BY id DESC LIMIT 1"
            ).fetchone()
        if row is not None and row["finished_at"]:
            try:
                last = datetime.fromisoformat(str(row["finished_at"]).replace("Z", "+00:00"))
                if datetime.now(timezone.utc) - last < timedelta(hours=STORAGE_AUTO_CLEANUP_INTERVAL_HOURS):
                    return None
            except ValueError:
                pass
        return self.run_storage_cleanup(reason="auto", vacuum=False)

    def get_recent_market_price_bars(
        self,
        *,
        symbol: str,
        anchor_time: datetime,
        lookback_minutes: int = 30,
        limit: int = 120,
    ) -> list[dict[str, Any]]:
        anchor_utc = anchor_time if anchor_time.tzinfo is not None else anchor_time.replace(tzinfo=timezone.utc)
        anchor_utc = anchor_utc.astimezone(timezone.utc)
        start_utc = anchor_utc - timedelta(minutes=lookback_minutes)
        normalized_symbol = str(symbol or "").upper()
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT payload_json
                FROM market_price_bars
                WHERE UPPER(symbol) = ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (normalized_symbol, int(limit)),
            ).fetchall()

        by_timestamp: dict[str, dict[str, Any]] = {}
        for row in rows:
            payload = json.loads(str(row["payload_json"]))
            timestamp = self._parse_timestamp(payload.get("data_timestamp"))
            if timestamp is None or timestamp < start_utc or timestamp > anchor_utc:
                continue
            key = str(payload.get("data_timestamp") or timestamp.isoformat())
            by_timestamp[key] = payload
        return sorted(
            by_timestamp.values(),
            key=lambda item: self._parse_timestamp(item.get("data_timestamp")) or datetime.min.replace(tzinfo=timezone.utc),
        )

    def load_latest_driver_attention_states(self) -> dict[str, DriverAttentionState]:
        with self._connect() as connection:
            run_row = connection.execute(
                """
                SELECT id
                FROM monitor_runs
                ORDER BY julianday(run_started_at) DESC, run_started_at DESC, id DESC
                LIMIT 1
                """
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
        unique_bars: list[dict[str, Any]] = []
        seen_keys: set[tuple[str, str, str, str]] = set()
        for bar in bars:
            key = self._related_asset_storage_key(bar)
            if key in seen_keys:
                continue
            seen_keys.add(key)
            unique_bars.append(bar)
        with self._connect() as connection:
            timestamps = sorted({bar["data_timestamp"] for bar in unique_bars})
            existing_keys: set[tuple[str, str, str, str]] = set()
            for chunk in self._chunked(timestamps):
                placeholders = ",".join("?" for _ in chunk)
                rows = connection.execute(
                    f"""
                    SELECT symbol, data_timestamp, source, source_type
                    FROM related_asset_bars
                    WHERE data_timestamp IN ({placeholders})
                    """,
                    chunk,
                ).fetchall()
                for row in rows:
                    existing_keys.add(
                        (
                            self._dedupe_text(row["symbol"]).lower(),
                            self._dedupe_text(row["data_timestamp"]),
                            self._dedupe_text(row["source"]).lower(),
                            self._dedupe_text(row["source_type"]).lower(),
                        )
                    )
            insert_bars = [bar for bar in unique_bars if self._related_asset_storage_key(bar) not in existing_keys]
            if not insert_bars:
                return
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
                    for bar in insert_bars
                ],
            )
            connection.commit()

    def record_news_items(self, monitor_run_id: int, items: list[dict[str, Any]]) -> None:
        if not items:
            return
        unique_items: list[dict[str, Any]] = []
        seen_keys: set[tuple[str, str, str, str]] = set()
        for item in items:
            key = self._news_storage_key(item)
            if key in seen_keys:
                continue
            seen_keys.add(key)
            unique_items.append(item)
        with self._connect() as connection:
            existing_keys: set[tuple[str, str, str, str]] = set()
            for item in unique_items:
                row = connection.execute(
                    """
                    SELECT id, payload_json
                    FROM news_items
                    WHERE source = ?
                      AND title = ?
                      AND COALESCE(link, '') = ?
                      AND published_at = ?
                    LIMIT 1
                    """,
                    (
                        item["source"],
                        item["title"],
                        item.get("link") or "",
                        item["published_at"],
                    ),
                ).fetchone()
                if row is not None:
                    existing_keys.add(self._news_storage_key(item))
                    try:
                        existing_payload = json.loads(str(row["payload_json"]))
                    except json.JSONDecodeError:
                        existing_payload = {}
                    if not isinstance(existing_payload, dict):
                        existing_payload = {}
                    previous_seen = max(1, int(existing_payload.get("seen_count") or 1))
                    incoming_seen = max(1, int(item.get("seen_count") or 1))
                    merged_payload = dict(existing_payload)
                    if not merged_payload.get("summary") and item.get("summary"):
                        merged_payload["summary"] = item.get("summary")
                    if not merged_payload.get("summary_source") and item.get("summary_source"):
                        merged_payload["summary_source"] = item.get("summary_source")
                    if not merged_payload.get("filter_reason") and item.get("filter_reason"):
                        merged_payload["filter_reason"] = item.get("filter_reason")
                    first_seen_values = [
                        value
                        for value in (
                            merged_payload.get("first_seen_at"),
                            item.get("first_seen_at"),
                        )
                        if value
                    ]
                    last_seen_values = [
                        value
                        for value in (
                            merged_payload.get("last_seen_at"),
                            merged_payload.get("first_seen_at"),
                            item.get("last_seen_at"),
                            item.get("first_seen_at"),
                        )
                        if value
                    ]
                    if first_seen_values:
                        merged_payload["first_seen_at"] = min(str(value) for value in first_seen_values)
                    if last_seen_values:
                        merged_payload["last_seen_at"] = max(str(value) for value in last_seen_values)
                    run_ids = {
                        int(run_id)
                        for run_id in [
                            *(
                                existing_payload.get("monitor_run_ids", [])
                                if isinstance(existing_payload.get("monitor_run_ids"), list)
                                else []
                            ),
                            existing_payload.get("monitor_run_id"),
                            monitor_run_id,
                        ]
                        if isinstance(run_id, int)
                    }
                    if run_ids:
                        merged_payload["monitor_run_ids"] = sorted(run_ids)
                    merged_payload["seen_count"] = previous_seen + incoming_seen
                    merged_payload["duplicate_count"] = max(0, int(merged_payload["seen_count"]) - 1)
                    connection.execute(
                        """
                        UPDATE news_items
                        SET first_seen_at = ?, payload_json = ?
                        WHERE id = ?
                        """,
                        (
                            merged_payload.get("first_seen_at") or existing_payload.get("first_seen_at") or item["first_seen_at"],
                            json.dumps(merged_payload, ensure_ascii=False),
                            row["id"],
                        ),
                    )
            insert_items = [item for item in unique_items if self._news_storage_key(item) not in existing_keys]
            if not insert_items:
                return
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
                    for item in insert_items
                ],
            )
            connection.commit()

    def record_calendar_events(self, monitor_run_id: int, items: list[dict[str, Any]]) -> None:
        if not items:
            return
        unique_items: list[dict[str, Any]] = []
        seen_keys: set[tuple[str, str, str]] = set()
        for item in items:
            key = self._calendar_storage_key(item)
            if key in seen_keys:
                continue
            seen_keys.add(key)
            unique_items.append(item)
        with self._connect() as connection:
            existing_keys: set[tuple[str, str, str]] = set()
            for item in unique_items:
                row = connection.execute(
                    """
                    SELECT 1
                    FROM calendar_events
                    WHERE scheduled_at = ? AND source = ? AND title = ?
                    LIMIT 1
                    """,
                    (item["scheduled_at"], item["source"], item["title"]),
                ).fetchone()
                if row is not None:
                    existing_keys.add(self._calendar_storage_key(item))
            insert_items = [item for item in unique_items if self._calendar_storage_key(item) not in existing_keys]
            if not insert_items:
                return
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
                    for item in insert_items
                ],
            )
            connection.commit()

    def record_driver_attention_states(self, monitor_run_id: int, states: dict[str, Any]) -> None:
        if not states:
            return
        unique_states: dict[str, dict[str, Any]] = {}
        seen_state_keys: set[tuple[Any, ...]] = set()
        for driver_id, payload in states.items():
            key = self._driver_state_storage_key(driver_id, payload)
            if key in seen_state_keys:
                continue
            seen_state_keys.add(key)
            unique_states[driver_id] = payload
        with self._connect() as connection:
            insert_states: dict[str, dict[str, Any]] = {}
            for driver_id, payload in unique_states.items():
                row = connection.execute(
                    """
                    SELECT payload_json
                    FROM driver_attention_states
                    WHERE driver_id = ?
                    ORDER BY monitor_run_id DESC, id DESC
                    LIMIT 1
                    """,
                    (driver_id,),
                ).fetchone()
                if row is not None:
                    try:
                        previous = json.loads(str(row["payload_json"]))
                    except json.JSONDecodeError:
                        previous = None
                    if isinstance(previous, dict) and self._driver_state_storage_key(driver_id, previous) == self._driver_state_storage_key(driver_id, payload):
                        continue
                insert_states[driver_id] = payload
            if not insert_states:
                return
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
                    for driver_id, payload in insert_states.items()
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

    def record_alert(self, monitor_run_id: int, notification: dict[str, Any]) -> int:
        with self._connect() as connection:
            cursor = connection.execute(
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
            return int(cursor.lastrowid)

    def update_alert(self, alert_id: int, notification: dict[str, Any]) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE alerts
                SET should_notify = ?, notification_level = ?, reason = ?, payload_json = ?
                WHERE id = ?
                """,
                (
                    int(notification["should_notify"]),
                    notification["notification_level"],
                    notification["reason"],
                    json.dumps(notification, ensure_ascii=False),
                    alert_id,
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

    @staticmethod
    def _context_review_replay_signature(payload: dict[str, Any]) -> str:
        analysis = payload.get("analysis") if isinstance(payload.get("analysis"), dict) else {}
        signature = {
            "semantic_type": payload.get("semantic_type"),
            "trade_conclusion": payload.get("trade_conclusion"),
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
            "confidence": analysis.get("confidence"),
            "analysis_engine": analysis.get("analysis_engine"),
        }
        return json.dumps(signature, ensure_ascii=False, sort_keys=True)

    @classmethod
    def _dedupe_timeline_events(cls, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        deduped: list[dict[str, Any]] = []
        seen_context_reviews: set[str] = set()
        for row in rows:
            payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
            event_type = str(row.get("event_type") or "")
            label = str(row.get("label") or "")
            semantic_type = str(payload.get("semantic_type") or "") if isinstance(payload, dict) else ""
            if event_type == "context_review" and label == "market_context" and semantic_type == "context_review":
                signature = cls._context_review_replay_signature(payload)
                if signature in seen_context_reviews:
                    continue
                seen_context_reviews.add(signature)
            deduped.append(row)
        return deduped

    def get_latest_timeline_event(
        self,
        *,
        event_type: str,
        label: str,
    ) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT monitor_run_id, event_time, event_type, label, payload_json
                FROM timeline_events
                WHERE event_type = ? AND label = ?
                ORDER BY julianday(event_time) DESC, event_time DESC, id DESC
                LIMIT 1
                """,
                (event_type, label),
            ).fetchone()
        if row is None:
            return None
        return {
            "monitor_run_id": int(row["monitor_run_id"]),
            "event_time": str(row["event_time"]),
            "event_type": str(row["event_type"]),
            "label": str(row["label"]),
            "payload": json.loads(str(row["payload_json"])),
        }

    def get_timeline(self, start: str, end: str, max_points: int | None = None) -> list[dict[str, Any]]:
        where_sql, where_params = self._range_where("event_time", start, end)
        with self._connect() as connection:
            if max_points is not None and max_points > 0:
                rows = connection.execute(
                    f"""
                    SELECT event_time, event_type, label, payload_json
                    FROM timeline_events
                    WHERE {where_sql}
                    ORDER BY event_time DESC, id DESC
                    LIMIT ?
                    """,
                    (*where_params, max_points),
                ).fetchall()
                rows = list(reversed(rows))
            else:
                rows = connection.execute(
                    f"""
                    SELECT event_time, event_type, label, payload_json
                    FROM timeline_events
                    WHERE {where_sql}
                    ORDER BY event_time, id
                    """,
                    where_params,
                ).fetchall()
        payloads = [
            {
                "event_time": str(row["event_time"]),
                "event_type": str(row["event_type"]),
                "label": str(row["label"]),
                "payload": json.loads(str(row["payload_json"])),
            }
            for row in rows
        ]
        return self._dedupe_timeline_events(payloads)

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
        rows: list[dict[str, Any]] = []
        seen: set[tuple[str, str, str, str, str]] = set()
        for row in timeline_events:
            if not cls._is_month_summary_event(row):
                continue
            payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
            assert isinstance(payload, dict)
            parsed_time = cls._parse_timestamp(row.get("event_time"))
            time_key = parsed_time.isoformat(timespec="minutes") if parsed_time is not None else str(row.get("event_time", ""))
            impact = cls._timeline_impact(row)
            key = (
                time_key,
                cls._normalized_replay_value(row.get("label")),
                cls._normalized_replay_value(payload.get("semantic_type")),
                cls._normalized_replay_value(payload.get("main_driver") or payload.get("driver")),
                "" if impact is None else f"{impact:.2f}",
            )
            if key in seen:
                continue
            seen.add(key)
            rows.append(row)
        return rows

    def _sampled_payload_rows(
        self,
        *,
        table: str,
        where_sql: str,
        params: tuple[Any, ...],
        order_sql: str,
        max_points: int | None,
    ) -> list[sqlite3.Row]:
        with self._connect() as connection:
            if max_points is not None and max_points > 0:
                if max_points <= 2:
                    first = connection.execute(
                        f"""
                        SELECT payload_json
                        FROM {table}
                        WHERE {where_sql}
                        ORDER BY {order_sql}
                        LIMIT 1
                        """,
                        params,
                    ).fetchall()
                    last = connection.execute(
                        f"""
                        SELECT payload_json
                        FROM {table}
                        WHERE {where_sql}
                        ORDER BY {order_sql} DESC
                        LIMIT 1
                        """,
                        params,
                    ).fetchall()
                    if first and last and first[0]["payload_json"] != last[0]["payload_json"]:
                        return [first[0], last[0]]
                    return first or last
                count = connection.execute(
                    f"SELECT COUNT(*) FROM {table} WHERE {where_sql}",
                    params,
                ).fetchone()[0]
                if count > max_points:
                    stride = max(1, math.ceil(count / max_points))
                    return connection.execute(
                        f"""
                        WITH ordered AS (
                            SELECT payload_json,
                                   ROW_NUMBER() OVER (ORDER BY {order_sql}) AS rn,
                                   COUNT(*) OVER () AS total
                            FROM {table}
                            WHERE {where_sql}
                        )
                        SELECT payload_json
                        FROM ordered
                        WHERE rn = 1 OR rn = total OR ((rn - 1) % ?) = 0
                        ORDER BY rn
                        """,
                        (*params, stride),
                    ).fetchall()
            rows = connection.execute(
                f"""
                SELECT payload_json
                FROM {table}
                WHERE {where_sql}
                ORDER BY {order_sql}
                """,
                params,
            ).fetchall()
        return rows

    def _deduped_payload_rows(
        self,
        *,
        table: str,
        where_sql: str,
        params: tuple[Any, ...],
        group_fields: tuple[str, ...],
        order_sql: str,
        max_points: int | None,
    ) -> list[sqlite3.Row]:
        group_sql = ", ".join(group_fields)
        with self._connect() as connection:
            if max_points is not None and max_points > 0:
                count = connection.execute(
                    f"""
                    WITH deduped AS (
                        SELECT MAX(id) AS keep_id
                        FROM {table}
                        WHERE {where_sql}
                        GROUP BY {group_sql}
                    )
                    SELECT COUNT(*)
                    FROM deduped
                    """,
                    params,
                ).fetchone()[0]
                if count > max_points:
                    return connection.execute(
                        f"""
                        WITH deduped AS (
                            SELECT MAX(id) AS keep_id
                            FROM {table}
                            WHERE {where_sql}
                            GROUP BY {group_sql}
                        ),
                        ordered AS (
                            SELECT source.payload_json,
                                   ROW_NUMBER() OVER (ORDER BY {order_sql}) AS rn,
                                   COUNT(*) OVER () AS total
                            FROM {table} AS source
                            INNER JOIN deduped ON deduped.keep_id = source.id
                        )
                        SELECT payload_json
                        FROM ordered
                        WHERE rn > total - ?
                        ORDER BY rn
                        """,
                        (*params, max_points),
                    ).fetchall()
            return connection.execute(
                f"""
                WITH deduped AS (
                    SELECT MAX(id) AS keep_id
                    FROM {table}
                    WHERE {where_sql}
                    GROUP BY {group_sql}
                )
                SELECT source.payload_json
                FROM {table} AS source
                INNER JOIN deduped ON deduped.keep_id = source.id
                ORDER BY {order_sql}
                """,
                params,
            ).fetchall()

    def _recent_deduped_payload_rows(
        self,
        *,
        table: str,
        where_sql: str,
        params: tuple[Any, ...],
        group_field: str,
        order_column: str,
        max_points: int,
    ) -> list[sqlite3.Row]:
        batch_size = max(max_points * 8, 800)
        max_scan = max(batch_size, max_points * 40)
        selected: list[sqlite3.Row] = []
        seen: set[Any] = set()
        offset = 0
        with self._connect() as connection:
            while len(selected) < max_points and offset < max_scan:
                rows = connection.execute(
                    f"""
                    SELECT payload_json, {group_field} AS group_key
                    FROM {table}
                    WHERE {where_sql}
                    ORDER BY {order_column} DESC, id DESC
                    LIMIT ? OFFSET ?
                    """,
                    (*params, batch_size, offset),
                ).fetchall()
                if not rows:
                    break
                for row in rows:
                    key = row["group_key"]
                    if key in seen:
                        continue
                    seen.add(key)
                    selected.append(row)
                    if len(selected) >= max_points:
                        break
                offset += batch_size
        selected.reverse()
        return selected

    def get_price_series(self, symbol: str, start: str, end: str, max_points: int | None = None) -> list[dict[str, Any]]:
        range_sql, range_params = self._range_where("data_timestamp", start, end)
        if max_points is not None and max_points > 0:
            rows = self._recent_deduped_payload_rows(
                table="market_price_bars",
                where_sql=f"symbol = ? AND {range_sql}",
                params=(symbol, *range_params),
                group_field="data_timestamp",
                order_column="data_timestamp",
                max_points=max_points,
            )
        else:
            rows = self._deduped_payload_rows(
                table="market_price_bars",
                where_sql=f"symbol = ? AND {range_sql}",
                params=(symbol, *range_params),
                group_fields=("data_timestamp",),
                order_sql="source.data_timestamp, source.id",
                max_points=max_points,
            )
        return self._rows_to_payloads(rows)

    def get_latest_price_anchor_before(self, symbol: str, start: str) -> dict[str, Any] | None:
        start_dt = self._parse_timestamp(start)
        with self._connect() as connection:
            if start_dt is not None:
                candidates = connection.execute(
                    """
                    SELECT data_timestamp, payload_json
                    FROM market_price_bars
                    WHERE symbol = ?
                    ORDER BY data_timestamp DESC, id DESC
                    LIMIT 500
                    """,
                    (symbol,),
                ).fetchall()
                row = next(
                    (
                        candidate
                        for candidate in candidates
                        if (self._parse_timestamp(str(candidate["data_timestamp"])) or datetime.max.replace(tzinfo=timezone.utc))
                        < start_dt
                    ),
                    None,
                )
            else:
                row = connection.execute(
                    """
                    SELECT payload_json
                    FROM market_price_bars
                    WHERE symbol = ? AND data_timestamp < ?
                    ORDER BY data_timestamp DESC, id DESC
                    LIMIT 1
                    """,
                    (symbol, start),
                ).fetchone()
        if row is None:
            return None
        payload = json.loads(str(row["payload_json"]))
        payload["replay_context_anchor"] = True
        payload["context_anchor_reason"] = "latest_price_before_replay_window"
        return payload

    def get_related_asset_series(
        self,
        symbol: str,
        start: str,
        end: str,
        max_points: int | None = None,
    ) -> list[dict[str, Any]]:
        range_sql, range_params = self._range_where("data_timestamp", start, end)
        if max_points is not None and max_points > 0:
            rows = self._recent_deduped_payload_rows(
                table="related_asset_bars",
                where_sql=f"symbol = ? AND {range_sql}",
                params=(symbol, *range_params),
                group_field="data_timestamp",
                order_column="data_timestamp",
                max_points=max_points,
            )
        else:
            rows = self._deduped_payload_rows(
                table="related_asset_bars",
                where_sql=f"symbol = ? AND {range_sql}",
                params=(symbol, *range_params),
                group_fields=("data_timestamp",),
                order_sql="source.data_timestamp, source.id",
                max_points=max_points,
            )
        return self._rows_to_payloads(rows)

    @classmethod
    def _is_filtered_news_item(cls, item: dict[str, Any]) -> bool:
        filter_reason = cls._normalize_news_key_part(item.get("filter_reason") or item.get("reason"))
        review_status = cls._normalize_news_key_part(item.get("review_status") or item.get("evidence_status"))
        return bool(
            item.get("included") is False
            or "no_market_agent_keyword" in filter_reason
            or review_status in {"false", "filtered", "excluded", "rejected", "dropped", "unreviewed_context"}
        )

    def get_news_items(
        self,
        start: str,
        end: str,
        include_filtered: bool = True,
        max_points: int | None = None,
    ) -> list[dict[str, Any]]:
        range_sql, range_params = self._range_where("published_at", start, end)
        rows: list[sqlite3.Row] = []
        if max_points is not None and max_points > 0:
            batch_size = max(max_points * 8, 800)
            max_scan = max(batch_size, max_points * 40)
            offset = 0
            deduped: list[dict[str, Any]] = []
            with self._connect() as connection:
                while len(deduped) < max_points and offset < max_scan:
                    batch = connection.execute(
                        f"""
                        SELECT id, monitor_run_id, payload_json
                        FROM news_items
                        WHERE {range_sql}
                        ORDER BY published_at DESC, id DESC
                        LIMIT ? OFFSET ?
                        """,
                        (*range_params, batch_size, offset),
                    ).fetchall()
                    if not batch:
                        break
                    rows.extend(batch)
                    items: list[dict[str, Any]] = []
                    for row in rows:
                        payload = json.loads(str(row["payload_json"]))
                        payload.setdefault("monitor_run_id", int(row["monitor_run_id"]))
                        payload.setdefault("storage_row_id", int(row["id"]))
                        items.append(self._repair_news_display_fields(payload))
                    deduped = self._dedupe_news_items(items)
                    if not include_filtered:
                        deduped = [item for item in deduped if not self._is_filtered_news_item(item)]
                    offset += batch_size
            deduped.sort(key=lambda item: self._timestamp_score(item.get("published_at")))
            return deduped[-max_points:]
        with self._connect() as connection:
            rows = connection.execute(
                f"""
                SELECT id, monitor_run_id, payload_json
                FROM news_items
                WHERE {range_sql}
                ORDER BY published_at, id
                """,
                range_params,
            ).fetchall()
        items: list[dict[str, Any]] = []
        for row in rows:
            payload = json.loads(str(row["payload_json"]))
            payload.setdefault("monitor_run_id", int(row["monitor_run_id"]))
            payload.setdefault("storage_row_id", int(row["id"]))
            items.append(self._repair_news_display_fields(payload))
        deduped = self._dedupe_news_items(items)
        items = deduped if include_filtered else [item for item in deduped if not self._is_filtered_news_item(item)]
        return items

    def get_calendar_events(self, start: str, end: str) -> list[dict[str, Any]]:
        range_sql, range_params = self._range_where("scheduled_at", start, end)
        with self._connect() as connection:
            rows = connection.execute(
                f"""
                SELECT payload_json
                FROM calendar_events
                WHERE {range_sql}
                ORDER BY scheduled_at, id
                """,
                range_params,
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
        start_dt = self._parse_timestamp(start)
        end_dt = self._parse_timestamp(end)
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
                    if not is_market_agent_calendar_row(item):
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
                    scheduled_dt = self._parse_timestamp(scheduled_at)
                    if start_dt is not None and end_dt is not None and scheduled_dt is not None:
                        if not (start_dt <= scheduled_dt <= end_dt):
                            continue
                    elif not (start <= scheduled_at <= end):
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

    @staticmethod
    def _driver_attention_replay_signature(payload: dict[str, Any]) -> str:
        evidence_refs = payload.get("evidence_refs") if isinstance(payload.get("evidence_refs"), list) else []
        compact_refs = [
            {
                "kind": item.get("kind"),
                "title": item.get("title"),
                "source": item.get("source"),
                "timestamp_myt": item.get("timestamp_myt"),
            }
            for item in evidence_refs
            if isinstance(item, dict)
        ]
        signature = {
            "driver_id": payload.get("driver_id"),
            "current_state": payload.get("current_state"),
            "priority": payload.get("priority"),
            "relevance_score": payload.get("relevance_score"),
            "confidence": payload.get("confidence"),
            "activation_reason": payload.get("activation_reason"),
            "deactivation_reason": payload.get("deactivation_reason"),
            "current_evidence_summary": payload.get("current_evidence_summary"),
            "current_counter_evidence": payload.get("current_counter_evidence"),
            "source_count": payload.get("source_count"),
            "related_news_count": payload.get("related_news_count"),
            "related_calendar_events": payload.get("related_calendar_events"),
            "data_mode": payload.get("data_mode"),
            "theme_id": payload.get("theme_id"),
            "lifecycle": payload.get("lifecycle"),
            "source_terms": payload.get("source_terms") or [],
            "requested_sensor_ids": payload.get("requested_sensor_ids") or [],
            "evidence_refs": compact_refs,
        }
        return json.dumps(signature, ensure_ascii=False, sort_keys=True)

    @classmethod
    def _dedupe_driver_attention_timeline(cls, payloads: list[dict[str, Any]]) -> list[dict[str, Any]]:
        deduped: list[dict[str, Any]] = []
        last_signature_by_driver: dict[str, str] = {}
        for payload in payloads:
            driver_id = str(payload.get("driver_id") or "")
            if not driver_id:
                deduped.append(payload)
                continue
            signature = cls._driver_attention_replay_signature(payload)
            if last_signature_by_driver.get(driver_id) == signature:
                continue
            last_signature_by_driver[driver_id] = signature
            deduped.append(payload)
        return deduped

    def get_driver_attention_timeline(
        self, start: str, end: str, max_points: int | None = None
    ) -> list[dict[str, Any]]:
        run_where_sql, run_where_params = self._range_where("monitor_runs.run_started_at", start, end)
        with self._connect() as connection:
            if max_points is not None and max_points > 0:
                rows = connection.execute(
                    f"""
                    SELECT driver_attention_states.payload_json
                    FROM driver_attention_states
                    WHERE monitor_run_id IN (
                        SELECT id
                        FROM monitor_runs
                        WHERE {run_where_sql}
                    )
                    ORDER BY monitor_run_id DESC, id DESC
                    LIMIT ?
                    """,
                    (*run_where_params, max_points),
                ).fetchall()
                rows = list(reversed(rows))
            else:
                rows = connection.execute(
                    f"""
                    SELECT driver_attention_states.payload_json
                    FROM driver_attention_states
                    INNER JOIN monitor_runs ON monitor_runs.id = driver_attention_states.monitor_run_id
                    WHERE {run_where_sql}
                    ORDER BY monitor_runs.run_started_at, driver_attention_states.id
                    """,
                    run_where_params,
                ).fetchall()
        payloads = self._rows_to_payloads(rows)
        theme_ids = sorted(
            {
                str(payload.get("driver_id") or "")
                for payload in payloads
                if str(payload.get("driver_id") or "").startswith("theme:")
            }
        )
        retired_theme_ids: set[str] = set()
        if theme_ids:
            with self._connect() as connection:
                latest_run = connection.execute(
                    """
                    SELECT id
                    FROM monitor_runs
                    WHERE run_started_at <= ?
                    ORDER BY run_started_at DESC, id DESC
                    LIMIT 1
                    """,
                    (end,),
                ).fetchone()
                latest_run_id = int(latest_run["id"]) if latest_run is not None else None
                if latest_run_id is not None:
                    for theme_id in theme_ids:
                        row = connection.execute(
                            """
                            SELECT current_state
                            FROM driver_attention_states
                            WHERE driver_id = ?
                              AND monitor_run_id <= ?
                            ORDER BY monitor_run_id DESC, id DESC
                            LIMIT 1
                            """,
                            (theme_id, latest_run_id),
                        ).fetchone()
                        if row is not None and str(row["current_state"]) == "retired":
                            retired_theme_ids.add(theme_id)
        return [
            payload
            for payload in self._dedupe_driver_attention_timeline(payloads)
            if str(payload.get("driver_id", "")) not in retired_theme_ids
        ]

    def get_evidence_for_run(self, monitor_run_id: int) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload_json FROM evidence_packets WHERE monitor_run_id = ? ORDER BY id DESC LIMIT 1",
                (monitor_run_id,),
            ).fetchone()
        return None if row is None else json.loads(str(row["payload_json"]))

    def get_suppressed_alerts(self, start: str, end: str, max_points: int | None = None) -> list[dict[str, Any]]:
        run_where_sql, run_where_params = self._range_where("monitor_runs.run_started_at", start, end)
        with self._connect() as connection:
            if max_points is not None and max_points > 0:
                rows = connection.execute(
                    f"""
                    SELECT payload_json
                    FROM (
                        SELECT
                            monitor_runs.run_started_at AS run_started_at,
                            alerts.id AS row_id,
                            alerts.payload_json AS payload_json
                        FROM alerts
                        INNER JOIN monitor_runs ON monitor_runs.id = alerts.monitor_run_id
                        WHERE {run_where_sql}
                          AND alerts.should_notify = 0
                        UNION ALL
                        SELECT
                            monitor_runs.run_started_at AS run_started_at,
                            0 AS row_id,
                            json_object(
                                'monitor_run_id', monitor_runs.id,
                                'run_started_at', monitor_runs.run_started_at,
                                'should_notify', json('false'),
                                'notification_level', 'none',
                                'reason', monitor_runs.alert_suppressed_reason,
                                'legacy_source', 'monitor_runs.alert_suppressed_reason'
                            ) AS payload_json
                        FROM monitor_runs
                        WHERE {run_where_sql}
                          AND COALESCE(monitor_runs.alert_suppressed_reason, '') <> ''
                          AND NOT EXISTS (
                              SELECT 1
                              FROM alerts
                              WHERE alerts.monitor_run_id = monitor_runs.id
                                AND alerts.should_notify = 0
                          )
                    )
                    ORDER BY run_started_at DESC, row_id DESC
                    LIMIT ?
                    """,
                    (*run_where_params, *run_where_params, max_points),
                ).fetchall()
                rows = list(reversed(rows))
            else:
                rows = connection.execute(
                    f"""
                    SELECT payload_json
                    FROM (
                        SELECT
                            monitor_runs.run_started_at AS run_started_at,
                            alerts.id AS row_id,
                            alerts.payload_json AS payload_json
                        FROM alerts
                        INNER JOIN monitor_runs ON monitor_runs.id = alerts.monitor_run_id
                        WHERE {run_where_sql}
                          AND alerts.should_notify = 0
                        UNION ALL
                        SELECT
                            monitor_runs.run_started_at AS run_started_at,
                            0 AS row_id,
                            json_object(
                                'monitor_run_id', monitor_runs.id,
                                'run_started_at', monitor_runs.run_started_at,
                                'should_notify', json('false'),
                                'notification_level', 'none',
                                'reason', monitor_runs.alert_suppressed_reason,
                                'legacy_source', 'monitor_runs.alert_suppressed_reason'
                            ) AS payload_json
                        FROM monitor_runs
                        WHERE {run_where_sql}
                          AND COALESCE(monitor_runs.alert_suppressed_reason, '') <> ''
                          AND NOT EXISTS (
                              SELECT 1
                              FROM alerts
                              WHERE alerts.monitor_run_id = monitor_runs.id
                                AND alerts.should_notify = 0
                          )
                    )
                    ORDER BY run_started_at, row_id
                    """,
                    (*run_where_params, *run_where_params),
                ).fetchall()
        return self._rows_to_payloads(rows)

    def get_alerts(self, start: str, end: str, max_points: int | None = None) -> list[dict[str, Any]]:
        run_where_sql, run_where_params = self._range_where("monitor_runs.run_started_at", start, end)
        with self._connect() as connection:
            if max_points is not None and max_points > 0:
                rows = connection.execute(
                    f"""
                    SELECT alerts.payload_json
                    FROM alerts
                    INNER JOIN monitor_runs ON monitor_runs.id = alerts.monitor_run_id
                    WHERE {run_where_sql}
                      AND alerts.should_notify = 1
                    ORDER BY monitor_runs.run_started_at DESC, alerts.id DESC
                    LIMIT ?
                    """,
                    (*run_where_params, max_points),
                ).fetchall()
                rows = list(reversed(rows))
            else:
                rows = connection.execute(
                    f"""
                    SELECT alerts.payload_json
                    FROM alerts
                    INNER JOIN monitor_runs ON monitor_runs.id = alerts.monitor_run_id
                    WHERE {run_where_sql}
                      AND alerts.should_notify = 1
                    ORDER BY monitor_runs.run_started_at DESC, alerts.id DESC
                    """,
                    run_where_params,
                ).fetchall()
        return self._rows_to_payloads(rows)

    def get_state_transitions(self, start: str, end: str, max_points: int | None = None) -> list[dict[str, Any]]:
        run_where_sql, run_where_params = self._range_where("monitor_runs.run_started_at", start, end)
        with self._connect() as connection:
            if max_points is not None and max_points > 0:
                rows = connection.execute(
                    f"""
                    SELECT state_transitions.payload_json
                    FROM state_transitions
                    INNER JOIN monitor_runs ON monitor_runs.id = state_transitions.monitor_run_id
                    WHERE {run_where_sql}
                    ORDER BY monitor_runs.run_started_at DESC, state_transitions.id DESC
                    LIMIT ?
                    """,
                    (*run_where_params, max_points),
                ).fetchall()
                rows = list(reversed(rows))
            else:
                rows = connection.execute(
                    f"""
                    SELECT state_transitions.payload_json
                    FROM state_transitions
                    INNER JOIN monitor_runs ON monitor_runs.id = state_transitions.monitor_run_id
                    WHERE {run_where_sql}
                    ORDER BY monitor_runs.run_started_at, state_transitions.id
                    """,
                    run_where_params,
                ).fetchall()
        return self._rows_to_payloads(rows)

    def get_market_replay(self, start: str, end: str) -> dict[str, Any]:
        long_window = False
        start_dt = self._parse_timestamp(start)
        end_dt = self._parse_timestamp(end)
        if start_dt is not None and end_dt is not None:
            long_window = (end_dt - start_dt) > timedelta(hours=48)
        price_max_points = MONTH_REPLAY_PRICE_ROWS if long_window else None
        related_max_points = MONTH_REPLAY_RELATED_ROWS_PER_SYMBOL if long_window else DAY_REPLAY_RELATED_ROWS_PER_SYMBOL
        news_max_points = MONTH_REPLAY_NEWS_ROWS if long_window else DAY_REPLAY_NEWS_ROWS
        timeline_max_points = MONTH_REPLAY_TIMELINE_ROWS if long_window else DAY_REPLAY_TIMELINE_ROWS
        driver_max_points = MONTH_REPLAY_DRIVER_ROWS if long_window else DAY_REPLAY_DRIVER_ROWS
        state_max_points = MONTH_REPLAY_STATE_ROWS if long_window else DAY_REPLAY_STATE_ROWS
        alert_max_points = MONTH_REPLAY_ALERT_ROWS if long_window else DAY_REPLAY_ALERT_ROWS
        price_series = self.get_price_series("XAUUSD", start, end, max_points=price_max_points)
        if not price_series:
            price_anchor = self.get_latest_price_anchor_before("XAUUSD", start)
            if price_anchor is not None:
                price_series = [price_anchor]
        related_symbols = ("dxy", "us10y", "us2y", "wti", "brent", "vix", "spx", "nasdaq")
        related = {
            symbol: self.get_related_asset_series(symbol, start, end, max_points=related_max_points)
            for symbol in related_symbols
        }
        timeline_events = self.get_timeline(start, end, max_points=timeline_max_points)
        calendar_events = self._get_existing_calendar_context(start, end)
        if not calendar_events:
            calendar_events = self.get_calendar_events(start, end)
        return {
            "price_series": price_series,
            "related_assets": related,
            "news_items": self.get_news_items(start, end, include_filtered=False, max_points=news_max_points),
            "calendar_events": calendar_events,
            "driver_attention_timeline": self.get_driver_attention_timeline(start, end, max_points=driver_max_points),
            "timeline_events": timeline_events,
            "month_summary_events": self._month_summary_events(timeline_events),
            "state_transitions": self.get_state_transitions(start, end, max_points=state_max_points),
            "alerts": self.get_alerts(start, end, max_points=alert_max_points),
            "suppressed_alerts": self.get_suppressed_alerts(start, end, max_points=alert_max_points),
        }
