from src.xauusd_market_agent.fixtures import load_builtin_fixture
from src.xauusd_market_agent.pipeline import analyze_fixture_with_optional_llm


class FakeRepairingLLM:
    def __init__(self) -> None:
        self.calls = 0

    def analyze(self, evidence_packet, repair: bool = False):
        self.calls += 1
        if not repair:
            return {"bad": "payload"}
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
            "notification_level": "level_3",
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


class FakeBrokenLLM:
    def analyze(self, evidence_packet, repair: bool = False):
        return {"bad": "payload"}


def test_llm_invalid_json_triggers_one_repair_attempt() -> None:
    fixture = load_builtin_fixture("yield_pressure_confirmed")
    llm = FakeRepairingLLM()

    result = analyze_fixture_with_optional_llm(fixture, llm_client=llm)

    assert result.main_driver == "yields"
    assert llm.calls == 2


def test_llm_invalid_json_falls_back_after_failed_repair() -> None:
    fixture = load_builtin_fixture("yield_pressure_confirmed")

    result = analyze_fixture_with_optional_llm(fixture, llm_client=FakeBrokenLLM())

    assert result.main_driver == "yields"
    assert result.notification_level == "level_3"
