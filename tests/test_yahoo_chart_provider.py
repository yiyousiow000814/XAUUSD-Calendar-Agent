from datetime import datetime
import json
from pathlib import Path

from src.xauusd_market_agent.providers.yahoo_chart import YahooChartProvider


FIXTURE_DIR = Path(__file__).parent / "fixtures" / "providers"


def test_yahoo_chart_provider_parses_fixture_and_computes_changes() -> None:
    provider = YahooChartProvider(fixture_dir=FIXTURE_DIR)

    rows, health = provider.fetch_series(
        "GC=F",
        datetime.fromisoformat("2026-05-19T06:50:00+08:00"),
        datetime.fromisoformat("2026-05-19T07:20:00+08:00"),
    )

    assert len(rows) == 5
    assert rows[-1]["source_type"] == "futures_proxy"
    assert rows[-1]["timestamp"] == "2026-05-19T07:20:00+08:00"
    assert rows[-1]["change_15m"] > 0
    assert rows[-1]["change_30m"] > 0
    assert rows[-1]["change_60m"] > 0
    assert health.data_mode == "proxy"
    assert health.change_value == rows[-1]["change_15m"]


def test_yahoo_chart_provider_marks_stale_latest_point() -> None:
    provider = YahooChartProvider(fixture_dir=FIXTURE_DIR)

    rows, health = provider.fetch_series(
        "^TNX",
        datetime.fromisoformat("2026-05-19T06:50:00+08:00"),
        datetime.fromisoformat("2026-05-19T08:00:00+08:00"),
    )

    assert rows[-1]["is_stale"] is True
    assert health.is_stale is True
    assert health.stale_reason


def test_yahoo_chart_provider_allows_short_proxy_delay_for_dxy() -> None:
    payload = {
        "chart": {
            "result": [
                {
                    "timestamp": [
                        int(datetime.fromisoformat("2026-06-11T11:20:00+08:00").timestamp()),
                        int(datetime.fromisoformat("2026-06-11T11:30:00+08:00").timestamp()),
                    ],
                    "indicators": {
                        "quote": [
                            {
                                "open": [100.0, 100.1],
                                "high": [100.2, 100.3],
                                "low": [99.9, 100.0],
                                "close": [100.0, 100.2],
                            }
                        ]
                    },
                }
            ]
        }
    }

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return payload

    class FakeSession:
        def get(self, url, timeout):
            return FakeResponse()

    provider = YahooChartProvider(session=FakeSession())

    rows, health = provider.fetch_series(
        "DX-Y.NYB",
        datetime.fromisoformat("2026-06-11T11:00:00+08:00"),
        datetime.fromisoformat("2026-06-11T11:45:00+08:00"),
    )

    assert rows[-1]["is_stale"] is False
    assert health.is_stale is False


def test_yahoo_chart_provider_allows_delayed_nasdaq_futures() -> None:
    payload = {
        "chart": {
            "result": [
                {
                    "timestamp": [
                        int(datetime.fromisoformat("2026-06-12T15:30:00+08:00").timestamp()),
                        int(datetime.fromisoformat("2026-06-12T15:45:00+08:00").timestamp()),
                    ],
                    "indicators": {
                        "quote": [
                            {
                                "open": [29300.0, 29320.0],
                                "high": [29330.0, 29360.0],
                                "low": [29290.0, 29310.0],
                                "close": [29310.0, 29350.0],
                            }
                        ]
                    },
                }
            ]
        }
    }

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return payload

    class FakeSession:
        def get(self, url, timeout):
            return FakeResponse()

    provider = YahooChartProvider(session=FakeSession())

    rows, health = provider.fetch_series(
        "NQ=F",
        datetime.fromisoformat("2026-06-12T15:00:00+08:00"),
        datetime.fromisoformat("2026-06-12T16:10:00+08:00"),
    )

    assert rows[-1]["is_stale"] is False
    assert health.is_stale is False


def test_yahoo_related_asset_retries_with_wider_window_when_market_is_closed() -> None:
    calls = []
    empty_payload = {
        "chart": {
            "result": [
                {
                    "timestamp": [],
                    "indicators": {"quote": [{"open": [], "high": [], "low": [], "close": []}]},
                }
            ]
        }
    }
    stale_payload = json.loads((FIXTURE_DIR / "_TNX_5m.json").read_text(encoding="utf-8"))

    class FakeResponse:
        def __init__(self, payload):
            self._payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self._payload

    class FakeSession:
        def get(self, url, timeout):
            calls.append(url)
            return FakeResponse(empty_payload if len(calls) == 1 else stale_payload)

    provider = YahooChartProvider(session=FakeSession())

    rows, health = provider.fetch_related_asset(
        "^TNX",
        datetime.fromisoformat("2026-05-23T17:20:00+08:00"),
    )

    assert len(calls) == 2
    assert rows
    assert rows[-1]["is_stale"] is True
    assert health.is_available is True
    assert health.is_stale is True
    assert health.data_mode == "live_seen"
    assert "older than freshness threshold" in health.stale_reason


def test_yahoo_chart_provider_uses_browser_user_agent_for_remote_fetch(monkeypatch) -> None:
    captured = {}

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return b'{"chart":{"result":[{"timestamp":[],"indicators":{"quote":[{"open":[],"high":[],"low":[],"close":[]}]}}]}}'

    def fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        captured["user_agent"] = request.headers.get("User-agent") or request.headers.get("User-Agent")
        captured["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr("src.xauusd_market_agent.providers.yahoo_chart.urlopen", fake_urlopen)
    provider = YahooChartProvider()

    provider.fetch_series(
        "GC=F",
        datetime.fromisoformat("2026-05-19T06:50:00+08:00"),
        datetime.fromisoformat("2026-05-19T07:20:00+08:00"),
    )

    assert "GC=F" in captured["url"]
    assert "Mozilla" in captured["user_agent"]
    assert captured["timeout"] == 15
