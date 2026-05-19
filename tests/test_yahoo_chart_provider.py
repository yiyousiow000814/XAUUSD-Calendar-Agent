from datetime import datetime
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
