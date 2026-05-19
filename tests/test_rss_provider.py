from datetime import datetime
from pathlib import Path

from src.xauusd_market_agent.providers.rss_provider import RSSNewsProvider


def test_rss_provider_dedupes_and_marks_backfilled_fields() -> None:
    feed_path = Path(__file__).parent / "fixtures" / "providers" / "news_feed.xml"
    provider = RSSNewsProvider([str(feed_path)])

    rows, health = provider.backfill(
        datetime.fromisoformat("2026-05-19T06:00:00+08:00"),
        datetime.fromisoformat("2026-05-19T08:00:00+08:00"),
    )

    assert len(rows) == 2
    assert all(item["is_backfilled"] for item in rows)
    assert rows[0]["backfilled_at"] is not None
    assert "included" in rows[0]
    assert "filter_reason" in rows[0]
    assert "source_quality_score" in rows[0]
    assert health.is_available is True


def test_rss_provider_missing_timestamp_gets_lower_score() -> None:
    feed_path = Path(__file__).parent / "fixtures" / "providers" / "news_feed.xml"
    provider = RSSNewsProvider([str(feed_path)])

    rows, _ = provider.fetch_latest(datetime.fromisoformat("2026-05-19T08:00:00+08:00"))

    scored = {item["title"]: item["score"] for item in rows}
    assert scored["Opinion: Gold forecast into CPI week"] < scored["Fed headline lifts yields and pressures gold"]
    opinion_row = next(item for item in rows if item["title"] == "Opinion: Gold forecast into CPI week")
    assert opinion_row["included"] is False
    assert opinion_row["filter_reason"] in {"missing_timestamp", "low_signal_opinion_or_forecast", "score_below_threshold"}
