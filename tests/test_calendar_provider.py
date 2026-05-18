from datetime import datetime
import json

from src.xauusd_market_agent.providers.calendar_events import load_calendar_events_in_window


def test_load_calendar_events_in_window_filters_by_anchor(tmp_path) -> None:
    year_dir = tmp_path / "2026"
    year_dir.mkdir()
    path = year_dir / "2026_calendar.json"
    path.write_text(
        json.dumps(
            [
                {"Date": "2026-05-19", "Time": "07:00", "Currency": "USD", "Event": "CPI", "Imp.": "High"},
                {"Date": "2026-05-19", "Time": "12:00", "Currency": "USD", "Event": "Fed Speech", "Imp.": "High"},
            ]
        ),
        encoding="utf-8",
    )

    events = load_calendar_events_in_window(
        calendar_dir=tmp_path,
        anchor_time=datetime.fromisoformat("2026-05-19T07:30:00+08:00"),
        lookback_minutes=60,
        forward_minutes=120,
    )

    assert len(events) == 1
    assert events[0].title == "CPI"
