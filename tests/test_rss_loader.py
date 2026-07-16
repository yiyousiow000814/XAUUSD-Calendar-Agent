from src.xauusd_market_agent.providers.news_events import load_rss_headlines


def test_load_rss_headlines_supports_local_xml_feed(tmp_path) -> None:
    path = tmp_path / "feed.xml"
    path.write_text(
        """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <item>
      <title>Fed signals patience</title>
      <pubDate>Tue, 19 May 2026 00:10:00 +0800</pubDate>
      <link>https://example.com/fed</link>
    </item>
  </channel>
</rss>
""",
        encoding="utf-8",
    )

    items = load_rss_headlines([str(path)])

    assert len(items) == 1
    assert items[0]["title"] == "Fed signals patience"
