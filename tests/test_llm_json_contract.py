from src.xauusd_market_agent.fixtures import load_builtin_fixture
from src.xauusd_market_agent.validator import validate_llm_output


def test_rule_based_output_matches_required_contract() -> None:
    fixture = load_builtin_fixture("yield_pressure_confirmed")
    validated = validate_llm_output(
        fixture.expected_rule_based_result.to_dict(),
        allowed_candidate_drivers=["usd", "yields", "fed_rates"],
        blocked_drivers={},
    )

    assert validated.main_driver == "yields"
    assert validated.notification_level == "level_3"
    assert validated.user_message
