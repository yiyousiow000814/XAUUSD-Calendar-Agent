from src.xauusd_market_agent.fixtures import load_builtin_fixture
from src.xauusd_market_agent.state import MarketState, apply_state_transition


def test_state_changes_when_main_driver_changes() -> None:
    previous = MarketState(
        current_bias="bearish_gold",
        main_driver="yields",
        secondary_driver="usd",
        risk_driver=None,
        confidence="medium",
        last_alert_time="2026-05-18T15:42:00+08:00",
        last_alert_summary="Gold pressured by rising yields and stronger DXY.",
        invalidation_conditions=["US10Y drops more than 7 bps"],
    )

    analysis = load_builtin_fixture("safe_haven_rebound")
    transition = apply_state_transition(
        previous,
        analysis_result=analysis.expected_rule_based_result,
        now_iso="2026-05-19T00:00:00+08:00",
    )

    assert transition.next_state.main_driver == "risk_sentiment"
    assert transition.should_notify is True
    assert transition.is_new_state is True


def test_previous_state_is_not_invalidated_by_no_meaningful_change() -> None:
    previous = MarketState(
        current_bias="bearish_gold",
        main_driver="yields",
        secondary_driver="usd",
        risk_driver=None,
        confidence="high",
        last_alert_time="2026-05-19T00:00:00+08:00",
        last_alert_summary="Gold remains under pressure from rising yields and a firmer dollar.",
        invalidation_conditions=["US10Y drops more than 7 bps"],
    )

    analysis = load_builtin_fixture("no_meaningful_change")
    transition = apply_state_transition(
        previous,
        analysis_result=analysis.expected_rule_based_result,
        now_iso="2026-05-19T00:10:00+08:00",
    )

    assert transition.previous_state_invalidated is False


def test_state_transition_tracks_invalidation_and_confidence_drop() -> None:
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

    analysis = load_builtin_fixture("unconfirmed_move")
    transition = apply_state_transition(
        previous,
        analysis_result=analysis.expected_rule_based_result,
        now_iso="2026-05-19T00:10:00+08:00",
    )

    assert transition.previous_state_invalidated is True
    assert transition.confidence_changed is True
    assert transition.confidence_delta == "decreased"
    assert transition.invalidation_triggered_by
    assert "main_driver yields -> unknown" in transition.state_change_reason
