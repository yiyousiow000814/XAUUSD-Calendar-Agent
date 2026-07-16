from __future__ import annotations

from .models import ScenarioFixture, TriggerDecision

DEFAULT_THRESHOLDS = {
    "xau_move_15m_pct": 0.35,
    "xau_move_1h_pct": 0.7,
}


def detect_market_trigger(
    fixture: ScenarioFixture,
    thresholds: dict[str, float] | None = None,
) -> TriggerDecision:
    thresholds = thresholds or DEFAULT_THRESHOLDS
    trigger_types: list[str] = []
    market = fixture.market
    if abs(market.move_percent_15m) >= thresholds["xau_move_15m_pct"]:
        trigger_types.append("move_15m")
    if abs(market.move_percent_1h) >= thresholds["xau_move_1h_pct"]:
        trigger_types.append("move_1h")
    if market.breaks:
        trigger_types.append("session_break")
    return TriggerDecision(triggered=bool(trigger_types), trigger_types=trigger_types)
