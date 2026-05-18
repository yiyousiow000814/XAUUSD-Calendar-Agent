from __future__ import annotations

from dataclasses import asdict
from datetime import datetime, timedelta
from typing import Any

from .models import (
    DriverAttentionSnapshot,
    DriverAttentionState,
    DriverDefinition,
    ProviderHealth,
    ScenarioFixture,
)


DEFAULT_DRIVER_REGISTRY: tuple[DriverDefinition, ...] = (
    DriverDefinition("usd", "USD", "macro", "core_structural", ("dxy",), ("dxy",)),
    DriverDefinition("yields", "US Yields", "macro", "core_structural", ("us10y", "us2y"), ("us10y", "us2y")),
    DriverDefinition("fed_rates", "Fed / Rates", "macro", "conditional_macro", ("us10y", "us2y", "calendar", "news"), ("news",)),
    DriverDefinition("inflation", "Inflation", "macro", "conditional_macro", ("calendar", "news"), ("news",)),
    DriverDefinition("oil_inflation", "Oil / Inflation", "macro", "conditional_macro", ("wti", "brent", "us10y", "us2y", "news"), ("oil", "news")),
    DriverDefinition("geopolitics", "Geopolitics", "event", "temporary_event", ("news", "wti", "vix"), ("news",)),
    DriverDefinition("risk_sentiment", "Risk Sentiment", "macro", "conditional_macro", ("vix", "spx", "nasdaq"), ("vix_equities",)),
    DriverDefinition("technical_liquidation", "Technical / Liquidity", "flow", "background_noise", ("xauusd",), ()),
    DriverDefinition("economic_calendar", "Economic Calendar", "macro", "conditional_macro", ("calendar",), ("news",)),
    DriverDefinition("unknown", "Unknown", "fallback", "background_noise", (), ()),
)


_DEFAULT_STATES = {
    "usd": "watching",
    "yields": "watching",
    "fed_rates": "dormant",
    "inflation": "dormant",
    "oil_inflation": "dormant",
    "geopolitics": "dormant",
    "risk_sentiment": "dormant",
    "technical_liquidation": "dormant",
    "economic_calendar": "dormant",
    "unknown": "unknown",
}

_DECAY_MINUTES = {
    "core_structural": 90,
    "conditional_macro": 120,
    "temporary_event": 60,
    "micro_theme": 45,
    "background_noise": 30,
}


def _parse_iso(raw: str, default: datetime) -> datetime:
    if not raw:
        return default
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return datetime.strptime(raw, "%d-%m-%Y %H:%M").replace(tzinfo=default.tzinfo)


def _iso(dt: datetime | None) -> str:
    return dt.isoformat() if dt else ""


class DriverAttentionManager:
    def __init__(self, registry: tuple[DriverDefinition, ...] = DEFAULT_DRIVER_REGISTRY) -> None:
        self.registry = {item.driver_id: item for item in registry}
        self.micro_themes: dict[str, dict[str, Any]] = {}

    def _empty_state(
        self,
        driver: DriverDefinition,
        *,
        as_of: datetime,
        data_mode: str,
    ) -> DriverAttentionState:
        return DriverAttentionState(
            driver_id=driver.driver_id,
            label=driver.label,
            category=driver.category,
            current_state=_DEFAULT_STATES.get(driver.driver_id, "dormant"),
            priority=driver.priority,
            relevance_score=0.0,
            activation_reason="",
            deactivation_reason="",
            first_activated_at="",
            last_confirmed_at="",
            last_evidence_at="",
            decay_deadline=_iso(as_of + timedelta(minutes=_DECAY_MINUTES.get(driver.priority, 60))),
            linked_assets=driver.linked_assets,
            required_evidence_gates=driver.required_evidence_gates,
            optional_evidence_gates=driver.optional_evidence_gates,
            current_evidence_summary="",
            current_counter_evidence="",
            confidence="low",
            source_count=0,
            related_news_count=0,
            related_calendar_events=0,
            notes="",
            data_mode=data_mode,
        )

    def _transition_with_decay(
        self,
        previous: DriverAttentionState | None,
        next_state: DriverAttentionState,
        *,
        as_of: datetime,
    ) -> DriverAttentionState:
        if previous is None:
            return next_state
        previous_deadline = _parse_iso(previous.decay_deadline, as_of)
        if previous.current_state == "active" and next_state.current_state in {"dormant", "watching"}:
            return DriverAttentionState(
                **{
                    **asdict(next_state),
                    "current_state": "cooling",
                    "deactivation_reason": next_state.current_counter_evidence or "No fresh confirmation.",
                    "first_activated_at": previous.first_activated_at or next_state.first_activated_at,
                    "last_confirmed_at": previous.last_confirmed_at,
                    "last_evidence_at": previous.last_evidence_at,
                    "decay_deadline": _iso(as_of + timedelta(minutes=30)),
                }
            )
        if previous.current_state == "cooling" and as_of >= previous_deadline:
            return DriverAttentionState(
                **{
                    **asdict(next_state),
                    "current_state": "retired",
                    "deactivation_reason": previous.deactivation_reason or "Decay window expired.",
                    "first_activated_at": previous.first_activated_at,
                    "last_confirmed_at": previous.last_confirmed_at,
                    "last_evidence_at": previous.last_evidence_at,
                }
            )
        if previous.current_state in {"active", "cooling"} and next_state.current_state == "active":
            return DriverAttentionState(
                **{
                    **asdict(next_state),
                    "first_activated_at": previous.first_activated_at or next_state.first_activated_at,
                }
            )
        return next_state

    def evaluate_micro_theme(
        self,
        *,
        theme_id: str,
        headline_count: int,
        source_count: int,
        cross_asset_confirmation: str,
    ) -> dict[str, Any]:
        existing = self.micro_themes.get(theme_id, {"headline_count": 0, "source_count": 0})
        total_headlines = existing["headline_count"] + headline_count
        total_sources = max(existing["source_count"], source_count)
        if total_headlines <= 1:
            status = "watching"
        elif cross_asset_confirmation == "confirming" and total_sources >= 2:
            status = "emerging"
        elif cross_asset_confirmation == "contradicting":
            status = "faded"
        else:
            status = "watching"
        payload = {
            "theme_id": theme_id,
            "headline_count": total_headlines,
            "source_count": total_sources,
            "cross_asset_confirmation": cross_asset_confirmation,
            "status": status,
            "escalation_score": float(total_headlines + total_sources),
        }
        self.micro_themes[theme_id] = payload
        return payload

    def evaluate(
        self,
        *,
        fixture: ScenarioFixture,
        provider_health: dict[str, ProviderHealth],
        evidence_status: dict[str, str],
        previous_states: dict[str, DriverAttentionState] | None = None,
        data_mode: str = "live_seen",
    ) -> DriverAttentionSnapshot:
        previous_states = previous_states or {}
        as_of = datetime.strptime(fixture.as_of_myt, "%d-%m-%Y %H:%M").replace(
            tzinfo=datetime.fromisoformat("2026-01-01T00:00:00+08:00").tzinfo
        )
        news_titles = " ".join(item.title.lower() for item in fixture.news)
        geo_news = any("geopolitics" in tag for item in fixture.news for tag in item.tags)
        oil_news = any(
            token in news_titles
            for token in ("oil", "opec", "hormuz", "supply", "sanction", "inventory", "shipping")
        )
        fed_news = any(token in news_titles for token in ("fed", "fomc", "powell", "rates", "cpi", "ppi", "pce", "nfp"))
        dxy_confirming = evidence_status["dxy"] in {"confirming", "confirms"}
        us10y_confirming = evidence_status["us10y"] in {"confirming", "confirms"}
        us2y_confirming = evidence_status["us2y"] in {"confirming", "confirms"}
        oil_confirming = evidence_status["oil"] in {"confirming", "confirms"}
        risk_confirming = evidence_status["vix_equities"] in {"confirming", "confirms"}

        states: dict[str, DriverAttentionState] = {}
        for driver_id, driver in self.registry.items():
            base = self._empty_state(driver, as_of=as_of, data_mode=data_mode)
            previous = previous_states.get(driver_id)
            current = base
            if driver_id == "usd":
                if dxy_confirming:
                    current = DriverAttentionState(
                        **{
                            **asdict(base),
                            "current_state": "active",
                            "relevance_score": 0.9,
                            "activation_reason": "Fresh DXY confirms the XAUUSD move.",
                            "last_confirmed_at": fixture.as_of_myt,
                            "last_evidence_at": fixture.as_of_myt,
                            "first_activated_at": previous.first_activated_at if previous else fixture.as_of_myt,
                            "confidence": "high",
                            "current_evidence_summary": "DXY is fresh and directionally aligned.",
                        }
                    )
                elif evidence_status["dxy"] in {"stale", "unavailable"}:
                    current = DriverAttentionState(
                        **{
                            **asdict(base),
                            "current_state": "dormant",
                            "current_counter_evidence": f"DXY is {evidence_status['dxy']}.",
                            "notes": "Observed continuously but blocked from active use without fresh data.",
                        }
                    )
            elif driver_id == "yields":
                if us10y_confirming or us2y_confirming:
                    current = DriverAttentionState(
                        **{
                            **asdict(base),
                            "current_state": "active",
                            "relevance_score": 0.95,
                            "activation_reason": "Fresh yield move confirms the XAUUSD move.",
                            "last_confirmed_at": fixture.as_of_myt,
                            "last_evidence_at": fixture.as_of_myt,
                            "first_activated_at": previous.first_activated_at if previous else fixture.as_of_myt,
                            "confidence": "high",
                            "current_evidence_summary": "US10Y or US2Y is fresh and directionally aligned.",
                        }
                    )
                elif evidence_status["us10y"] == "unavailable" and evidence_status["us2y"] == "unavailable":
                    current = DriverAttentionState(
                        **{
                            **asdict(base),
                            "current_state": "dormant",
                            "current_counter_evidence": "Yield data is unavailable.",
                        }
                    )
            elif driver_id == "oil_inflation":
                if oil_confirming and (
                    us10y_confirming
                    or us2y_confirming
                    or geo_news
                ):
                    current = DriverAttentionState(
                        **{
                            **asdict(base),
                            "current_state": "active",
                            "relevance_score": 0.82,
                            "activation_reason": "Fresh oil move has a confirming channel into yields or geopolitics.",
                            "last_confirmed_at": fixture.as_of_myt,
                            "last_evidence_at": fixture.as_of_myt,
                            "first_activated_at": previous.first_activated_at if previous else fixture.as_of_myt,
                            "confidence": "medium",
                            "related_news_count": len(fixture.news),
                            "current_evidence_summary": "Oil is no longer background only.",
                        }
                    )
                elif oil_news or abs(fixture.cross_asset.wti_percent) >= 1.0 or abs(fixture.cross_asset.brent_percent) >= 1.0:
                    current = DriverAttentionState(
                        **{
                            **asdict(base),
                            "current_state": "watching",
                            "relevance_score": 0.35,
                            "activation_reason": "Oil is moving or appearing in headlines, but the channel is incomplete.",
                            "last_evidence_at": fixture.as_of_myt,
                            "related_news_count": len(fixture.news),
                            "current_counter_evidence": "No confirmed yield/inflation follow-through yet.",
                        }
                    )
            elif driver_id == "geopolitics":
                if geo_news and (
                    oil_confirming
                    or risk_confirming
                    or fixture.market.move_percent > 0
                ):
                    current = DriverAttentionState(
                        **{
                            **asdict(base),
                            "current_state": "active",
                            "relevance_score": 0.78,
                            "activation_reason": "Timestamped geopolitical headline has market confirmation.",
                            "last_confirmed_at": fixture.as_of_myt,
                            "last_evidence_at": fixture.as_of_myt,
                            "first_activated_at": previous.first_activated_at if previous else fixture.as_of_myt,
                            "confidence": "medium",
                            "related_news_count": len(fixture.news),
                            "current_evidence_summary": "Geopolitics is actively repriced.",
                        }
                    )
                elif geo_news:
                    current = DriverAttentionState(
                        **{
                            **asdict(base),
                            "current_state": "watching",
                            "relevance_score": 0.3,
                            "activation_reason": "Geopolitical headline exists, but cross-market confirmation is incomplete.",
                            "last_evidence_at": fixture.as_of_myt,
                        }
                    )
            elif driver_id == "risk_sentiment":
                if risk_confirming:
                    current = DriverAttentionState(
                        **{
                            **asdict(base),
                            "current_state": "active",
                            "relevance_score": 0.8,
                            "activation_reason": "Fresh VIX/equities move confirms risk sentiment.",
                            "last_confirmed_at": fixture.as_of_myt,
                            "last_evidence_at": fixture.as_of_myt,
                            "first_activated_at": previous.first_activated_at if previous else fixture.as_of_myt,
                            "confidence": "medium",
                            "current_evidence_summary": "Risk-off or risk-on flow is currently relevant.",
                        }
                    )
            elif driver_id == "fed_rates":
                if fed_news or fixture.calendar_events:
                    state_name = "active" if (fed_news and (us10y_confirming or us2y_confirming)) else "emerging"
                    current = DriverAttentionState(
                        **{
                            **asdict(base),
                            "current_state": state_name,
                            "relevance_score": 0.72 if state_name == "active" else 0.45,
                            "activation_reason": "Fed or high-impact macro evidence is present.",
                            "last_confirmed_at": fixture.as_of_myt if state_name == "active" else "",
                            "last_evidence_at": fixture.as_of_myt,
                            "first_activated_at": previous.first_activated_at if previous else fixture.as_of_myt,
                            "confidence": "medium",
                            "related_calendar_events": len(fixture.calendar_events),
                            "related_news_count": len(fixture.news),
                        }
                    )
            elif driver_id == "technical_liquidation":
                no_macro_confirmation = all(
                    evidence_status[key] not in {"confirming", "confirms"}
                    for key in ("dxy", "us10y", "us2y", "oil", "vix_equities")
                )
                if abs(fixture.market.move_percent) >= 0.35 and no_macro_confirmation:
                    current = DriverAttentionState(
                        **{
                            **asdict(base),
                            "current_state": "emerging",
                            "relevance_score": 0.5,
                            "activation_reason": "XAUUSD moved but fresh macro/news confirmation is missing.",
                            "last_evidence_at": fixture.as_of_myt,
                            "confidence": "low",
                            "current_evidence_summary": "Possible liquidity or stop-driven move.",
                        }
                    )
            elif driver_id == "unknown":
                current = DriverAttentionState(
                    **{
                        **asdict(base),
                        "current_state": "unknown",
                        "relevance_score": 0.0,
                        "notes": "Fallback state.",
                    }
                )
            states[driver_id] = self._transition_with_decay(previous, current, as_of=as_of)

        active = [
            {
                "driver_id": item.driver_id,
                "current_state": item.current_state,
                "activation_reason": item.activation_reason,
            }
            for item in states.values()
            if item.current_state in {"active", "emerging", "cooling"}
        ]
        dormant = [
            {
                "driver_id": item.driver_id,
                "current_state": item.current_state,
                "note": item.notes or item.current_counter_evidence,
            }
            for item in states.values()
            if item.current_state in {"dormant", "watching", "retired", "unknown"}
        ]
        summary = {
            "active_driver_count": len([item for item in states.values() if item.current_state == "active"]),
            "emerging_driver_count": len([item for item in states.values() if item.current_state == "emerging"]),
            "cooling_driver_count": len([item for item in states.values() if item.current_state == "cooling"]),
            "background_only": len(active) == 0,
            "top_driver": max(
                states.values(),
                key=lambda item: item.relevance_score,
            ).driver_id
            if states
            else "unknown",
        }
        return DriverAttentionSnapshot(
            states=states,
            active_driver_states=active,
            dormant_driver_states=dormant,
            driver_attention_summary=summary,
        )
