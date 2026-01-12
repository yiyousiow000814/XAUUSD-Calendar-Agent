import json
from datetime import datetime
from pathlib import Path


def load_calendar_events(repo_path: str) -> list[dict]:
    now = datetime.now()
    base = Path(repo_path)
    calendar_root = base / "data" / "Economic_Calendar"
    if not calendar_root.exists():
        return []

    year_dirs = []
    for entry in calendar_root.iterdir():
        if entry.is_dir() and entry.name.isdigit():
            year_dirs.append(int(entry.name))
    if not year_dirs:
        return []

    years = sorted(set(year_dirs))
    current_year = now.year
    candidates = [y for y in years if y in (current_year, current_year + 1)]
    if not candidates:
        candidates = [years[-1]]

    items: list[dict] = []
    for year in candidates:
        year_path = calendar_root / str(year)
        file_path = year_path / f"{year}_calendar.json"
        if not file_path.exists():
            matches = list(year_path.glob("*.json"))
            if not matches:
                continue
            file_path = matches[0]
        try:
            payload = json.loads(file_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(payload, list):
            continue
        items.extend(payload)

    events: list[dict] = []
    for item in items:
        date_raw = item.get("Date")
        time_raw = (item.get("Time") or "").strip()
        event_raw = (item.get("Event") or "").strip()
        currency_raw = (item.get("Cur.") or "").strip()
        importance_raw = (item.get("Imp.") or "").strip()
        if not date_raw or not event_raw:
            continue
        try:
            date_val = datetime.strptime(date_raw, "%Y-%m-%d").date()
        except ValueError:
            continue

        time_label = time_raw or "All Day"
        if ":" in time_raw:
            try:
                time_val = datetime.strptime(time_raw, "%H:%M").time()
            except ValueError:
                time_val = datetime.min.time()
        else:
            time_val = datetime.min.time()
        dt = datetime.combine(date_val, time_val)

        events.append(
            {
                "dt": dt,
                "time_label": time_label,
                "event": event_raw,
                "currency": currency_raw.upper(),
                "importance": importance_raw,
                "actual": (item.get("Actual") or "").strip(),
                "forecast": (item.get("Forecast") or "").strip(),
                "previous": (item.get("Previous") or "").strip(),
            }
        )
    return events
