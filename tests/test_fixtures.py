from pathlib import Path

from src.xauusd_market_agent.fixtures import load_scenario_fixture


def test_load_scenario_fixture_returns_named_scenario() -> None:
    fixture = load_scenario_fixture(
        Path("tests/fixtures/market_agent"),
        "yield_pressure_confirmed",
    )

    assert fixture.scenario_id == "yield_pressure_confirmed"
    assert fixture.market.symbol == "XAUUSD"
    assert fixture.market.move_percent == -0.48
