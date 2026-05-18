from __future__ import annotations

from .models import AnalysisResult, ScenarioFixture


def render_text_report(fixture: ScenarioFixture, result: AnalysisResult) -> str:
    lines = [
        "[XAUUSD Situation Alert]" if result.should_notify else "[XAUUSD Dry Run]",
        f"Time: {fixture.as_of_myt} MYT",
        "",
        "Market move:",
        (
            f"{fixture.market.symbol} moved from {fixture.market.from_price:.1f} to "
            f"{fixture.market.to_price:.1f} in {fixture.market.window_minutes} minutes "
            f"({fixture.market.move_percent:+.2f}%)."
        ),
        (
            f"DXY {fixture.cross_asset.dxy_percent:+.2f}%, "
            f"US10Y {fixture.cross_asset.us10y_bps:+.1f} bps, "
            f"WTI {fixture.cross_asset.wti_percent:+.1f}%."
        ),
        "",
        "Cross-asset check:",
        f"DXY: {result.cross_asset_confirmation['dxy']}",
        f"US10Y: {result.cross_asset_confirmation['us10y']}",
        f"US2Y: {result.cross_asset_confirmation['us2y']}",
        f"Oil: {result.cross_asset_confirmation['oil']}",
        f"VIX/Equities: {result.cross_asset_confirmation['vix_equities']}",
        "",
        f"Main driver: {result.main_driver}",
        f"Cause status: {result.cause_status}",
        f"Bias: {result.bias}",
        f"Confidence: {result.confidence}",
        f"State: {'new state' if result.is_new_state else 'continuation'}",
        "",
        "Conclusion:",
        result.causal_chain,
        "",
        "User message:",
        result.user_message,
    ]
    if result.timeline:
        lines.extend(["", "Timeline:"])
        for entry in result.timeline:
            lines.append(f"{entry['time_myt']} - {entry['event']} ({entry['source_type']})")
    if result.invalidation_conditions:
        lines.extend(["", "Invalidation:"])
        for condition in result.invalidation_conditions:
            lines.append(f"- {condition}")
    return "\n".join(lines)
