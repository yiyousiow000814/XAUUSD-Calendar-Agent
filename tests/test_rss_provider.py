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
    assert str(feed_path) in health.raw_source_id


def test_rss_provider_missing_timestamp_gets_lower_score() -> None:
    feed_path = Path(__file__).parent / "fixtures" / "providers" / "news_feed.xml"
    provider = RSSNewsProvider([str(feed_path)])

    rows, _ = provider.fetch_latest(datetime.fromisoformat("2026-05-19T08:00:00+08:00"))

    scored = {item["title"]: item["score"] for item in rows}
    assert scored["Opinion: Gold forecast into CPI week"] < scored["Fed headline lifts yields and pressures gold"]
    opinion_row = next(item for item in rows if item["title"] == "Opinion: Gold forecast into CPI week")
    assert opinion_row["included"] is False
    assert opinion_row["filter_reason"] in {"missing_timestamp", "low_signal_opinion_or_forecast", "score_below_threshold"}


def test_rss_provider_skips_malformed_feed_without_blocking_other_feeds(tmp_path) -> None:
    bad_feed = tmp_path / "bad.xml"
    bad_feed.write_text("<html>not rss", encoding="utf-8")
    good_feed = Path(__file__).parent / "fixtures" / "providers" / "news_feed.xml"
    provider = RSSNewsProvider([str(bad_feed), str(good_feed)])

    rows, health = provider.fetch_latest(datetime.fromisoformat("2026-05-19T08:00:00+08:00"))

    assert rows
    assert health.is_available is True
    assert str(good_feed) in health.raw_source_id
    assert str(bad_feed) not in health.raw_source_id


def test_rss_provider_reports_configured_feeds_when_empty(tmp_path) -> None:
    empty_feed = tmp_path / "empty.xml"
    empty_feed.write_text("<rss><channel><title>Empty Feed</title></channel></rss>", encoding="utf-8")
    provider = RSSNewsProvider([str(empty_feed)])

    rows, health = provider.fetch_latest(datetime.fromisoformat("2026-05-19T08:00:00+08:00"))

    assert rows == []
    assert health.is_available is False
    assert health.data_mode == "unavailable"
    assert str(empty_feed) in health.raw_source_id
    assert "no usable headlines" in health.stale_reason.lower()


def test_rss_provider_uses_browser_user_agent_for_remote_feeds(monkeypatch) -> None:
    captured = {}

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return b"<rss><channel><title>Remote Feed</title></channel></rss>"

    def fake_urlopen(request, timeout):
        captured["user_agent"] = request.headers.get("User-agent") or request.headers.get("User-Agent")
        captured["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr("src.xauusd_market_agent.providers.rss_provider.urlopen", fake_urlopen)
    provider = RSSNewsProvider(["https://example.test/feed.xml"])

    provider.fetch_latest(datetime.fromisoformat("2026-05-19T08:00:00+08:00"))

    assert "Mozilla" in captured["user_agent"]
    assert captured["timeout"] == 15
