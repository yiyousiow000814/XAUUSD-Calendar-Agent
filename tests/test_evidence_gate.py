from src.xauusd_market_agent.evidence import build_evidence_gate_result
from src.xauusd_market_agent.fixtures import load_builtin_fixture
from src.xauusd_market_agent.provider_health import build_fixture_provider_health, build_provider_health


def test_yield_pressure_scenario_allows_usd_and_yields() -> None:
    result = build_evidence_gate_result(load_builtin_fixture("yield_pressure_confirmed"))

    assert "usd" in result.allowed_candidate_drivers
    assert "yields" in result.allowed_candidate_drivers
    assert "geopolitics" in result.blocked_drivers


def test_unconfirmed_scenario_blocks_macro_drivers() -> None:
    result = build_evidence_gate_result(load_builtin_fixture("unconfirmed_move"))

    assert result.allowed_candidate_drivers == ["technical_liquidation", "unknown"]
    assert "usd" in result.blocked_drivers
    assert "yields" in result.blocked_drivers


def test_oil_move_alone_stays_background_without_channel_confirmation() -> None:
    fixture = load_builtin_fixture("oil_inflation_pressure")
    health = build_fixture_provider_health(fixture)
    health["us10y"] = build_provider_health(
        source="US10Y",
        source_type="related_asset",
        data_mode="unavailable",
        is_available=False,
        error="No yield data.",
    )
    health["us2y"] = build_provider_health(
        source="US2Y",
        source_type="related_asset",
        data_mode="unavailable",
        is_available=False,
        error="No yield data.",
    )

    result = build_evidence_gate_result(fixture, provider_health=health)

    assert "oil_inflation" not in result.allowed_candidate_drivers
    assert result.evidence_status["oil"] in {"not_confirming", "neutral", "confirming"}


def test_geopolitics_is_blocked_without_timestamped_headline() -> None:
    result = build_evidence_gate_result(load_builtin_fixture("yield_pressure_confirmed"))

    assert "geopolitics" not in result.allowed_candidate_drivers
    assert result.blocked_drivers["geopolitics"]
