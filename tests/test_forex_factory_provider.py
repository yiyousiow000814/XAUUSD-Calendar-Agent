from datetime import datetime
from pathlib import Path

from src.xauusd_market_agent.providers.forex_factory_provider import ForexFactoryProvider


def test_forex_factory_provider_parses_fixture_window() -> None:
    fixture_path = Path(__file__).parent / "fixtures" / "providers" / "forex_factory.json"
    provider = ForexFactoryProvider(fixture_path=fixture_path)

    rows, health = provider.fetch_window(datetime.fromisoformat("2026-05-19T07:15:00+08:00"))

    assert len(rows) == 1
    assert rows[0]["title"] == "CPI m/m"
    assert rows[0]["impact"] == "High"
    assert health.is_available is True
