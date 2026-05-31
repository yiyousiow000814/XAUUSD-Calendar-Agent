from __future__ import annotations

from datetime import datetime, timedelta
import json
from pathlib import Path

from ..models import Headline

_MARKET_AGENT_CALENDAR_IMPACTS = {"high", "medium"}


def is_market_agent_calendar_row(row: dict[str, object]) -> bool:
    impact = str(row.get("Imp.", row.get("Impact", ""))).strip().lower()
    time_raw = str(row.get("Time", "")).strip().lower()
    title = str(row.get("Event", "")).strip()
    if not title:
        return False
    if impact == "holiday" or time_raw in {"all day", "tentative"}:
        return False
    return impact in _MARKET_AGENT_CALENDAR_IMPACTS


def _parse_calendar_time(date_raw: str, time_raw: str) -> datetime | None:
    if not date_raw or not time_raw:
        return None
    lowered = str(time_raw).strip().lower()
    if lowered in {"all day", "tentative"}:
        return None
    return datetime.fromisoformat(f"{date_raw}T{time_raw}:00+08:00")


def load_calendar_events_in_window(
    calendar_dir: Path,
    anchor_time: datetime,
    lookback_minutes: int,
    forward_minutes: int,
) -> list[Headline]:
    year_path = calendar_dir / str(anchor_time.year) / f"{anchor_time.year}_calendar.json"
    if not year_path.exists():
        return []
    payload = json.loads(year_path.read_text(encoding="utf-8"))
    window_start = anchor_time - timedelta(minutes=lookback_minutes)
    window_end = anchor_time + timedelta(minutes=forward_minutes)
    items: list[Headline] = []
    for row in payload:
        if not isinstance(row, dict) or not is_market_agent_calendar_row(row):
            continue
        event_dt = _parse_calendar_time(str(row.get("Date", "")), str(row.get("Time", "")))
        if event_dt is None or not (window_start <= event_dt <= window_end):
            continue
        items.append(
            Headline(
                timestamp_myt=event_dt.strftime("%d-%m-%Y %H:%M"),
                source="Economic Calendar",
                title=str(row.get("Event", "")).strip() or "Unnamed Event",
                relevance_reason=f"{row.get('Currency', 'Unknown')} {row.get('Imp.', 'Unknown')} importance event",
                impact_direction_on_gold="unknown",
                tags=(str(row.get("Currency", "")).strip(), str(row.get("Imp.", "")).strip()),
            )
        )
    return items
