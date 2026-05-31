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
