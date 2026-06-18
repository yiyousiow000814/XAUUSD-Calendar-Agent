from __future__ import annotations

from datetime import datetime
import re
from zoneinfo import ZoneInfo

from .driver_attention import DriverAttentionManager
from .market_session import is_xauusd_weekend_closed
from .models import DriverAttentionSnapshot, EvidenceGateResult, ProviderHealth, ScenarioFixture
from .provider_health import build_fixture_provider_health


MARKET_CLOSED_CONTEXT_STATUS = "market_closed_context"
_MARKET_CLOSED_CONTEXT_SOURCE_TYPES = {"proxy", "related_asset", "yield_quote"}


def _move_direction(fixture: ScenarioFixture) -> int:
    return 1 if fixture.market.move_percent > 0 else -1


def _news_titles(fixture: ScenarioFixture) -> str:
    titles = [item.title for item in fixture.news] + [item.title for item in fixture.calendar_events]
    return " ".join(titles).lower()


def _has_geopolitical_shock_news(fixture: ScenarioFixture, news_titles: str) -> bool:
    if any("geopolitics" in tag for item in fixture.news for tag in item.tags):
        return True
    return any(
        _contains_keyword(news_titles, token)
        for token in (
            "iran",
            "israel",
            "hormuz",
            "lebanon",
            "middle east",
            "red sea",
            "military",
            "missile",
            "attack",
            "attacks",
            "strike",
            "strikes",
            "war",
            "ceasefire",
            "airspace",
        )
    )


def _contains_keyword(text: str, keyword: str) -> bool:
    normalized_text = re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()
    normalized_keyword = re.sub(r"[^a-z0-9]+", " ", keyword.lower()).strip()
    if not normalized_text or not normalized_keyword:
        return False
    return re.search(rf"(?<![a-z0-9]){re.escape(normalized_keyword)}(?![a-z0-9])", normalized_text) is not None


def _fixture_anchor_time(fixture: ScenarioFixture) -> datetime | None:
    try:
        return datetime.strptime(fixture.as_of_myt, "%d-%m-%Y %H:%M").replace(tzinfo=ZoneInfo("Asia/Kuala_Lumpur"))
    except ValueError:
        return None


def _is_market_closed_context(health: ProviderHealth, anchor_time: datetime | None) -> bool:
    return (
        anchor_time is not None
        and is_xauusd_weekend_closed(anchor_time)
        and health.source_type in _MARKET_CLOSED_CONTEXT_SOURCE_TYPES
        and (health.current_value is not None or health.change_value is not None)
        and health.data_mode in {"live_seen", "market_closed", "stale"}
    )


def _health_status(health: ProviderHealth | None, *, anchor_time: datetime | None = None) -> str | None:
    if health is None:
        return None
    if not health.is_available:
        return "unavailable"
    if health.is_stale:
        if _is_market_closed_context(health, anchor_time):
            return MARKET_CLOSED_CONTEXT_STATUS
        return "stale"
    return None


def _status_from_direction(
    *,
    health: ProviderHealth | None,
    confirms: bool,
    contradicts: bool,
    anchor_time: datetime | None = None,
) -> str:
    health_status = _health_status(health, anchor_time=anchor_time)
    if health_status is not None:
        return health_status
    if confirms:
        return "confirms"
    if contradicts:
        return "contradicts"
    return "neutral"


def build_cross_asset_confirmation(
    fixture: ScenarioFixture,
    provider_health: dict[str, ProviderHealth] | None = None,
) -> dict[str, str]:
    direction = _move_direction(fixture)
    cross = fixture.cross_asset
    provider_health = provider_health or build_fixture_provider_health(fixture)
    anchor_time = _fixture_anchor_time(fixture)

    dxy_confirms = (direction < 0 and cross.dxy_percent >= 0.2) or (direction > 0 and cross.dxy_percent <= -0.05)
    dxy_contradicts = (direction < 0 and cross.dxy_percent <= -0.1) or (direction > 0 and cross.dxy_percent >= 0.1)
    us10y_confirms = (direction < 0 and cross.us10y_bps >= 4.0) or (direction > 0 and cross.us10y_bps <= -4.0)
    us10y_contradicts = (direction < 0 and cross.us10y_bps <= -2.0) or (direction > 0 and cross.us10y_bps >= 2.0)
    us2y_confirms = (direction < 0 and cross.us2y_bps >= 4.0) or (direction > 0 and cross.us2y_bps <= -4.0)
    us2y_contradicts = (direction < 0 and cross.us2y_bps <= -2.0) or (direction > 0 and cross.us2y_bps >= 2.0)
    oil_move = max(abs(cross.wti_percent), abs(cross.brent_percent))
    oil_confirms = direction < 0 and oil_move >= 1.5 and (us10y_confirms or us2y_confirms)
    oil_contradicts = direction > 0 and oil_move >= 1.5 and (us10y_confirms or us2y_confirms)
    risk_confirms = (
        direction > 0
        and cross.vix_percent >= 3.0
        and cross.spx_percent <= -0.8
        and cross.nasdaq_percent <= -1.0
        and (us10y_confirms or us2y_confirms)
    )
    risk_contradicts = (
        direction < 0
        and cross.vix_percent >= 3.0
        and cross.spx_percent <= -0.8
        and cross.nasdaq_percent <= -1.0
    )

    return {
        "dxy": _status_from_direction(
            health=provider_health.get("dxy"),
            confirms=dxy_confirms,
            contradicts=dxy_contradicts,
            anchor_time=anchor_time,
        ),
        "us10y": _status_from_direction(
            health=provider_health.get("us10y"),
            confirms=us10y_confirms,
            contradicts=us10y_contradicts,
            anchor_time=anchor_time,
        ),
        "us2y": _status_from_direction(
            health=provider_health.get("us2y"),
            confirms=us2y_confirms,
            contradicts=us2y_contradicts,
            anchor_time=anchor_time,
        ),
        "oil": _status_from_direction(
            health=provider_health.get("wti") or provider_health.get("brent"),
            confirms=oil_confirms,
            contradicts=oil_contradicts,
            anchor_time=anchor_time,
        ),
        "vix_equities": _status_from_direction(
            health=provider_health.get("vix"),
            confirms=risk_confirms,
            contradicts=risk_contradicts,
            anchor_time=anchor_time,
        ),
    }


def _confirmation_to_evidence_status(status: str) -> str:
    if status == "confirms":
        return "confirming"
    if status == "contradicts":
        return "contradicting"
    if status in {"stale", "unavailable", MARKET_CLOSED_CONTEXT_STATUS}:
        return status
    return "not_confirming"


def _confirmation_reason(label: str, status: str) -> str:
    verb = "are" if label in {"Yields"} else "is"
    if status == "unavailable":
        return f"{label} {verb} unavailable."
    if status == "stale":
        return f"{label} {verb} stale."
    if status == MARKET_CLOSED_CONTEXT_STATUS:
        return f"{label} {verb} context only while XAUUSD is closed."
    if status == "contradicts":
        return f"{label} contradict the XAUUSD move." if verb == "are" else f"{label} contradicts the XAUUSD move."
    if status == "neutral":
        return f"{label} {verb} fresh but not confirming the XAUUSD move."
    return f"{label} {verb} not confirming the XAUUSD move."


def _attention_reason(label: str, state: str) -> str:
    verb = "are" if label in {"Yields"} else "is"
    auxiliary = "have" if label in {"Yields"} else "has"
    if state in {"active", "emerging"}:
        return f"{label} attention is active, but confirmation is still missing."
    if state == "watching":
        return f"{label} {verb} being watched, but {auxiliary} not become an active driver."
    if state == "dormant":
        return f"{label} attention is dormant."
    return f"{label} attention is {state or 'unknown'}."


def _driver_block_reason(label: str, confirmation_statuses: tuple[str, ...], attention_state: str) -> str:
    if len(set(confirmation_statuses)) == 1:
        confirmation_text = _confirmation_reason(label, confirmation_statuses[0])
    else:
        reason_parts: list[str] = []
        for status in confirmation_statuses:
            reason = _confirmation_reason(f"{label} sensor", status)
            if reason not in reason_parts:
                reason_parts.append(reason)
        confirmation_text = " ".join(reason_parts)
    attention_text = _attention_reason(label, attention_state)
    return f"{confirmation_text} {attention_text}"


def _fed_rates_block_reason(state: str, news_titles: str) -> str:
    has_fed_context = any(
        _contains_keyword(news_titles, keyword)
        for keyword in ("fed", "fomc", "rate", "rates", "inflation", "cpi", "retail sales", "jobless claims")
    )
    if state in {"emerging", "watching"}:
        return "Fed/rates context is present, but it is not market-confirmed enough to become the main driver."
    if has_fed_context:
        return "Fed/rates headlines or calendar events are present, but driver attention is not active."
    return "Fed/rates evidence is missing or stale."


def build_evidence_gate_result(
    fixture: ScenarioFixture,
    provider_health: dict[str, ProviderHealth] | None = None,
    attention_snapshot: DriverAttentionSnapshot | None = None,
) -> EvidenceGateResult:
    provider_health = provider_health or build_fixture_provider_health(fixture)
    confirmation = build_cross_asset_confirmation(fixture, provider_health=provider_health)
    if attention_snapshot is None:
        attention_snapshot = DriverAttentionManager().evaluate(
            fixture=fixture,
            provider_health=provider_health,
            evidence_status={
                **confirmation,
                "news": "relevant_news_found" if (fixture.news or fixture.calendar_events) else "no_relevant_news_found",
            },
        )
    states = attention_snapshot.states

    allowed: list[str] = []
    blocked: dict[str, str] = {}
    news_titles = _news_titles(fixture)
    geo_headline = _has_geopolitical_shock_news(fixture, news_titles)

    if confirmation["dxy"] == "confirms" and states["usd"].current_state in {"active", "emerging"}:
        allowed.append("usd")
    else:
        blocked["usd"] = _driver_block_reason("USD", (confirmation["dxy"],), states["usd"].current_state)

    if (
        confirmation["us10y"] == "confirms" or confirmation["us2y"] == "confirms"
    ) and states["yields"].current_state in {"active", "emerging"}:
        allowed.append("yields")
    else:
        blocked["yields"] = _driver_block_reason(
            "Yields",
            (confirmation["us10y"], confirmation["us2y"]),
            states["yields"].current_state,
        )

    if states["fed_rates"].current_state == "active":
        allowed.append("fed_rates")
    else:
        blocked["fed_rates"] = _fed_rates_block_reason(states["fed_rates"].current_state, news_titles)

    if confirmation["oil"] == "confirms" and states["oil_inflation"].current_state in {"active", "emerging"}:
        allowed.append("oil_inflation")
    else:
        blocked["oil_inflation"] = _driver_block_reason(
            "Oil/inflation",
            (confirmation["oil"],),
            states["oil_inflation"].current_state,
        )

    if geo_headline and states["geopolitics"].current_state in {"active", "emerging"}:
        allowed.append("geopolitics")
    else:
        blocked["geopolitics"] = "Geopolitical headline is present, but market confirmation is incomplete."

    if confirmation["vix_equities"] == "confirms" and states["risk_sentiment"].current_state in {"active", "emerging"}:
        allowed.append("risk_sentiment")
    else:
        blocked["risk_sentiment"] = _driver_block_reason(
            "Risk sentiment",
            (confirmation["vix_equities"],),
            states["risk_sentiment"].current_state,
        )

    if not allowed:
        technical_state = states["technical_liquidation"].current_state
        if technical_state in {"active", "emerging"}:
            allowed.append("technical_liquidation")
        allowed.append("unknown")

    evidence_status = {
        "dxy": _confirmation_to_evidence_status(confirmation["dxy"]),
        "us10y": _confirmation_to_evidence_status(confirmation["us10y"]),
        "us2y": _confirmation_to_evidence_status(confirmation["us2y"]),
        "oil": _confirmation_to_evidence_status(confirmation["oil"]),
        "vix_equities": _confirmation_to_evidence_status(confirmation["vix_equities"]),
        "news": "relevant_news_found" if (fixture.news or fixture.calendar_events) else "no_relevant_news_found",
    }
    return EvidenceGateResult(
        allowed_candidate_drivers=allowed,
        blocked_drivers=blocked,
        cross_asset_confirmation=confirmation,
        evidence_status=evidence_status,
    )
