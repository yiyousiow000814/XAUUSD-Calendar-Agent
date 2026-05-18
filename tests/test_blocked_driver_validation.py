from src.xauusd_market_agent.fixtures import load_builtin_fixture
from src.xauusd_market_agent.validator import validate_llm_output


def test_validator_rejects_blocked_driver_claim() -> None:
    fixture = load_builtin_fixture("llm_hallucination_guard")
    validated = validate_llm_output(
        fixture.expected_llm_claim,
        allowed_candidate_drivers=["technical_liquidation", "unknown"],
        blocked_drivers={"fed_rates": "No Fed headline and yields did not confirm."},
    )

    assert validated.main_driver == "unknown"
    assert validated.rejected_driver == "fed_rates"
    assert validated.rejection_reason == "No Fed headline and yields did not confirm."
