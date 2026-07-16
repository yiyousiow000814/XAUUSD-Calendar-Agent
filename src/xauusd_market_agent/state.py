from __future__ import annotations

from .models import AnalysisResult, MarketState, TransitionResult


_CONFIDENCE_ORDER = {
    "low": 0,
    "medium": 1,
    "high": 2,
}


def _confidence_delta(previous_confidence: str, current_confidence: str) -> str:
    previous_rank = _CONFIDENCE_ORDER.get(previous_confidence, 0)
    current_rank = _CONFIDENCE_ORDER.get(current_confidence, 0)
    if current_rank > previous_rank:
        return "increased"
    if current_rank < previous_rank:
        return "decreased"
    return "unchanged"


def _build_state_change_reason(
    previous_state: MarketState,
    analysis_result: AnalysisResult,
    confidence_delta: str,
) -> str:
    reasons: list[str] = []
    if previous_state.current_bias != analysis_result.bias:
        reasons.append(
            f"bias {previous_state.current_bias or 'unknown'} -> {analysis_result.bias}"
        )
    if previous_state.main_driver != analysis_result.main_driver:
        reasons.append(
            f"main_driver {previous_state.main_driver or 'unknown'} -> {analysis_result.main_driver}"
        )
    if previous_state.secondary_driver != analysis_result.secondary_driver:
        reasons.append(
            "secondary_driver "
            f"{previous_state.secondary_driver or 'none'} -> {analysis_result.secondary_driver or 'none'}"
        )
    if previous_state.cause_status != analysis_result.cause_status:
        reasons.append(
            f"cause_status {previous_state.cause_status or 'unknown'} -> {analysis_result.cause_status}"
        )
    if confidence_delta != "unchanged":
        reasons.append(f"confidence {confidence_delta}")
    if not reasons:
        return "No meaningful state-field change."
    return "; ".join(reasons)


def _derive_invalidation_triggered_by(
    previous_state: MarketState,
    analysis_result: AnalysisResult,
) -> list[str]:
    triggers: list[str] = []
    if previous_state.current_bias in {"bearish_gold", "bullish_gold"} and (
        analysis_result.bias != previous_state.current_bias
    ):
        triggers.append(
            f"bias flipped from {previous_state.current_bias} to {analysis_result.bias}"
        )
    if previous_state.main_driver not in {"", "unknown"} and (
        analysis_result.main_driver not in {previous_state.main_driver, "unknown"}
    ):
        triggers.append(
            "main driver changed from "
            f"{previous_state.main_driver} to {analysis_result.main_driver}"
        )
    if previous_state.confidence == "high" and analysis_result.confidence == "low":
        triggers.append("confidence dropped from high to low")
    if analysis_result.cause_status in {"unconfirmed", "no_news_found"}:
        triggers.append(
            f"current cause status is {analysis_result.cause_status}, so the prior thesis lost confirmation"
        )
    return triggers


def _is_previous_state_invalidated(
    previous_state: MarketState,
    analysis_result: AnalysisResult,
    is_new_state: bool,
) -> tuple[bool, list[str]]:
    if not is_new_state or not previous_state.last_alert_summary:
        return False, []
    if analysis_result.cause_status == "no_meaningful_change":
        return False, []
    triggers = _derive_invalidation_triggered_by(previous_state, analysis_result)
    return bool(triggers), triggers


def empty_market_state(
    main_driver: str = "unknown",
    current_bias: str = "unknown",
) -> MarketState:
    return MarketState(
        current_bias=current_bias,
        main_driver=main_driver,
        secondary_driver=None,
        risk_driver=None,
        confidence="low",
        last_alert_time="",
        last_alert_summary="",
        cause_status="unconfirmed",
        last_analysis_time="",
        last_notification_level="none",
        state_change_reason="",
        invalidation_triggered=False,
        invalidation_triggered_by=[],
        invalidation_conditions=[],
    )


def apply_state_transition(
    previous_state: MarketState,
    analysis_result: AnalysisResult,
    now_iso: str,
) -> TransitionResult:
    confidence_delta = _confidence_delta(previous_state.confidence, analysis_result.confidence)
    is_material_state_change = (
        previous_state.main_driver != analysis_result.main_driver
        or previous_state.current_bias != analysis_result.bias
        or previous_state.secondary_driver != analysis_result.secondary_driver
    )
    previous_state_invalidated, invalidation_triggered_by = _is_previous_state_invalidated(
        previous_state=previous_state,
        analysis_result=analysis_result,
        is_new_state=is_material_state_change,
    )
    state_change_reason = _build_state_change_reason(
        previous_state=previous_state,
        analysis_result=analysis_result,
        confidence_delta=confidence_delta,
    )
    next_state = MarketState(
        current_bias=analysis_result.bias,
        main_driver=analysis_result.main_driver,
        secondary_driver=analysis_result.secondary_driver,
        risk_driver=analysis_result.main_driver
        if analysis_result.main_driver in {"risk_sentiment", "geopolitics"}
        else None,
        confidence=analysis_result.confidence,
        last_alert_time=now_iso if analysis_result.should_notify else previous_state.last_alert_time,
        last_alert_summary=analysis_result.user_message if analysis_result.should_notify else previous_state.last_alert_summary,
        cause_status=analysis_result.cause_status,
        last_analysis_time=now_iso,
        last_notification_level=analysis_result.notification_level if analysis_result.should_notify else "none",
        state_change_reason=state_change_reason,
        invalidation_triggered=previous_state_invalidated,
        invalidation_triggered_by=invalidation_triggered_by,
        invalidation_conditions=list(analysis_result.invalidation_conditions),
    )
    return TransitionResult(
        next_state=next_state,
        should_notify=analysis_result.should_notify and is_material_state_change,
        is_new_state=is_material_state_change,
        is_continuation=not is_material_state_change and analysis_result.should_notify,
        previous_state_invalidated=previous_state_invalidated,
        state_change_reason=state_change_reason,
        confidence_changed=confidence_delta != "unchanged",
        confidence_delta=confidence_delta,
        invalidation_triggered_by=invalidation_triggered_by,
    )
