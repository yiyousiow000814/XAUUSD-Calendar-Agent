from src.xauusd_market_agent.evidence import build_cross_asset_confirmation, build_evidence_gate_result
from src.xauusd_market_agent.fixtures import load_builtin_fixture
from src.xauusd_market_agent.provider_health import build_fixture_provider_health, build_provider_health


def test_stale_dxy_cannot_confirm_usd() -> None:
    fixture = load_builtin_fixture("yield_pressure_confirmed")
    health = build_fixture_provider_health(fixture)
    health["dxy"] = build_provider_health(
        source="DXY",
        source_type="related_asset",
        data_mode="stale",
        is_stale=True,
        stale_reason="Quote older than threshold.",
        change_value=fixture.cross_asset.dxy_percent,
        change_unit="percent",
    )

    confirmation = build_cross_asset_confirmation(fixture, provider_health=health)

    assert confirmation["dxy"] == "stale"


def test_unavailable_us10y_cannot_confirm_yields() -> None:
    fixture = load_builtin_fixture("yield_pressure_confirmed")
    health = build_fixture_provider_health(fixture)
    health["us10y"] = build_provider_health(
        source="US10Y",
        source_type="related_asset",
        data_mode="unavailable",
        is_available=False,
        error="Source failed.",
    )
    health["us2y"] = build_provider_health(
        source="US2Y",
        source_type="related_asset",
        data_mode="unavailable",
        is_available=False,
        error="Source failed.",
    )

    result = build_evidence_gate_result(fixture, provider_health=health)

    assert "yields" not in result.allowed_candidate_drivers
    assert result.evidence_status["us10y"] == "unavailable"
    assert result.evidence_status["us2y"] == "unavailable"


def test_fresh_provider_health_keeps_structural_confirmation_available() -> None:
    fixture = load_builtin_fixture("yield_pressure_confirmed")
    health = build_fixture_provider_health(fixture)

    result = build_evidence_gate_result(fixture, provider_health=health)

    assert "usd" in result.allowed_candidate_drivers
    assert "yields" in result.allowed_candidate_drivers
