from __future__ import annotations

from .driver_attention import DriverAttentionManager
from .models import DriverAttentionSnapshot, EvidenceGateResult, ProviderHealth, ScenarioFixture
from .provider_health import build_fixture_provider_health


def _move_direction(fixture: ScenarioFixture) -> int:
    return 1 if fixture.market.move_percent > 0 else -1


def _news_titles(fixture: ScenarioFixture) -> str:
    titles = [item.title for item in fixture.news] + [item.title for item in fixture.calendar_events]
    return " ".join(titles).lower()


def _health_status(health: ProviderHealth | None) -> str | None:
    if health is None:
        return None
    if not health.is_available:
        return "unavailable"
    if health.is_stale:
        return "stale"
    return None


def _status_from_direction(
    *,
    health: ProviderHealth | None,
    confirms: bool,
    contradicts: bool,
) -> str:
    health_status = _health_status(health)
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
        "dxy": _status_from_direction(health=provider_health.get("dxy"), confirms=dxy_confirms, contradicts=dxy_contradicts),
        "us10y": _status_from_direction(health=provider_health.get("us10y"), confirms=us10y_confirms, contradicts=us10y_contradicts),
        "us2y": _status_from_direction(health=provider_health.get("us2y"), confirms=us2y_confirms, contradicts=us2y_contradicts),
        "oil": _status_from_direction(
            health=provider_health.get("wti") or provider_health.get("brent"),
            confirms=oil_confirms,
            contradicts=oil_contradicts,
        ),
        "vix_equities": _status_from_direction(
            health=provider_health.get("vix"),
            confirms=risk_confirms,
            contradicts=risk_contradicts,
        ),
    }


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
    geo_headline = any("geopolitics" in tag for item in fixture.news for tag in item.tags)

    if confirmation["dxy"] == "confirms" and states["usd"].current_state in {"active", "emerging"}:
        allowed.append("usd")
    else:
        blocked["usd"] = "DXY is not fresh and confirming, or USD attention is not active."

    if (
        confirmation["us10y"] == "confirms" or confirmation["us2y"] == "confirms"
    ) and states["yields"].current_state in {"active", "emerging"}:
        allowed.append("yields")
    else:
        blocked["yields"] = "US10Y/US2Y are not fresh and confirming, or yields attention is not active."

    fed_signal = any(token in news_titles for token in ("fed", "fomc", "powell", "rates", "cpi", "ppi", "pce", "nfp"))
    if (
        (fed_signal or confirmation["us10y"] == "confirms" or confirmation["us2y"] == "confirms")
        and states["fed_rates"].current_state in {"active", "emerging"}
    ):
        allowed.append("fed_rates")
    else:
        blocked["fed_rates"] = "Fed/rates evidence is missing or stale."

    if confirmation["oil"] == "confirms" and states["oil_inflation"].current_state in {"active", "emerging"}:
        allowed.append("oil_inflation")
    else:
        blocked["oil_inflation"] = "Oil is background only or lacks a fresh confirming channel."

    if geo_headline and states["geopolitics"].current_state in {"active", "emerging"}:
        allowed.append("geopolitics")
    else:
        blocked["geopolitics"] = "No timestamped geopolitical headline with market confirmation."

    if confirmation["vix_equities"] == "confirms" and states["risk_sentiment"].current_state in {"active", "emerging"}:
        allowed.append("risk_sentiment")
    else:
        blocked["risk_sentiment"] = "VIX/equities are not fresh and confirming."

    if not allowed:
        technical_state = states["technical_liquidation"].current_state
        if technical_state in {"active", "emerging"}:
            allowed.append("technical_liquidation")
        allowed.append("unknown")

    evidence_status = {
        "dxy": "confirming" if confirmation["dxy"] == "confirms" else "contradicting" if confirmation["dxy"] == "contradicts" else confirmation["dxy"] if confirmation["dxy"] in {"stale", "unavailable"} else "not_confirming",
        "us10y": "confirming" if confirmation["us10y"] == "confirms" else "contradicting" if confirmation["us10y"] == "contradicts" else confirmation["us10y"] if confirmation["us10y"] in {"stale", "unavailable"} else "not_confirming",
        "us2y": "confirming" if confirmation["us2y"] == "confirms" else "contradicting" if confirmation["us2y"] == "contradicts" else confirmation["us2y"] if confirmation["us2y"] in {"stale", "unavailable"} else "not_confirming",
        "oil": "confirming" if confirmation["oil"] == "confirms" else "contradicting" if confirmation["oil"] == "contradicts" else confirmation["oil"] if confirmation["oil"] in {"stale", "unavailable"} else "not_confirming",
        "vix_equities": "confirming" if confirmation["vix_equities"] == "confirms" else "contradicting" if confirmation["vix_equities"] == "contradicts" else confirmation["vix_equities"] if confirmation["vix_equities"] in {"stale", "unavailable"} else "not_confirming",
        "news": "relevant_news_found" if (fixture.news or fixture.calendar_events) else "no_relevant_news_found",
    }
    return EvidenceGateResult(
        allowed_candidate_drivers=allowed,
        blocked_drivers=blocked,
        cross_asset_confirmation=confirmation,
        evidence_status=evidence_status,
    )
