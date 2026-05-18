from src.xauusd_market_agent.fixtures import load_builtin_fixture
from src.xauusd_market_agent.pipeline import analyze_fixture_with_optional_llm


class FakeAllowedLLM:
    def analyze(self, evidence_packet):
        return {
            "bias": "bearish_gold",
            "main_driver": "yields",
            "secondary_driver": "usd",
            "cause_status": "likely",
            "confidence": "high",
            "is_new_state": True,
            "is_continuation": False,
            "previous_state_invalidated": False,
            "should_notify": True,
            "notification_level": "level_2",
            "no_news_found": False,
            "allowed_candidate_drivers_used": ["yields", "usd"],
            "rejected_or_blocked_drivers_acknowledged": True,
            "timeline": [],
            "cross_asset_confirmation": {
                "dxy": "confirms",
                "us10y": "confirms",
                "us2y": "confirms",
                "oil": "neutral",
                "vix_equities": "neutral",
            },
            "evidence_status": {
                "dxy": "confirming",
                "us10y": "confirming",
                "us2y": "confirming",
                "oil": "not_confirming",
                "vix_equities": "not_confirming",
                "news": "relevant_news_found",
            },
            "causal_chain": "Rates pressure remains the main driver.",
            "invalidation_conditions": ["US10Y drops more than 7 bps"],
            "user_message": "Gold remains under pressure from rising yields and a firmer dollar.",
        }


class FakeBlockedLLM:
    def analyze(self, evidence_packet):
        return {
            "bias": "bearish_gold",
            "main_driver": "fed_rates",
            "secondary_driver": None,
            "cause_status": "possible",
            "confidence": "medium",
            "is_new_state": True,
            "is_continuation": False,
            "previous_state_invalidated": False,
            "should_notify": True,
            "notification_level": "level_2",
            "no_news_found": True,
            "allowed_candidate_drivers_used": ["fed_rates"],
            "rejected_or_blocked_drivers_acknowledged": False,
            "timeline": [],
            "cross_asset_confirmation": {
                "dxy": "neutral",
                "us10y": "neutral",
                "us2y": "neutral",
                "oil": "neutral",
                "vix_equities": "neutral",
            },
            "evidence_status": {
                "dxy": "not_confirming",
                "us10y": "not_confirming",
                "us2y": "not_confirming",
                "oil": "not_confirming",
                "vix_equities": "not_confirming",
                "news": "no_relevant_news_found",
            },
            "causal_chain": "Fed pressure likely drove gold lower.",
            "invalidation_conditions": [],
            "user_message": "Fed pressure hit gold.",
        }


def test_analyze_fixture_with_optional_llm_accepts_allowed_driver() -> None:
    fixture = load_builtin_fixture("yield_pressure_confirmed")

    result = analyze_fixture_with_optional_llm(fixture, llm_client=FakeAllowedLLM())

    assert result.main_driver == "yields"
    assert result.secondary_driver == "usd"


def test_analyze_fixture_with_optional_llm_rejects_blocked_driver() -> None:
    fixture = load_builtin_fixture("llm_hallucination_guard")

    result = analyze_fixture_with_optional_llm(fixture, llm_client=FakeBlockedLLM())

    assert result.main_driver == "unknown"
    assert result.rejected_driver == "fed_rates"
