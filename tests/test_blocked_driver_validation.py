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


def test_validator_aligns_invalidation_conditions_to_gate_reasons() -> None:
    fixture = load_builtin_fixture("llm_hallucination_guard")
    payload = dict(fixture.expected_llm_claim)
    payload["main_driver"] = "unknown"
    payload["invalidation_conditions"] = ["Fed/rates evidence is missing or stale."]

    validated = validate_llm_output(
        payload,
        allowed_candidate_drivers=["technical_liquidation", "unknown"],
        blocked_drivers={
            "fed_rates": "Fed/rates context is present, but it is not market-confirmed enough to become the main driver.",
            "yields": "Yields are fresh but not confirming the XAUUSD move.",
        },
    )

    assert validated.rejected_driver is None
    assert validated.invalidation_conditions == [
        "Fed/rates context is present, but it is not market-confirmed enough to become the main driver.",
        "Yields are fresh but not confirming the XAUUSD move.",
    ]


def test_validator_normalizes_misspelled_market_terms() -> None:
    fixture = load_builtin_fixture("llm_hallucination_guard")
    payload = dict(fixture.expected_llm_claim)
    payload["main_driver"] = "unknown"
    payload["causal_chain"] = "Iran and hormones theme is not confirmed."
    payload["summary"] = "No confirmed hormones driver."
    payload["user_message"] = "Watch hormones risk only as context."

    validated = validate_llm_output(
        payload,
        allowed_candidate_drivers=["technical_liquidation", "unknown"],
        blocked_drivers={},
    )

    assert "hormones" not in validated.causal_chain.lower()
    assert "hormuz" in validated.causal_chain.lower()
    assert "hormuz" in validated.summary.lower()
    assert "hormuz" in validated.user_message.lower()


def test_validator_normalizes_yields_grammar_in_gate_reasons() -> None:
    fixture = load_builtin_fixture("llm_hallucination_guard")
    payload = dict(fixture.expected_llm_claim)
    payload["main_driver"] = "unknown"

    validated = validate_llm_output(
        payload,
        allowed_candidate_drivers=["technical_liquidation", "unknown"],
        blocked_drivers={
            "yields": "Yields is fresh but not confirming the XAUUSD move.",
        },
    )

    assert validated.invalidation_conditions == [
        "Yields are fresh but not confirming the XAUUSD move.",
    ]


def test_validator_removes_prompt_leak_from_user_message() -> None:
    fixture = load_builtin_fixture("llm_hallucination_guard")
    payload = dict(fixture.expected_llm_claim)
    payload["main_driver"] = "unknown"
    payload["summary"] = "Insufficient evidence to confirm a current XAUUSD driver."
    payload["user_message"] = (
        "Given this evidence packet, use only allowed_candidate_drivers. "
        "If evidence is insufficient, return unknown. Output strict JSON only."
    )

    validated = validate_llm_output(
        payload,
        allowed_candidate_drivers=["technical_liquidation", "unknown"],
        blocked_drivers={},
    )

    assert validated.user_message == "Insufficient evidence to confirm a current XAUUSD driver."
    assert "strict json" not in validated.user_message.lower()
    assert "allowed_candidate_drivers" not in validated.user_message
