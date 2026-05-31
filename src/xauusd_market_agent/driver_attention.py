from __future__ import annotations

from dataclasses import asdict
from datetime import datetime, timedelta
import re
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

_THEME_STOPWORDS = {
    "about",
    "after",
    "amid",
    "and",
    "are",
    "as",
    "before",
    "but",
    "for",
    "from",
    "gold",
    "higher",
    "into",
    "lower",
    "market",
    "markets",
    "may",
    "move",
    "new",
    "news",
    "over",
    "price",
    "prices",
    "says",
    "the",
    "to",
    "us",
    "with",
    "xauusd",
}

_THEME_FILTER_TAGS = {
    "filtered",
    "missing_timestamp",
    "no_market_agent_keyword",
    "score_below_threshold",
    "low_signal_opinion_or_forecast",
}

_KNOWN_DRIVER_TERMS = {
    "brent",
    "cpi",
    "dollar",
    "dxy",
    "fed",
    "fomc",
    "gold",
    "inflation",
    "nasdaq",
    "nfp",
    "oil",
    "pce",
    "powell",
    "ppi",
    "rates",
    "spx",
    "treasury",
    "us10y",
    "us2y",
    "vix",
    "war",
    "wti",
    "yield",
    "yields",
}

_THEME_SENSOR_HINTS = {
    "bank": ("vix", "spx", "nasdaq"),
    "banking": ("vix", "spx", "nasdaq"),
    "credit": ("vix", "spx", "nasdaq"),
    "debt": ("us10y", "us2y", "dxy"),
    "fiscal": ("us10y", "us2y", "dxy"),
    "liquidity": ("vix", "spx", "nasdaq"),
    "shipping": ("wti", "brent", "vix"),
    "stress": ("vix", "spx", "nasdaq"),
    "supply": ("us10y", "us2y", "dxy"),
    "tariff": ("dxy", "us10y", "spx", "nasdaq"),
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


def _theme_slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")
    return slug[:48] or "unclassified"


def _headline_tokens(title: str) -> list[str]:
    tokens = re.findall(r"[a-z][a-z0-9-]{2,}", title.lower())
    return [item for item in tokens if item not in _THEME_STOPWORDS]


def _candidate_theme_terms(title: str, tags: tuple[str, ...]) -> list[str]:
    normalized_tags = {item.strip().lower() for item in tags if item}
    if normalized_tags & _THEME_FILTER_TAGS:
        return []
    tag_terms = [
        item.replace("_", " ").replace("-", " ").strip().lower()
        for item in tags
        if item and item.lower() not in {"rss", "injected", "calendar"} and item.lower() not in _THEME_FILTER_TAGS
    ]
    tokens = _headline_tokens(title)
    phrases: list[str] = []
    for size in (2, 3):
        for idx in range(0, max(0, len(tokens) - size + 1)):
            phrase_tokens = tokens[idx : idx + size]
            if all(token in _KNOWN_DRIVER_TERMS for token in phrase_tokens):
                continue
            if any(token not in _KNOWN_DRIVER_TERMS for token in phrase_tokens):
                phrases.append(" ".join(phrase_tokens))
    single_terms = [token for token in tokens if token not in _KNOWN_DRIVER_TERMS]
    return list(dict.fromkeys([*tag_terms, *phrases, *single_terms]))


def _requested_sensors_for_terms(terms: list[str], provider_health: dict[str, ProviderHealth]) -> tuple[str, ...]:
    requested: list[str] = []
    for term in terms:
        for token, sensors in _THEME_SENSOR_HINTS.items():
            if token in term:
                requested.extend(sensors)
    if not requested:
        requested.extend(["news", "xauusd"])
    available_order = ["news", "xauusd", "dxy", "us10y", "us2y", "wti", "brent", "vix", "spx", "nasdaq"]
    deduped = [item for item in available_order if item in set(requested)]
    for item in requested:
        if item not in deduped:
            deduped.append(item)
    return tuple(item for item in deduped if item in provider_health or item in {"news", "xauusd"})


def _theme_cross_asset_confirmation(
    *,
    requested_sensor_ids: tuple[str, ...],
    evidence_status: dict[str, str],
    provider_health: dict[str, ProviderHealth],
) -> tuple[bool, str]:
    status_by_sensor = {
        "dxy": evidence_status.get("dxy"),
        "us10y": evidence_status.get("us10y"),
        "us2y": evidence_status.get("us2y"),
        "wti": evidence_status.get("oil"),
        "brent": evidence_status.get("oil"),
        "vix": evidence_status.get("vix_equities"),
        "spx": evidence_status.get("vix_equities"),
        "nasdaq": evidence_status.get("vix_equities"),
    }
    unavailable = [
        item
        for item in requested_sensor_ids
        if item in provider_health and not provider_health[item].is_available
    ]
    confirming = [item for item in requested_sensor_ids if status_by_sensor.get(item) == "confirming"]
    if confirming:
        return True, f"Confirmed by {', '.join(confirming)}."
    if unavailable:
        return False, f"Requested sensor unavailable: {', '.join(unavailable)}."
    return False, "No cross-asset confirmation yet."


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
            theme_id="",
            lifecycle="",
            source_terms=(),
            related_sensor_ids=(),
            requested_sensor_ids=(),
            promotion_reason="",
            rejection_reason="",
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

    def _discover_dynamic_theme_states(
        self,
        *,
        fixture: ScenarioFixture,
        provider_health: dict[str, ProviderHealth],
        evidence_status: dict[str, str],
        previous_states: dict[str, DriverAttentionState],
        as_of: datetime,
        data_mode: str,
    ) -> dict[str, DriverAttentionState]:
        buckets: dict[str, dict[str, Any]] = {}
        news_ids = {id(item) for item in fixture.news}
        for headline in (*fixture.news, *fixture.calendar_events):
            terms = _candidate_theme_terms(headline.title, headline.tags)
            if not terms:
                continue
            primary_term = terms[0]
            theme_id = f"theme:{_theme_slug(primary_term)}"
            bucket = buckets.setdefault(
                theme_id,
                {
                    "theme_id": theme_id,
                    "label": primary_term.title(),
                    "source_terms": set(),
                    "sources": set(),
                    "headlines": [],
                    "calendar_events": [],
                },
            )
            bucket["source_terms"].update(terms[:5])
            bucket["sources"].add(headline.source)
            if id(headline) in news_ids:
                bucket["headlines"].append(headline)
            else:
                bucket["calendar_events"].append(headline)

        states: dict[str, DriverAttentionState] = {}
        for theme_id, bucket in buckets.items():
            previous = previous_states.get(theme_id)
            previous_headlines = previous.related_news_count if previous else 0
            previous_sources = previous.source_count if previous else 0
            current_headline_count = len(bucket["headlines"]) + len(bucket["calendar_events"])
            headline_count = max(current_headline_count, previous_headlines)
            source_count = max(len(bucket["sources"]), previous_sources)
            terms = sorted(bucket["source_terms"])
            requested_sensors = _requested_sensors_for_terms(terms, provider_health)
            confirmed, confirmation_reason = _theme_cross_asset_confirmation(
                requested_sensor_ids=requested_sensors,
                evidence_status=evidence_status,
                provider_health=provider_health,
            )
            meaningful_move = abs(fixture.market.move_percent) >= 0.25
            repeated = headline_count >= 2
            multi_source = source_count >= 2
            current_state = "observed"
            relevance_score = 0.18
            confidence = "low"
            promotion_reason = ""
            rejection_reason = "Single-source or one-off headline; not enough evidence."
            evidence_summary = f"{headline_count} headline(s) from {source_count} source(s)."
            counter_evidence = confirmation_reason if not confirmed else ""
            if repeated and multi_source and confirmed and meaningful_move:
                current_state = "active"
                relevance_score = 0.76
                confidence = "medium"
                promotion_reason = (
                    "Repeated headlines, multiple sources, cross-asset confirmation, and an XAUUSD reaction."
                )
                rejection_reason = ""
                evidence_summary = f"{evidence_summary} {confirmation_reason}"
            elif repeated and multi_source:
                current_state = "emerging"
                relevance_score = 0.52
                confidence = "low"
                promotion_reason = "Repeated headlines across multiple sources."
                rejection_reason = "Waiting for market confirmation before treating it as a driver."
            elif repeated or multi_source:
                current_state = "watching"
                relevance_score = 0.34
                rejection_reason = "Theme is visible but lacks either repetition, source breadth, or market confirmation."

            driver = DriverDefinition(
                driver_id=theme_id,
                label=str(bucket["label"]),
                category="theme",
                priority="micro_theme",
                linked_assets=requested_sensors,
                required_evidence_gates=("news",),
                optional_evidence_gates=requested_sensors,
            )
            base = self._empty_state(driver, as_of=as_of, data_mode=data_mode)
            next_state = DriverAttentionState(
                **{
                    **asdict(base),
                    "current_state": current_state,
                    "relevance_score": relevance_score,
                    "activation_reason": promotion_reason,
                    "deactivation_reason": "" if current_state in {"active", "emerging", "watching"} else rejection_reason,
                    "first_activated_at": previous.first_activated_at if previous and previous.first_activated_at else fixture.as_of_myt,
                    "last_confirmed_at": fixture.as_of_myt if current_state == "active" else (previous.last_confirmed_at if previous else ""),
                    "last_evidence_at": fixture.as_of_myt,
                    "confidence": confidence,
                    "source_count": source_count,
                    "related_news_count": max(len(bucket["headlines"]), previous.related_news_count if previous else 0),
                    "related_calendar_events": len(bucket["calendar_events"]),
                    "current_evidence_summary": evidence_summary,
                    "current_counter_evidence": counter_evidence,
                    "notes": "Dynamic theme discovered from current headlines. It does not become a cause unless evidence gates support it.",
                    "theme_id": theme_id,
                    "lifecycle": current_state,
                    "source_terms": tuple(terms[:8]),
                    "related_sensor_ids": tuple(item for item in requested_sensors if item in provider_health),
                    "requested_sensor_ids": requested_sensors,
                    "promotion_reason": promotion_reason,
                    "rejection_reason": rejection_reason,
                }
            )
            states[theme_id] = self._transition_with_decay(previous, next_state, as_of=as_of)

        for theme_id, previous in previous_states.items():
            if not theme_id.startswith("theme:") or theme_id in states:
                continue
            states[theme_id] = DriverAttentionState(
                **{
                    **asdict(previous),
                    "current_state": "retired",
                    "deactivation_reason": "No fresh headlines or market follow-through for this dynamic theme.",
                    "current_counter_evidence": "Theme has no fresh supporting evidence in the current run.",
                    "relevance_score": 0.0,
                    "confidence": "low",
                    "lifecycle": "retired",
                    "data_mode": data_mode,
                }
            )
        return states

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

        states.update(
            self._discover_dynamic_theme_states(
                fixture=fixture,
                provider_health=provider_health,
                evidence_status=evidence_status,
                previous_states=previous_states,
                as_of=as_of,
                data_mode=data_mode,
            )
        )

        active = [
            {
                "driver_id": item.driver_id,
                "current_state": item.current_state,
                "activation_reason": item.activation_reason,
            }
            for item in states.values()
            if item.current_state in {"active", "emerging"}
        ]
        dormant = [
            {
                "driver_id": item.driver_id,
                "current_state": item.current_state,
                "note": item.notes or item.current_counter_evidence,
            }
            for item in states.values()
            if item.current_state in {"dormant", "watching", "unknown", "cooling"}
            or (item.current_state == "retired" and not item.driver_id.startswith("theme:"))
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
