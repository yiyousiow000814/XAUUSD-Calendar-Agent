from src.xauusd_market_agent.evidence import build_cross_asset_confirmation
from src.xauusd_market_agent.fixtures import load_builtin_fixture


def test_safe_haven_scenario_confirms_risk_off() -> None:
    confirmation = build_cross_asset_confirmation(load_builtin_fixture("safe_haven_rebound"))

    assert confirmation["vix_equities"] == "confirms"
    assert confirmation["us10y"] == "confirms"


def test_unconfirmed_scenario_stays_neutral() -> None:
    confirmation = build_cross_asset_confirmation(load_builtin_fixture("unconfirmed_move"))

    assert confirmation["dxy"] == "neutral"
    assert confirmation["us10y"] == "neutral"
