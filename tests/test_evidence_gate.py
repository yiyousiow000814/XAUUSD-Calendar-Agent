from src.xauusd_market_agent.evidence import build_evidence_gate_result
from src.xauusd_market_agent.fixtures import load_builtin_fixture


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
