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


def test_rss_provider_decodes_cp1252_feeds_without_replacement_characters(monkeypatch) -> None:
    class FakeHeaders:
        def get_content_charset(self):
            return None

    class FakeResponse:
        headers = FakeHeaders()

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return (
                "<rss><channel><title>MarketWatch Top Stories</title>"
                "<item><title>The great gold myth: Why gold isn’t the hedge we’re told it is — yet</title>"
                "<link>https://example.test/gold-myth</link>"
                "<pubDate>Sat, 13 Jun 2026 18:52:00 GMT</pubDate>"
                "</item></channel></rss>"
            ).encode("cp1252")

    monkeypatch.setattr("src.xauusd_market_agent.providers.rss_provider.urlopen", lambda *_args, **_kwargs: FakeResponse())
    provider = RSSNewsProvider(["https://example.test/feed.xml"])

    rows, _ = provider.fetch_latest(datetime.fromisoformat("2026-06-14T04:28:00+08:00"))

    assert rows[0]["title"] == "The great gold myth: Why gold isn’t the hedge we’re told it is — yet"
    assert "�" not in rows[0]["title"]


def test_rss_provider_filters_marketwatch_personal_finance_noise(tmp_path) -> None:
    feed = tmp_path / "marketwatch.xml"
    feed.write_text(
        """
        <rss><channel>
          <title>MarketWatch Top Stories</title>
          <item>
            <title>My husband took out a Parent PLUS loan without telling me</title>
            <link>https://example.test/personal-finance</link>
            <pubDate>Sun, 31 May 2026 06:12:28 GMT</pubDate>
          </item>
          <item>
            <title>Gold rises as dollar slips before Fed inflation data</title>
            <link>https://example.test/gold-dollar-fed</link>
            <pubDate>Sun, 31 May 2026 06:13:28 GMT</pubDate>
          </item>
        </channel></rss>
        """,
        encoding="utf-8",
    )
    provider = RSSNewsProvider([str(feed)])

    rows, health = provider.fetch_latest(datetime.fromisoformat("2026-05-31T16:28:00+08:00"))

    personal = next(item for item in rows if item["title"].startswith("My husband"))
    macro = next(item for item in rows if item["title"].startswith("Gold rises"))
    assert personal["included"] is False
    assert personal["filter_reason"] == "personal_finance_noise"
    assert macro["included"] is True
    assert health.metadata["included_count"] == 1


def test_rss_provider_records_feed_preview_for_user_display(tmp_path) -> None:
    feed = tmp_path / "marketwatch.xml"
    feed.write_text(
        """
        <rss><channel>
          <title>MarketWatch Top Stories</title>
          <item>
            <title>Gold rises as dollar slips before Fed inflation data</title>
            <link>https://example.test/gold-dollar-fed</link>
            <description><![CDATA[
              <p>Gold moved higher while traders waited for the next inflation report.</p>
            ]]></description>
            <pubDate>Sun, 31 May 2026 06:13:28 GMT</pubDate>
          </item>
        </channel></rss>
        """,
        encoding="utf-8",
    )
    provider = RSSNewsProvider([str(feed)])

    rows, _ = provider.fetch_latest(datetime.fromisoformat("2026-05-31T16:28:00+08:00"))

    row = rows[0]
    assert row["preview"] == "Gold moved higher while traders waited for the next inflation report."
    assert row["description"] == row["preview"]
    assert row["link"] == "https://example.test/gold-dollar-fed"


def test_rss_provider_filters_stale_official_macro_releases(tmp_path) -> None:
    feed = tmp_path / "fed.xml"
    feed.write_text(
        """
        <rss><channel>
          <title>FRB: Press Release - All Releases</title>
          <item>
            <title>Federal Reserve issues FOMC statement</title>
            <link>https://example.test/old-fomc</link>
            <pubDate>Wed, 29 Apr 2026 18:00:00 GMT</pubDate>
          </item>
          <item>
            <title>Federal Reserve issues FOMC statement and holds rates steady</title>
            <link>https://example.test/current-fomc</link>
            <pubDate>Sat, 30 May 2026 18:00:00 GMT</pubDate>
          </item>
        </channel></rss>
        """,
        encoding="utf-8",
    )
    provider = RSSNewsProvider([str(feed)])

    rows, health = provider.fetch_latest(datetime.fromisoformat("2026-05-31T16:28:00+08:00"))

    old_release = next(item for item in rows if item["link"].endswith("old-fomc"))
    current_release = next(item for item in rows if item["link"].endswith("current-fomc"))
    assert old_release["included"] is False
    assert old_release["filter_reason"] == "stale_news_item"
    assert current_release["included"] is True
    assert health.metadata["included_count"] == 1


def test_rss_provider_does_not_treat_metaphorical_war_as_geopolitics(tmp_path) -> None:
    feed = tmp_path / "marketwatch.xml"
    feed.write_text(
        """
        <rss><channel>
          <title>MarketWatch Top Stories</title>
          <item>
            <title>America is losing the AI productivity war to 3.5 million STEM graduates</title>
            <link>https://example.test/ai-productivity-war</link>
            <pubDate>Sat, 30 May 2026 18:36:00 GMT</pubDate>
          </item>
          <item>
            <title>Oil exports through the Strait of Hormuz might not return after the Iran war</title>
            <link>https://example.test/oil-iran-war</link>
            <pubDate>Sat, 30 May 2026 18:37:00 GMT</pubDate>
          </item>
        </channel></rss>
        """,
        encoding="utf-8",
    )
    provider = RSSNewsProvider([str(feed)])

    rows, health = provider.fetch_latest(datetime.fromisoformat("2026-05-31T16:28:00+08:00"))

    metaphor = next(item for item in rows if item["link"].endswith("ai-productivity-war"))
    oil_geo = next(item for item in rows if item["link"].endswith("oil-iran-war"))
    assert metaphor["included"] is False
    assert metaphor["filter_reason"] == "no_market_agent_keyword"
    assert oil_geo["included"] is True
    assert health.metadata["included_count"] == 1


def test_rss_provider_does_not_treat_legal_fed_investigation_as_federal_reserve_signal(tmp_path) -> None:
    feed = tmp_path / "cnbc.xml"
    feed.write_text(
        """
        <rss><channel>
          <title>US Top News and Analysis</title>
          <item>
            <title>Pirro's losses in Fed investigation should stay on the books, judge rules</title>
            <link>https://example.test/legal-fed-investigation</link>
            <pubDate>Sat, 13 Jun 2026 00:19:00 GMT</pubDate>
          </item>
          <item>
            <title>Federal Reserve holds rates steady as FOMC watches inflation</title>
            <link>https://example.test/fomc-rates</link>
            <pubDate>Sat, 13 Jun 2026 00:20:00 GMT</pubDate>
          </item>
        </channel></rss>
        """,
        encoding="utf-8",
    )
    provider = RSSNewsProvider([str(feed)])

    rows, health = provider.fetch_latest(datetime.fromisoformat("2026-06-13T16:28:00+08:00"))

    legal = next(item for item in rows if item["link"].endswith("legal-fed-investigation"))
    macro = next(item for item in rows if item["link"].endswith("fomc-rates"))
    assert legal["included"] is False
    assert legal["filter_reason"] == "no_market_agent_keyword"
    assert "fed" not in legal["matched_keywords"]
    assert macro["included"] is True
    assert "fomc" in macro["matched_keywords"]
    assert health.metadata["included_count"] == 1


def test_rss_provider_filters_personal_finance_inflation_noise(tmp_path) -> None:
    feed = tmp_path / "marketwatch.xml"
    feed.write_text(
        """
        <rss><channel>
          <title>MarketWatch Top Stories</title>
          <item>
            <title>Social Security’s COLA could be 4.7% in 2027 as inflation hits the highest level in 3 years</title>
            <link>https://example.test/social-security-cola</link>
            <pubDate>Sat, 13 Jun 2026 19:00:00 GMT</pubDate>
          </item>
          <item>
            <title>Inflation jumps before CPI as bond yields pressure gold</title>
            <link>https://example.test/inflation-yields-gold</link>
            <pubDate>Sat, 13 Jun 2026 19:01:00 GMT</pubDate>
          </item>
        </channel></rss>
        """,
        encoding="utf-8",
    )
    provider = RSSNewsProvider([str(feed)])

    rows, health = provider.fetch_latest(datetime.fromisoformat("2026-06-14T04:28:00+08:00"))

    personal = next(item for item in rows if item["link"].endswith("social-security-cola"))
    macro = next(item for item in rows if item["link"].endswith("inflation-yields-gold"))
    assert personal["included"] is False
    assert personal["filter_reason"] == "personal_finance_noise"
    assert macro["included"] is True
    assert health.metadata["included_count"] == 1


def test_rss_provider_keeps_us_top_news_geopolitical_strikes(tmp_path) -> None:
    feed = tmp_path / "cnbc.xml"
    feed.write_text(
        """
        <rss><channel>
          <title>US Top News and Analysis</title>
          <item>
            <title>U.S. military begins strikes on multiple targets in Iran at Trump's direction</title>
            <link>https://example.test/us-strikes-iran</link>
            <pubDate>Thu, 11 Jun 2026 03:45:00 GMT</pubDate>
          </item>
        </channel></rss>
        """,
        encoding="utf-8",
    )
    provider = RSSNewsProvider([str(feed)])

    rows, health = provider.fetch_latest(datetime.fromisoformat("2026-06-11T11:50:00+08:00"))

    row = rows[0]
    assert row["included"] is True
    assert row["filter_reason"] == ""
    assert "strike" in row["matched_keywords"] or "strikes" in row["matched_keywords"]
    assert "iran" in row["matched_keywords"]
    assert health.metadata["included_count"] == 1
