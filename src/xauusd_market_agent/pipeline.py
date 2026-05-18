from __future__ import annotations

from dataclasses import asdict

from .detectors import detect_market_trigger
from .evidence import build_evidence_gate_result
from .models import AnalysisResult, MarketState, ScenarioFixture
from .validator import validate_llm_output


def _bias_for_move(fixture: ScenarioFixture) -> str:
    if fixture.market.move_percent > 0:
        return "bullish_gold"
    if fixture.market.move_percent < 0:
        return "bearish_gold"
    return "neutral"


def _driver_summary(main_driver: str) -> tuple[str, list[str]]:
    mapping = {
        "yields": (
            "Gold is under rates/yields pressure with DXY support.",
            [
                "US10Y drops more than 7 bps from the alert level",
                "DXY falls below the previous session low",
                "XAUUSD reclaims the London open level",
            ],
        ),
        "oil_inflation": (
            "Oil strength is feeding inflation expectations and lifting yields, which pressures gold.",
            [
                "WTI and Brent reverse lower by more than 1.0%",
                "US10Y gives back more than 5 bps",
            ],
        ),
        "risk_sentiment": (
            "Risk-off flow, higher VIX, and lower yields are supporting safe-haven demand for gold.",
            [
                "VIX fades back below the spike zone",
                "SPX and Nasdaq recover sharply",
                "US10Y rebounds more than 5 bps",
            ],
        ),
        "technical_liquidation": (
            "The move looks technical or liquidity-driven because macro and news confirmation is missing.",
            [
                "DXY or yields start confirming the move",
                "A relevant headline appears inside the monitored window",
            ],
        ),
        "unknown": (
            "No confirmed macro/news driver was found.",
            [
                "DXY or yields start confirming the move",
                "A relevant headline appears inside the monitored window",
            ],
        ),
    }
    return mapping.get(main_driver, mapping["unknown"])


def _select_main_driver(allowed: list[str], bias: str) -> tuple[str, str | None]:
    if bias == "bullish_gold" and "risk_sentiment" in allowed:
        return "risk_sentiment", "yields" if "yields" in allowed else None
    if "oil_inflation" in allowed:
        return "oil_inflation", "yields" if "yields" in allowed else None
    if "yields" in allowed:
        return "yields", "usd" if "usd" in allowed else None
    if "usd" in allowed:
        return "usd", None
    if "geopolitics" in allowed:
        return "geopolitics", None
    if "technical_liquidation" in allowed:
        return "technical_liquidation", None
    return "unknown", None


def _timeline(fixture: ScenarioFixture) -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []
    for event in fixture.calendar_events:
        entries.append(
            {
                "time_myt": event.timestamp_myt.split()[-1][:5],
                "event": event.title,
                "source_type": "economic_calendar",
                "impact_on_gold": event.impact_direction_on_gold,
            }
        )
    for news in fixture.news:
        entries.append(
            {
                "time_myt": news.timestamp_myt.split()[-1][:5],
                "event": news.title,
                "source_type": "news",
                "impact_on_gold": news.impact_direction_on_gold,
            }
        )
    if fixture.cross_asset.us10y_bps:
        entries.append(
            {
                "time_myt": fixture.as_of_myt.split()[-1][:5],
                "event": f"US10Y moved {fixture.cross_asset.us10y_bps:+.1f} bps",
                "source_type": "market_data",
                "impact_on_gold": "bearish" if fixture.cross_asset.us10y_bps > 0 else "bullish",
            }
        )
    return entries


def build_llm_evidence_packet(
    fixture: ScenarioFixture,
    previous_state: MarketState | dict[str, object] | None = None,
) -> dict[str, object]:
    evidence = build_evidence_gate_result(fixture)
    normalized_previous_state = asdict(previous_state) if isinstance(previous_state, MarketState) else previous_state
    return {
        "as_of_myt": fixture.as_of_myt,
        "market_move": {
            "symbol": fixture.market.symbol,
            "from_price": fixture.market.from_price,
            "to_price": fixture.market.to_price,
            "move_percent": fixture.market.move_percent,
            "window_minutes": fixture.market.window_minutes,
        },
        "allowed_candidate_drivers": evidence.allowed_candidate_drivers,
        "blocked_drivers": evidence.blocked_drivers,
        "cross_asset_confirmation": evidence.cross_asset_confirmation,
        "evidence_status": evidence.evidence_status,
        "timeline": _timeline(fixture),
        "previous_state": normalized_previous_state,
        "prompt": (
            "Given this evidence packet, use only allowed_candidate_drivers. "
            "If evidence is insufficient, return unknown. Output strict JSON only."
        ),
    }


def build_rule_based_analysis(fixture: ScenarioFixture) -> AnalysisResult:
    trigger = detect_market_trigger(fixture)
    if not trigger.triggered:
        return AnalysisResult(
            bias="neutral",
            main_driver="unknown",
            secondary_driver=None,
            cause_status="no_meaningful_change",
            confidence="low",
            is_new_state=False,
            is_continuation=False,
            previous_state_invalidated=False,
            should_notify=False,
            notification_level="none",
            no_news_found=not (fixture.news or fixture.calendar_events),
            allowed_candidate_drivers_used=["unknown"],
            rejected_or_blocked_drivers_acknowledged=True,
            timeline=[],
            cross_asset_confirmation={
                "dxy": "neutral",
                "us10y": "neutral",
                "us2y": "neutral",
                "oil": "neutral",
                "vix_equities": "neutral",
            },
            evidence_status={
                "dxy": "not_confirming",
                "us10y": "not_confirming",
                "us2y": "not_confirming",
                "oil": "not_confirming",
                "vix_equities": "not_confirming",
                "news": "no_relevant_news_found",
            },
            causal_chain="No meaningful change was detected.",
            invalidation_conditions=[],
            user_message="No meaningful change in XAUUSD. Alert suppressed.",
            summary="No meaningful change.",
        )

    evidence = build_evidence_gate_result(fixture)
    bias = _bias_for_move(fixture)
    main_driver, secondary_driver = _select_main_driver(evidence.allowed_candidate_drivers, bias)
    has_direct_news = bool(fixture.news or fixture.calendar_events)
    if main_driver in {"technical_liquidation", "unknown"}:
        cause_status = "unconfirmed"
        confidence = "low"
        should_notify = abs(fixture.market.move_percent) >= 0.45
        notification_level = "level_1" if should_notify else "none"
        no_news_found = not has_direct_news
    else:
        cause_status = "confirmed" if has_direct_news else "likely"
        confidence = "medium" if main_driver in {"risk_sentiment", "oil_inflation"} else "high"
        should_notify = True
        notification_level = "level_3" if has_direct_news else "level_2"
        no_news_found = not has_direct_news

    causal_chain, invalidation_conditions = _driver_summary(main_driver)
    if main_driver == "unknown":
        causal_chain = "The move is unconfirmed. No strong macro/news driver was found."
    if main_driver == "technical_liquidation":
        if should_notify:
            causal_chain = "This may be a liquidity/technical move, but evidence is insufficient."
        else:
            main_driver = "unknown"
            causal_chain = "The move is unconfirmed. No strong macro/news driver was found."

    summary = causal_chain
    user_message = {
        "yields": "Gold remains under pressure from rising yields and a firmer dollar.",
        "oil_inflation": "Oil-led inflation pressure is lifting yields and weighing on gold.",
        "risk_sentiment": "Risk-off flow and falling yields are supporting gold.",
        "technical_liquidation": "XAUUSD moved sharply, but the move still looks technical/unconfirmed.",
        "unknown": "No confirmed macro/news driver found. XAUUSD movement is currently unconfirmed.",
    }[main_driver]
    allowed_used = [main_driver]
    if secondary_driver:
        allowed_used.append(secondary_driver)

    return AnalysisResult(
        bias=bias,
        main_driver=main_driver,
        secondary_driver=secondary_driver,
        cause_status=cause_status,
        confidence=confidence,
        is_new_state=True,
        is_continuation=False,
        previous_state_invalidated=False,
        should_notify=should_notify,
        notification_level=notification_level,
        no_news_found=no_news_found,
        allowed_candidate_drivers_used=allowed_used,
        rejected_or_blocked_drivers_acknowledged=True,
        timeline=_timeline(fixture),
        cross_asset_confirmation=evidence.cross_asset_confirmation,
        evidence_status=evidence.evidence_status,
        causal_chain=causal_chain,
        invalidation_conditions=invalidation_conditions,
        user_message=user_message,
        summary=summary,
    )


def analyze_fixture_with_optional_llm(
    fixture: ScenarioFixture,
    llm_client=None,
    previous_state: MarketState | dict[str, object] | None = None,
) -> AnalysisResult:
    fallback = build_rule_based_analysis(fixture)
    if llm_client is None:
        return fallback
    evidence = build_evidence_gate_result(fixture)
    evidence_packet = build_llm_evidence_packet(fixture, previous_state=previous_state)

    def _call_llm(*, repair: bool) -> object:
        try:
            return llm_client.analyze(evidence_packet, repair=repair)
        except TypeError:
            if repair:
                return None
            return llm_client.analyze(evidence_packet)

    llm_payload = _call_llm(repair=False)
    for attempt in range(2):
        if not llm_payload:
            if attempt == 0:
                llm_payload = _call_llm(repair=True)
                continue
            return fallback
        try:
            return validate_llm_output(
                llm_payload=llm_payload,
                allowed_candidate_drivers=evidence.allowed_candidate_drivers,
                blocked_drivers=evidence.blocked_drivers,
                fallback_result=fallback,
            )
        except Exception:
            if attempt == 0:
                llm_payload = _call_llm(repair=True)
                continue
            return fallback
    return fallback
