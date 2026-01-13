from __future__ import annotations

from datetime import datetime, timedelta, timezone

CALENDAR_SOURCE_UTC_OFFSET_MINUTES = 8 * 60
MIN_UTC_OFFSET_MINUTES = -12 * 60
MAX_UTC_OFFSET_MINUTES = 14 * 60
SUPPORTED_UTC_OFFSET_MINUTES = {
    *(hours * 60 for hours in range(0, 15)),
    *(hours * 60 + 30 for hours in range(1, 15)),
    *(-hours * 60 for hours in range(0, 13)),
    *(-hours * 60 - 30 for hours in range(1, 13)),
    *(hours * 60 + 45 for hours in (5, 8, 12)),
}


def utc_offset_minutes_to_tzinfo(offset_minutes: int) -> timezone:
    return timezone(timedelta(minutes=int(offset_minutes)))


def clamp_utc_offset_minutes(value: int) -> int:
    value = max(MIN_UTC_OFFSET_MINUTES, min(MAX_UTC_OFFSET_MINUTES, int(value)))
    if value in SUPPORTED_UTC_OFFSET_MINUTES:
        return value
    closest = None
    closest_diff = None
    for candidate in SUPPORTED_UTC_OFFSET_MINUTES:
        diff = abs(candidate - value)
        if closest is None or diff < closest_diff:  # type: ignore[operator]
            closest = candidate
            closest_diff = diff
            continue
        if diff == closest_diff and closest is not None:
            if abs(candidate) < abs(closest):
                closest = candidate
            elif abs(candidate) == abs(closest) and candidate > closest:
                closest = candidate
    return int(closest or 0)


def get_system_utc_offset_minutes(now: datetime | None = None) -> int:
    now = now or datetime.now().astimezone()
    offset = now.utcoffset()
    if not offset:
        return 0
    return int(offset.total_seconds() // 60)


def format_utc_offset_label(offset_minutes: int) -> str:
    offset_minutes = int(offset_minutes)
    sign = "+" if offset_minutes >= 0 else "-"
    minutes = abs(offset_minutes)
    hours, mins = divmod(minutes, 60)
    if mins:
        return f"UTC{sign}{hours:02d}:{mins:02d}"
    return f"UTC{sign}{hours:02d}"


def parse_utc_offset_label(value: str) -> int | None:
    raw = (value or "").strip().upper()
    if not raw.startswith("UTC"):
        return None
    tail = raw[3:]
    if not tail:
        return 0
    sign_char = tail[0]
    if sign_char not in ("+", "-"):
        return None
    sign = 1 if sign_char == "+" else -1
    rest = tail[1:]
    if not rest:
        return None
    if ":" in rest:
        hours_part, mins_part = rest.split(":", 1)
    else:
        hours_part, mins_part = rest, "0"
    try:
        hours = int(hours_part)
        mins = int(mins_part)
    except ValueError:
        return None
    if hours < 0 or mins < 0 or mins >= 60:
        return None
    return sign * (hours * 60 + mins)
