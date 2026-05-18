from __future__ import annotations

from .models import EvidenceGateResult, ScenarioFixture


def _move_direction(fixture: ScenarioFixture) -> int:
    return 1 if fixture.market.move_percent > 0 else -1


def _news_titles(fixture: ScenarioFixture) -> str:
    titles = [item.title for item in fixture.news] + [item.title for item in fixture.calendar_events]
    return " ".join(titles).lower()


def build_cross_asset_confirmation(fixture: ScenarioFixture) -> dict[str, str]:
    direction = _move_direction(fixture)
    cross = fixture.cross_asset

    dxy_confirms = (direction < 0 and cross.dxy_percent >= 0.2) or (
        direction > 0 and cross.dxy_percent <= -0.05
    )
    us10y_confirms = (direction < 0 and cross.us10y_bps >= 4.0) or (
        direction > 0 and cross.us10y_bps <= -4.0
    )
    us2y_confirms = (direction < 0 and cross.us2y_bps >= 4.0) or (
        direction > 0 and cross.us2y_bps <= -4.0
    )
    oil_move = max(abs(cross.wti_percent), abs(cross.brent_percent))
    oil_confirms = direction < 0 and oil_move >= 1.5 and (us10y_confirms or us2y_confirms)
    risk_confirms = (
        direction > 0
        and cross.vix_percent >= 3.0
        and cross.spx_percent <= -0.8
        and cross.nasdaq_percent <= -1.0
        and (us10y_confirms or us2y_confirms)
    )

    return {
        "dxy": "confirms" if dxy_confirms else "neutral",
        "us10y": "confirms" if us10y_confirms else "neutral",
        "us2y": "confirms" if us2y_confirms else "neutral",
        "oil": "confirms" if oil_confirms else "neutral",
        "vix_equities": "confirms" if risk_confirms else "neutral",
    }


def build_evidence_gate_result(fixture: ScenarioFixture) -> EvidenceGateResult:
    confirmation = build_cross_asset_confirmation(fixture)
    allowed: list[str] = []
    blocked: dict[str, str] = {}
    news_titles = _news_titles(fixture)

    if confirmation["dxy"] == "confirms":
        allowed.append("usd")
    else:
        blocked["usd"] = "DXY did not confirm the XAUUSD move."

    if confirmation["us10y"] == "confirms" or confirmation["us2y"] == "confirms":
        allowed.append("yields")
    else:
        blocked["yields"] = "US10Y and US2Y did not confirm."

    fed_signal = any(token in news_titles for token in ("fed", "fomc", "powell", "rates"))
    if fed_signal or "yields" in allowed:
        allowed.append("fed_rates")
    else:
        blocked["fed_rates"] = "No Fed headline and yields did not confirm."

    if confirmation["oil"] == "confirms":
        allowed.append("oil_inflation")
    else:
        blocked["oil_inflation"] = "Oil did not move enough with yields confirmation."

    if any("geopolitics" in tag for item in fixture.news for tag in item.tags):
        allowed.append("geopolitics")
    else:
        blocked["geopolitics"] = "No timestamped geopolitical headline in the monitored window."

    if confirmation["vix_equities"] == "confirms":
        allowed.append("risk_sentiment")
    else:
        blocked["risk_sentiment"] = "VIX/equities did not confirm safe-haven demand."

    if not allowed:
        allowed.extend(["technical_liquidation", "unknown"])

    evidence_status = {
        "dxy": "confirming" if confirmation["dxy"] == "confirms" else "not_confirming",
        "us10y": "confirming" if confirmation["us10y"] == "confirms" else "not_confirming",
        "us2y": "confirming" if confirmation["us2y"] == "confirms" else "not_confirming",
        "oil": "confirming" if confirmation["oil"] == "confirms" else "not_confirming",
        "vix_equities": "confirming" if confirmation["vix_equities"] == "confirms" else "not_confirming",
        "news": "relevant_news_found" if (fixture.news or fixture.calendar_events) else "no_relevant_news_found",
    }
    return EvidenceGateResult(
        allowed_candidate_drivers=allowed,
        blocked_drivers=blocked,
        cross_asset_confirmation=confirmation,
        evidence_status=evidence_status,
    )
