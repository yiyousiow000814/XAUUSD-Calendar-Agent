from src.xauusd_market_agent.fixtures import load_builtin_fixture
from src.xauusd_market_agent.models import MarketState
from src.xauusd_market_agent.notification_policy import decide_notification


def test_notification_policy_suppresses_same_state_inside_cooldown() -> None:
    previous = MarketState(
        current_bias="bearish_gold",
        main_driver="yields",
        secondary_driver="usd",
        risk_driver=None,
        confidence="high",
        last_alert_time="2026-05-19T00:00:00+08:00",
        last_alert_summary="Gold remains under pressure from rising yields and a firmer dollar.",
        invalidation_conditions=[],
    )
    result = load_builtin_fixture("yield_pressure_confirmed").expected_rule_based_result

    decision = decide_notification(
        previous_state=previous,
        analysis_result=result,
        now_iso="2026-05-19T00:05:00+08:00",
        cooldown_minutes=30,
    )

    assert decision.should_notify is False


def test_notification_policy_allows_changed_driver_even_inside_cooldown() -> None:
    previous = MarketState(
        current_bias="bearish_gold",
        main_driver="yields",
        secondary_driver="usd",
        risk_driver=None,
        confidence="high",
        last_alert_time="2026-05-19T00:00:00+08:00",
        last_alert_summary="Gold remains under pressure from rising yields and a firmer dollar.",
        invalidation_conditions=[],
    )
    result = load_builtin_fixture("safe_haven_rebound").expected_rule_based_result

    decision = decide_notification(
        previous_state=previous,
        analysis_result=result,
        now_iso="2026-05-19T00:05:00+08:00",
        cooldown_minutes=30,
    )

    assert decision.should_notify is True
    assert decision.notification_level == "level_3"


def test_notification_policy_exposes_transition_metadata() -> None:
    previous = MarketState(
        current_bias="bearish_gold",
        main_driver="yields",
        secondary_driver="usd",
        risk_driver=None,
        confidence="high",
        last_alert_time="2026-05-19T00:00:00+08:00",
        last_alert_summary="Gold remains under pressure from rising yields and a firmer dollar.",
        cause_status="confirmed",
        invalidation_conditions=["US10Y drops more than 7 bps"],
    )
    result = load_builtin_fixture("unconfirmed_move").expected_rule_based_result

    decision = decide_notification(
        previous_state=previous,
        analysis_result=result,
        now_iso="2026-05-19T00:35:00+08:00",
        cooldown_minutes=30,
    )

    assert decision.confidence_changed is True
    assert decision.confidence_delta == "decreased"
    assert decision.previous_state_invalidated is True
    assert decision.state_change_reason
