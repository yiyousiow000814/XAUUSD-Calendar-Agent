from __future__ import annotations

from datetime import datetime, timedelta
import json
from pathlib import Path
from typing import Any
from urllib.request import urlopen

from ..models import ProviderHealth


def _parse_calendar_time(date_raw: str, time_raw: str) -> datetime | None:
    if not date_raw or not time_raw:
        return None
    lowered = str(time_raw).strip().lower()
    if lowered in {"all day", "tentative"}:
        return None
    try:
        return datetime.fromisoformat(f"{date_raw}T{time_raw}:00+08:00")
    except ValueError:
        return None


class ForexFactoryProvider:
    def __init__(
        self,
        *,
        fixture_path: Path | None = None,
        source_url: str | None = None,
        lookback_minutes: int = 60,
        forward_minutes: int = 120,
    ) -> None:
        self.fixture_path = Path(fixture_path) if fixture_path is not None else None
        self.source_url = source_url
        self.lookback_minutes = int(lookback_minutes)
        self.forward_minutes = int(forward_minutes)

    def _load_payload(self) -> tuple[list[dict[str, Any]], str]:
        if self.fixture_path is not None and self.fixture_path.exists():
            return json.loads(self.fixture_path.read_text(encoding="utf-8")), ""
        if self.source_url:
            try:
                with urlopen(self.source_url, timeout=15) as response:
                    return json.loads(response.read().decode("utf-8", errors="replace")), ""
            except Exception as exc:
                return [], f"ForexFactory source fetch failed: {exc}"
        return [], "No ForexFactory fixture path or source URL configured."

    def _filter_window(self, start: datetime, end: datetime, *, data_mode: str) -> tuple[list[dict[str, Any]], ProviderHealth]:
        payload, unavailable_reason = self._load_payload()
        rows: list[dict[str, Any]] = []
        for item in payload:
            event_dt = _parse_calendar_time(str(item.get("Date", "")), str(item.get("Time", "")))
            if event_dt is None or not (start <= event_dt <= end):
                continue
            rows.append(
                {
                    "scheduled_at": event_dt.isoformat(),
                    "source": "ForexFactory",
                    "title": str(item.get("Event", "")).strip() or "Unnamed Event",
                    "relevance_reason": f"{item.get('Currency', 'Unknown')} {item.get('Imp.', 'Unknown')} impact event",
                    "impact_direction_on_gold": "unknown",
                    "data_mode": data_mode,
                    "actual": str(item.get("Actual", "")),
                    "forecast": str(item.get("Forecast", "")),
                    "previous": str(item.get("Previous", "")),
                    "country": str(item.get("Currency", "")),
                    "impact": str(item.get("Imp.", "")),
                }
            )
        rows.sort(key=lambda item: item["scheduled_at"])
        health = ProviderHealth(
            source="ForexFactory",
            source_type="calendar_provider",
            fetched_at=end.isoformat(),
            data_timestamp=rows[-1]["scheduled_at"] if rows else end.isoformat(),
            data_mode=data_mode if rows else "unavailable",
            is_available=bool(rows),
            is_stale=False,
            stale_reason="" if rows else unavailable_reason,
            error="" if rows else unavailable_reason,
            current_value=float(len(rows)),
        )
        return rows, health

    def fetch_window(
        self,
        anchor_time: datetime,
        lookback_minutes: int | None = None,
        forward_minutes: int | None = None,
    ) -> tuple[list[dict[str, Any]], ProviderHealth]:
        lookback = self.lookback_minutes if lookback_minutes is None else int(lookback_minutes)
        forward = self.forward_minutes if forward_minutes is None else int(forward_minutes)
        return self._filter_window(
            anchor_time - timedelta(minutes=lookback),
            anchor_time + timedelta(minutes=forward),
            data_mode="live_seen",
        )

    def backfill(self, start: datetime, end: datetime) -> tuple[list[dict[str, Any]], ProviderHealth]:
        return self._filter_window(start, end, data_mode="backfilled")
