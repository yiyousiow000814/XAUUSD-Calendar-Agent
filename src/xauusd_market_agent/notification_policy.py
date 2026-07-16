from __future__ import annotations

from datetime import datetime

from .models import AnalysisResult, MarketState, NotificationDecision
from .state import apply_state_transition


def _minutes_since(previous_iso: str, now_iso: str) -> float:
    if not previous_iso:
        return 1_000_000.0
    previous = datetime.fromisoformat(previous_iso)
    current = datetime.fromisoformat(now_iso)
    return (current - previous).total_seconds() / 60.0


def decide_notification(
    previous_state: MarketState,
    analysis_result: AnalysisResult,
    now_iso: str,
    cooldown_minutes: int,
) -> NotificationDecision:
    transition = apply_state_transition(previous_state, analysis_result, now_iso=now_iso)
    if not analysis_result.should_notify:
        return NotificationDecision(
            should_notify=False,
            notification_level="none",
            reason="Analysis result does not require notification.",
            next_state=transition.next_state,
            is_new_state=transition.is_new_state,
            is_continuation=transition.is_continuation,
            previous_state_invalidated=transition.previous_state_invalidated,
            state_change_reason=transition.state_change_reason,
            confidence_changed=transition.confidence_changed,
            confidence_delta=transition.confidence_delta,
            invalidation_triggered_by=transition.invalidation_triggered_by,
        )

    within_cooldown = _minutes_since(previous_state.last_alert_time, now_iso) < cooldown_minutes
    if within_cooldown and not transition.is_new_state:
        return NotificationDecision(
            should_notify=False,
            notification_level="none",
            reason="Same state remains inside notification cooldown.",
            next_state=transition.next_state,
            is_new_state=transition.is_new_state,
            is_continuation=transition.is_continuation,
            previous_state_invalidated=transition.previous_state_invalidated,
            state_change_reason=transition.state_change_reason,
            confidence_changed=transition.confidence_changed,
            confidence_delta=transition.confidence_delta,
            invalidation_triggered_by=transition.invalidation_triggered_by,
        )

    level = analysis_result.notification_level
    if transition.is_new_state and level == "level_1":
        level = "level_2"
    return NotificationDecision(
        should_notify=True,
        notification_level=level,
        reason="State changed or cooldown elapsed.",
        next_state=transition.next_state,
        is_new_state=transition.is_new_state,
        is_continuation=transition.is_continuation,
        previous_state_invalidated=transition.previous_state_invalidated,
        state_change_reason=transition.state_change_reason,
        confidence_changed=transition.confidence_changed,
        confidence_delta=transition.confidence_delta,
        invalidation_triggered_by=transition.invalidation_triggered_by,
    )
