from datetime import datetime

from src.xauusd_market_agent.providers.news_events import filter_news_in_window


def test_filter_news_in_window_keeps_recent_headline() -> None:
    headlines = [
        {"title": "Recent Fed headline", "source": "Reuters", "published_at": "2026-05-19T07:05:00+08:00"},
        {"title": "Old headline", "source": "Reuters", "published_at": "2026-05-19T02:05:00+08:00"},
    ]

    items = filter_news_in_window(
        headlines=headlines,
        move_start=datetime.fromisoformat("2026-05-19T07:10:00+08:00"),
        move_end=datetime.fromisoformat("2026-05-19T07:25:00+08:00"),
        lookback_minutes=30,
        forward_minutes=120,
    )

    assert len(items) == 1
    assert items[0].title == "Recent Fed headline"
