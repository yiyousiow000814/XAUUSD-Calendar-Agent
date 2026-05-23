from __future__ import annotations

from dataclasses import asdict, replace
from datetime import datetime
import time
from pathlib import Path
from typing import Any

from .backfill import BackfillManager
from .config import MarketAgentConfig
from .driver_attention import DriverAttentionManager
from .detectors import detect_market_trigger
from .evidence import build_evidence_gate_result
from .llm_client import LocalLLMClient
from .models import CrossAssetSnapshot, EvidenceChainStatus, Headline, MarketMove, ProviderHealth, ScenarioFixture
from .notification_policy import decide_notification
from .notifier import FileNotificationSink, TelegramNotificationSink
from .pipeline import analyze_fixture_with_optional_llm
from .provider_health import health_to_dict
from .providers.provider_router import ProviderRouter
from .state_store import JsonStateStore
from .timeline_store import TimelineStore


def _parse_ts(raw: str) -> datetime:
    return datetime.fromisoformat(raw)


def _headline_time(raw: str) -> str:
    return _parse_ts(raw).astimezone().strftime("%d-%m-%Y %H:%M")


def _headline_from_news(row: dict[str, Any]) -> Headline:
    tags = tuple(row.get("categories", [])) + tuple(row.get("matched_keywords", []))
    if not row.get("included", True):
        tags = tags + ("filtered", str(row.get("filter_reason", "")))
    return Headline(
        timestamp_myt=_headline_time(row["published_at"]),
        source=str(row["source"]),
        title=str(row["title"]),
        relevance_reason=str(row.get("relevance_reason", "")),
        impact_direction_on_gold=str(row.get("impact_direction_on_gold", "unknown")),
        tags=tuple(dict.fromkeys(tags)),
    )


def _headline_from_calendar(row: dict[str, Any]) -> Headline:
    tags = ("calendar", str(row.get("impact", "")).lower())
    return Headline(
        timestamp_myt=_headline_time(row["scheduled_at"]),
        source=str(row["source"]),
        title=str(row["title"]),
        relevance_reason=str(row.get("relevance_reason", "")),
        impact_direction_on_gold=str(row.get("impact_direction_on_gold", "unknown")),
        tags=tuple(dict.fromkeys(tags)),
    )


def _empty_fixture(anchor_time: datetime) -> ScenarioFixture:
    return ScenarioFixture(
        scenario_id="live_market_unavailable",
        as_of_myt=anchor_time.astimezone().strftime("%d-%m-%Y %H:%M"),
        market=MarketMove(
            symbol="XAUUSD",
            from_price=0.0,
            to_price=0.0,
            move_percent=0.0,
            move_percent_15m=0.0,
            move_percent_1h=0.0,
            window_minutes=15,
            breaks=(),
        ),
        cross_asset=CrossAssetSnapshot(
            dxy_percent=0.0,
            us10y_bps=0.0,
            us2y_bps=0.0,
            wti_percent=0.0,
            brent_percent=0.0,
            vix_percent=0.0,
            spx_percent=0.0,
            nasdaq_percent=0.0,
        ),
        calendar_events=(),
        news=(),
        expected_llm_claim=None,
    )


def _cross_asset_from_rows(related_rows: list[dict[str, Any]]) -> CrossAssetSnapshot:
    latest: dict[str, dict[str, Any]] = {}
    for row in sorted(related_rows, key=lambda item: item["data_timestamp"]):
        latest[str(row["symbol"]).lower()] = row

    def value(symbol: str) -> float:
        row = latest.get(symbol, {})
        return float(
            row.get("change_15m")
            or row.get("change_value")
            or 0.0
        )

    return CrossAssetSnapshot(
        dxy_percent=value("dxy"),
        us10y_bps=value("us10y"),
        us2y_bps=value("us2y"),
        wti_percent=value("wti"),
        brent_percent=value("brent"),
        vix_percent=value("vix"),
        spx_percent=value("spx"),
        nasdaq_percent=value("nasdaq"),
    )


def _market_move_from_rows(anchor_time: datetime, rows: list[dict[str, Any]]) -> MarketMove:
    if not rows:
        return _empty_fixture(anchor_time).market
    ordered = sorted(rows, key=lambda item: item["data_timestamp"])
    first = ordered[0]
    last = ordered[-1]
    from_price = float(first.get("open_price") or first["close_price"])
    to_price = float(last["close_price"])
    move_percent = 0.0 if from_price == 0 else ((to_price - from_price) / from_price) * 100.0
    return MarketMove(
        symbol=str(last.get("symbol", "XAUUSD")),
        from_price=from_price,
        to_price=to_price,
        move_percent=move_percent,
        move_percent_15m=move_percent,
        move_percent_1h=move_percent,
        window_minutes=max(15, len(ordered) * 5),
        breaks=(),
    )


def _build_fixture_from_context(
    *,
    anchor_time: datetime,
    market_price_bars: list[dict[str, Any]],
    related_asset_bars: list[dict[str, Any]],
    news_rows: list[dict[str, Any]],
    calendar_rows: list[dict[str, Any]],
    scenario_id: str,
) -> ScenarioFixture:
    market = _market_move_from_rows(anchor_time, market_price_bars)
    included_news_rows = [item for item in news_rows if item.get("included", True)]
    return ScenarioFixture(
        scenario_id=scenario_id,
        as_of_myt=anchor_time.astimezone().strftime("%d-%m-%Y %H:%M"),
        market=market,
        cross_asset=_cross_asset_from_rows(related_asset_bars),
        calendar_events=tuple(_headline_from_calendar(item) for item in calendar_rows),
        news=tuple(_headline_from_news(item) for item in included_news_rows),
        expected_llm_claim=None,
    )


def _build_runtime_context(
    config: MarketAgentConfig,
    anchor_time: datetime,
    *,
    provider_router: ProviderRouter | None = None,
    news_headlines: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    router = provider_router or ProviderRouter.from_config(config)
    market_rows, market_health = router.fetch_market_context(anchor_time)
    related_rows, related_health = router.fetch_related_assets_context(anchor_time)
    news_rows, news_health = router.fetch_news_context(anchor_time)
    calendar_rows, calendar_health = router.fetch_calendar_context(anchor_time)
    if news_headlines:
        injected = []
        for item in news_headlines:
            published_at = str(item.get("published_at", anchor_time.isoformat()))
            injected.append(
                {
                    "published_at": published_at,
                    "first_seen_at": anchor_time.isoformat(),
                    "backfilled_at": None,
                    "is_backfilled": False,
                    "source": str(item.get("source", "Injected")),
                    "title": str(item.get("title", "")),
                    "link": str(item.get("link", "")),
                    "relevance_reason": str(item.get("relevance_reason", "Injected headline.")),
                    "impact_direction_on_gold": str(item.get("impact_direction_on_gold", "unknown")),
                    "data_mode": "live_seen",
                    "included": bool(item.get("included", True)),
                    "filter_reason": str(item.get("filter_reason", "")),
                    "source_quality_score": float(item.get("source_quality_score", item.get("score", 0.6))),
                    "score": float(item.get("score", 0.6)),
                    "matched_keywords": item.get("matched_keywords", []),
                    "categories": item.get("categories", ["injected"]),
                }
            )
        news_rows.extend(injected)
        news_rows.sort(key=lambda item: item["published_at"])
        if injected:
            news_health = ProviderHealth(
                **{
                    **asdict(news_health),
                    "data_mode": news_health.data_mode if news_health.is_available else "live_seen",
                    "is_available": True,
                    "current_value": float(len(news_rows)),
                    "data_timestamp": news_rows[-1]["published_at"],
                }
            )
    fixture = _build_fixture_from_context(
        anchor_time=anchor_time,
        market_price_bars=market_rows,
        related_asset_bars=related_rows,
        news_rows=news_rows,
        calendar_rows=calendar_rows,
        scenario_id="live_once",
    )
    return {
        "fixture": fixture,
        "provider_health": {
            "xauusd": market_health,
            **related_health,
            "news": news_health,
            "calendar": calendar_health,
        },
        "selected_market_provider": router.last_market_provider_meta.get("selected_market_provider", "unavailable"),
        "provider_chain_status": router.last_market_provider_meta.get("provider_chain_status", []),
        "fallback_reason": router.last_market_provider_meta.get("fallback_reason", ""),
        "market_price_bars": market_rows,
        "related_asset_bars": related_rows,
        "news_rows": news_rows,
        "calendar_rows": calendar_rows,
    }


def _run_recovery_backfill(
    config: MarketAgentConfig,
    *,
    previous_run_at: str,
    anchor_time: datetime,
    provider_router: ProviderRouter | None = None,
    news_headlines: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    router = provider_router or ProviderRouter.from_config(config)
    recovery = BackfillManager(router).recover_gap(datetime.fromisoformat(previous_run_at), anchor_time)
    if news_headlines:
        for item in news_headlines:
            recovery.news_rows.append(
                {
                    "published_at": str(item.get("published_at", anchor_time.isoformat())),
                    "first_seen_at": anchor_time.isoformat(),
                    "backfilled_at": anchor_time.isoformat(),
                    "is_backfilled": True,
                    "source": str(item.get("source", "Injected")),
                    "title": str(item.get("title", "")),
                    "link": str(item.get("link", "")),
                    "relevance_reason": str(item.get("relevance_reason", "Injected recovery headline.")),
                    "impact_direction_on_gold": str(item.get("impact_direction_on_gold", "unknown")),
                    "data_mode": "backfilled",
                    "included": bool(item.get("included", True)),
                    "filter_reason": str(item.get("filter_reason", "")),
                    "source_quality_score": float(item.get("source_quality_score", item.get("score", 0.6))),
                    "score": float(item.get("score", 0.6)),
                    "matched_keywords": item.get("matched_keywords", []),
                    "categories": item.get("categories", ["injected"]),
                }
            )
        recovery.news_rows.sort(key=lambda item: item["published_at"])
    fixture = _build_fixture_from_context(
        anchor_time=anchor_time,
        market_price_bars=recovery.market_price_bars,
        related_asset_bars=recovery.related_asset_bars,
        news_rows=recovery.news_rows,
        calendar_rows=recovery.calendar_rows,
        scenario_id="recovery",
    )
    return {
        "fixture": fixture,
        "provider_health": recovery.provider_health,
        "selected_market_provider": router.last_market_provider_meta.get("selected_market_provider", "unavailable"),
        "provider_chain_status": router.last_market_provider_meta.get("provider_chain_status", []),
        "fallback_reason": router.last_market_provider_meta.get("fallback_reason", ""),
        "market_price_bars": recovery.market_price_bars,
        "related_asset_bars": recovery.related_asset_bars,
        "news_rows": recovery.news_rows,
        "calendar_rows": recovery.calendar_rows,
        "recovery_summary": recovery.recovery_summary,
        "recovery_timeline_events": recovery.recovery_timeline_events,
    }


def build_live_fixture(
    config: MarketAgentConfig,
    anchor_time: datetime,
    news_headlines: list[dict[str, Any]] | None = None,
    provider_router: ProviderRouter | None = None,
) -> ScenarioFixture:
    return _build_runtime_context(
        config,
        anchor_time=anchor_time,
        provider_router=provider_router,
        news_headlines=news_headlines,
    )["fixture"]


def _is_live_xauusd_health(health: ProviderHealth | None) -> bool:
    if health is None:
        return False
    try:
        age_seconds = (
            datetime.fromisoformat(health.fetched_at) - datetime.fromisoformat(health.data_timestamp)
        ).total_seconds()
    except (TypeError, ValueError):
        return False
    return (
        health.is_available
        and not health.is_stale
        and health.data_mode == "live_seen"
        and (health.current_value is None or float(health.current_value) > 0)
        and 0 <= age_seconds <= 300
    )


def _build_evidence_chain_status(
    *,
    fixture: ScenarioFixture,
    provider_health: dict[str, ProviderHealth],
    evidence_status: dict[str, str],
    data_mode: str,
    analysis: Any | None = None,
    market_price_bar_count: int | None = None,
    related_asset_bar_count: int | None = None,
    news_row_count: int | None = None,
    calendar_row_count: int | None = None,
) -> EvidenceChainStatus:
    missing_required: list[str] = []
    usable_inputs: list[str] = []
    context_only_inputs: list[str] = []

    xauusd = provider_health.get("xauusd")
    if _is_live_xauusd_health(xauusd) and fixture.market.to_price > 0:
        usable_inputs.append("live_xauusd_spot")
    elif xauusd and xauusd.is_available and xauusd.is_stale and xauusd.current_value:
        context_only_inputs.append("market_closed_last_xauusd_spot")
        missing_required.append("live_xauusd_spot")
    else:
        missing_required.append("live_xauusd_spot")

    if market_price_bar_count is None:
        has_history = fixture.market.from_price > 0 and fixture.market.to_price > 0 and fixture.market.window_minutes >= 15
    else:
        has_history = market_price_bar_count >= 2
    if has_history:
        usable_inputs.append("xauusd_recent_history")
    else:
        missing_required.append("xauusd_recent_history")

    confirming_related = [
        key
        for key in ("dxy", "us10y", "us2y", "oil", "vix_equities")
        if evidence_status.get(key) == "confirming"
    ]
    unavailable_related = [
        key
        for key in ("dxy", "us10y", "us2y", "oil", "vix_equities")
        if evidence_status.get(key) in {"unavailable", "stale"}
    ]
    if confirming_related:
        usable_inputs.extend(f"confirming_{key}" for key in confirming_related)
    elif related_asset_bar_count:
        context_only_inputs.append("cross_market_sensors")
    else:
        context_only_inputs.append("cross_market_sensors_unavailable")

    if news_row_count:
        usable_inputs.append("news_context")
    else:
        context_only_inputs.append("news_waiting")
    if calendar_row_count:
        usable_inputs.append("calendar_context")
    else:
        context_only_inputs.append("calendar_waiting")

    llm_status = str(getattr(analysis, "llm_status", "") or "not_used")
    if analysis is not None:
        if str(getattr(analysis, "analysis_engine", "")) == "llm_validated":
            usable_inputs.append("llm_validated")
        else:
            context_only_inputs.append(f"llm_{llm_status}")

    if missing_required:
        return EvidenceChainStatus(
            status="context_only",
            can_show_current_conclusion=False,
            reason="Current conclusion is paused until live XAUUSD price and recent price history are available.",
            missing_required=missing_required,
            usable_inputs=usable_inputs,
            context_only_inputs=context_only_inputs,
            llm_status=llm_status,
        )

    if unavailable_related and not confirming_related:
        return EvidenceChainStatus(
            status="partial",
            can_show_current_conclusion=True,
            reason="Price evidence is available, but cross-market confirmation is incomplete; only unknown or unconfirmed conclusions can pass.",
            missing_required=[],
            usable_inputs=usable_inputs,
            context_only_inputs=[*context_only_inputs, *[f"{key}_unavailable" for key in unavailable_related]],
            llm_status=llm_status,
        )

    return EvidenceChainStatus(
        status="ready",
        can_show_current_conclusion=True,
        reason="Live price, recent history, provider health, evidence gate, and validation are available for this run.",
        missing_required=[],
        usable_inputs=usable_inputs,
        context_only_inputs=context_only_inputs,
        llm_status=llm_status,
    )


def _downgrade_analysis_for_incomplete_chain(analysis: Any, chain_status: EvidenceChainStatus) -> Any:
    if chain_status.can_show_current_conclusion:
        return analysis
    if not hasattr(analysis, "__dataclass_fields__"):
        return analysis
    return replace(
        analysis,
        bias="neutral",
        main_driver="unknown",
        secondary_driver=None,
        cause_status="unconfirmed",
        confidence="low",
        is_new_state=False,
        is_continuation=False,
        previous_state_invalidated=False,
        should_notify=False,
        notification_level="none",
        allowed_candidate_drivers_used=["unknown"],
        causal_chain=chain_status.reason,
        user_message="Current market context is still being collected. No confirmed driver is available yet.",
        summary=chain_status.reason,
    )


def _suppress_unhelpful_alert(
    analysis: Any,
    *,
    chain_status: EvidenceChainStatus,
    provider_health: dict[str, ProviderHealth],
) -> Any:
    if not getattr(analysis, "should_notify", False) or not hasattr(analysis, "__dataclass_fields__"):
        return analysis

    xauusd = provider_health.get("xauusd")
    market_closed_context = bool(
        xauusd
        and xauusd.is_available
        and xauusd.is_stale
        and xauusd.current_value is not None
    )
    no_news_low_signal = bool(getattr(analysis, "no_news_found", False)) and str(
        getattr(analysis, "cause_status", "")
    ) in {"likely", "unconfirmed"}
    weak_unconfirmed = str(getattr(analysis, "cause_status", "")) == "unconfirmed" and str(
        getattr(analysis, "notification_level", "")
    ) in {"level_1", "level_2"}

    if chain_status.can_show_current_conclusion and not market_closed_context and not no_news_low_signal and not weak_unconfirmed:
        return analysis

    if market_closed_context:
        reason = "Market is closed; last price is context only and Telegram alert is suppressed."
    elif no_news_low_signal:
        reason = "No fresh news/calendar evidence confirmed the move; Telegram alert is suppressed."
    elif weak_unconfirmed:
        reason = "Move is still unconfirmed; Telegram alert is suppressed."
    else:
        reason = chain_status.reason

    return replace(
        analysis,
        should_notify=False,
        notification_level="none",
        causal_chain=reason,
        user_message=reason,
        summary=reason,
    )


def _build_packet(
    fixture: ScenarioFixture,
    *,
    provider_health: dict[str, ProviderHealth],
    attention_snapshot: Any,
    previous_state: Any,
    data_mode: str,
    analysis: Any | None = None,
    market_price_bar_count: int | None = None,
    related_asset_bar_count: int | None = None,
    news_row_count: int | None = None,
    calendar_row_count: int | None = None,
    selected_market_provider: str = "unavailable",
    provider_chain_status: list[dict[str, Any]] | None = None,
    fallback_reason: str = "",
) -> dict[str, Any]:
    evidence = build_evidence_gate_result(
        fixture,
        provider_health=provider_health,
        attention_snapshot=attention_snapshot,
    )
    dynamic_themes = [
        asdict(state)
        for state in attention_snapshot.states.values()
        if str(state.driver_id).startswith("theme:")
    ]
    requested_sensors = sorted(
        {
            sensor_id
            for theme in dynamic_themes
            for sensor_id in theme.get("requested_sensor_ids", [])
        }
    )
    chain_status = _build_evidence_chain_status(
        fixture=fixture,
        provider_health=provider_health,
        evidence_status=evidence.evidence_status,
        data_mode=data_mode,
        analysis=analysis,
        market_price_bar_count=market_price_bar_count,
        related_asset_bar_count=related_asset_bar_count,
        news_row_count=news_row_count,
        calendar_row_count=calendar_row_count,
    )
    return {
        "as_of_myt": fixture.as_of_myt,
        "data_mode": data_mode,
        "market_move": {
            "symbol": fixture.market.symbol,
            "from_price": fixture.market.from_price,
            "to_price": fixture.market.to_price,
            "move_percent": fixture.market.move_percent,
            "window_minutes": fixture.market.window_minutes,
            "source_type": provider_health["xauusd"].source_type if "xauusd" in provider_health else "",
            "provider_data_mode": provider_health["xauusd"].data_mode if "xauusd" in provider_health else "",
        },
        "provider_health": health_to_dict(provider_health),
        "selected_market_provider": selected_market_provider,
        "provider_chain_status": provider_chain_status or [],
        "fallback_reason": fallback_reason,
        "active_driver_states": attention_snapshot.active_driver_states,
        "dormant_driver_states": attention_snapshot.dormant_driver_states,
        "driver_attention_summary": attention_snapshot.driver_attention_summary,
        "dynamic_themes": dynamic_themes,
        "requested_sensors": requested_sensors,
        "evidence_chain_status": asdict(chain_status),
        "previous_state": asdict(previous_state) if previous_state is not None and hasattr(previous_state, "__dataclass_fields__") else previous_state,
        "calendar_events": [
            {"timestamp_myt": item.timestamp_myt, "title": item.title, "source": item.source}
            for item in fixture.calendar_events
        ],
        "news": [
            {"timestamp_myt": item.timestamp_myt, "title": item.title, "source": item.source}
            for item in fixture.news
        ],
        "allowed_candidate_drivers": evidence.allowed_candidate_drivers,
        "blocked_drivers": evidence.blocked_drivers,
        "cross_asset_confirmation": evidence.cross_asset_confirmation,
        "evidence_status": evidence.evidence_status,
    }


def _resolve_runtime_data_mode(
    *,
    backfill_required: bool,
    provider_health: dict[str, ProviderHealth],
) -> str:
    if backfill_required:
        return "backfilled"
    return provider_health.get("xauusd", ProviderHealth("", "", "", "", "unavailable", False, False)).data_mode or "unavailable"


def _semantic_market_event_payload(
    fixture: ScenarioFixture,
    analysis: Any,
    decision: Any,
    *,
    run_type: str,
    data_mode: str,
) -> dict[str, Any]:
    trigger = detect_market_trigger(fixture)
    move = float(fixture.market.move_percent_15m or fixture.market.move_percent or 0.0)
    cause_status = str(getattr(analysis, "cause_status", "") or "").lower()
    main_driver = str(getattr(analysis, "main_driver", "") or "unknown")
    has_news = bool(fixture.news)
    has_calendar = bool(fixture.calendar_events)
    if bool(getattr(decision, "previous_state_invalidated", False)):
        semantic_type = "reversal"
    elif "session_break" in trigger.trigger_types:
        semantic_type = "session"
    elif has_news and cause_status not in {"no_meaningful_change", "unconfirmed"}:
        semantic_type = "news"
    elif abs(move) >= 0.35:
        semantic_type = "breakout"
    elif abs(move) < 0.18 and not trigger.triggered:
        semantic_type = "range"
    else:
        semantic_type = "analysis"
    return {
        "semantic_type": semantic_type,
        "impact_percent": move,
        "direction": "up" if move > 0 else "down" if move < 0 else "flat",
        "duration_minutes": fixture.market.window_minutes,
        "trigger_types": trigger.trigger_types,
        "main_driver": main_driver,
        "driver_label": main_driver,
        "has_news": has_news,
        "has_calendar": has_calendar,
        "run_type": run_type,
        "data_mode": data_mode,
    }


def build_live_evidence_packet(
    config: MarketAgentConfig,
    anchor_time: datetime,
    news_headlines: list[dict[str, Any]] | None = None,
    previous_state=None,
    data_mode: str = "live_seen",
    provider_router: ProviderRouter | None = None,
) -> dict[str, Any]:
    context = _build_runtime_context(
        config,
        anchor_time=anchor_time,
        provider_router=provider_router,
        news_headlines=news_headlines,
    )
    fixture = context["fixture"]
    provider_health = context["provider_health"]
    evidence = build_evidence_gate_result(fixture, provider_health=provider_health)
    attention_snapshot = DriverAttentionManager().evaluate(
        fixture=fixture,
        provider_health=provider_health,
        evidence_status=evidence.evidence_status,
        data_mode=provider_health["xauusd"].data_mode if "xauusd" in provider_health else data_mode,
    )
    return _build_packet(
        fixture,
        provider_health=provider_health,
        attention_snapshot=attention_snapshot,
        previous_state=previous_state,
        data_mode=provider_health["xauusd"].data_mode if "xauusd" in provider_health else data_mode,
        market_price_bar_count=len(context.get("market_price_bars", [])),
        related_asset_bar_count=len(context.get("related_asset_bars", [])),
        news_row_count=len(context.get("news_rows", [])),
        calendar_row_count=len(context.get("calendar_rows", [])),
        selected_market_provider=context.get("selected_market_provider", "unavailable"),
        provider_chain_status=context.get("provider_chain_status", []),
        fallback_reason=context.get("fallback_reason", ""),
    )


def run_live_once(
    config: MarketAgentConfig,
    anchor_time: datetime | None = None,
    news_headlines: list[dict[str, Any]] | None = None,
    llm_client=None,
    previous_state=None,
    data_mode: str = "live_seen",
    provider_router: ProviderRouter | None = None,
) -> tuple[ScenarioFixture, Any]:
    anchor = anchor_time or datetime.now().astimezone()
    context = _build_runtime_context(
        config,
        anchor_time=anchor,
        provider_router=provider_router,
        news_headlines=news_headlines,
    )
    fixture = context["fixture"]
    provider_health = context["provider_health"]
    evidence = build_evidence_gate_result(fixture, provider_health=provider_health)
    attention_snapshot = DriverAttentionManager().evaluate(
        fixture=fixture,
        provider_health=provider_health,
        evidence_status=evidence.evidence_status,
        data_mode=provider_health["xauusd"].data_mode if "xauusd" in provider_health else data_mode,
    )
    result = analyze_fixture_with_optional_llm(
        fixture,
        llm_client=llm_client or LocalLLMClient(),
        previous_state=previous_state,
        provider_health=provider_health,
        attention_snapshot=attention_snapshot,
        data_mode=provider_health["xauusd"].data_mode if "xauusd" in provider_health else data_mode,
    )
    return fixture, result


def _detect_gap(
    *,
    previous_run_at: str | None,
    anchor: datetime,
    gap_minutes: int,
) -> tuple[bool, str]:
    if not previous_run_at:
        return False, "live"
    delta = anchor - datetime.fromisoformat(previous_run_at)
    if delta.total_seconds() / 60.0 > gap_minutes:
        return True, "recovery"
    return False, "live"


def run_monitored_live_once(
    config: MarketAgentConfig,
    anchor_time: datetime | None = None,
    state_path: Path | None = None,
    alerts_path: Path | None = None,
    cooldown_minutes: int | None = None,
    news_headlines: list[dict[str, Any]] | None = None,
    timeline_store_path: Path | None = None,
    llm_client=None,
    provider_router: ProviderRouter | None = None,
    telegram_sink=None,
) -> dict[str, Any]:
    anchor = anchor_time or datetime.now().astimezone()
    state_store = JsonStateStore(state_path or config.state_store_path)
    timeline_store = TimelineStore(timeline_store_path or config.timeline_store_path)
    sink = FileNotificationSink(alerts_path or config.alerts_output_path)
    previous_state = state_store.load()
    last_successful_run_at = timeline_store.get_last_successful_run_at()
    previous_attention_states = timeline_store.load_latest_driver_attention_states()
    backfill_required, run_type = _detect_gap(
        previous_run_at=last_successful_run_at,
        anchor=anchor,
        gap_minutes=config.backfill_gap_minutes,
    )
    runtime_context = (
        _run_recovery_backfill(
            config,
            previous_run_at=last_successful_run_at or anchor.isoformat(),
            anchor_time=anchor,
            provider_router=provider_router,
            news_headlines=news_headlines,
        )
        if backfill_required
        else _build_runtime_context(
            config,
            anchor_time=anchor,
            provider_router=provider_router,
            news_headlines=news_headlines,
        )
    )
    fixture = runtime_context["fixture"]
    provider_health = runtime_context["provider_health"]
    data_mode = _resolve_runtime_data_mode(
        backfill_required=backfill_required,
        provider_health=provider_health,
    )
    evidence = build_evidence_gate_result(fixture, provider_health=provider_health)
    attention_snapshot = DriverAttentionManager().evaluate(
        fixture=fixture,
        provider_health=provider_health,
        evidence_status=evidence.evidence_status,
        previous_states=previous_attention_states,
        data_mode=data_mode,
    )
    analysis = analyze_fixture_with_optional_llm(
        fixture,
        llm_client=llm_client or LocalLLMClient(),
        previous_state=previous_state,
        provider_health=provider_health,
        attention_snapshot=attention_snapshot,
        data_mode=data_mode,
    )
    pre_decision_chain_status = _build_evidence_chain_status(
        fixture=fixture,
        provider_health=provider_health,
        evidence_status=evidence.evidence_status,
        data_mode=data_mode,
        analysis=analysis,
        market_price_bar_count=len(runtime_context.get("market_price_bars", [])),
        related_asset_bar_count=len(runtime_context.get("related_asset_bars", [])),
        news_row_count=len(runtime_context.get("news_rows", [])),
        calendar_row_count=len(runtime_context.get("calendar_rows", [])),
    )
    analysis = _downgrade_analysis_for_incomplete_chain(analysis, pre_decision_chain_status)
    analysis = _suppress_unhelpful_alert(
        analysis,
        chain_status=pre_decision_chain_status,
        provider_health=provider_health,
    )
    decision = decide_notification(
        previous_state=previous_state,
        analysis_result=analysis,
        now_iso=anchor.isoformat(),
        cooldown_minutes=cooldown_minutes or config.notification_cooldown_minutes,
    )
    telegram_result = {
        "sent": False,
        "status": "disabled",
        "error": "",
        "notification_level": decision.notification_level,
    }
    if decision.should_notify:
        message = analysis.user_message
        alert_payload = {
            "time": anchor.isoformat(),
            "notification_level": decision.notification_level,
            "message": message,
            "main_driver": analysis.main_driver,
            "bias": analysis.bias,
            "state_change_reason": decision.state_change_reason,
            "confidence_delta": decision.confidence_delta,
            "previous_state_invalidated": decision.previous_state_invalidated,
            "invalidation_triggered_by": decision.invalidation_triggered_by,
        }
        sink.emit(alert_payload)
        if config.telegram_enabled:
            telegram = telegram_sink or TelegramNotificationSink(
                bot_token=config.telegram_bot_token,
                chat_id=config.telegram_chat_id,
                timeout_seconds=config.telegram_timeout_seconds,
                enabled_levels=set(config.telegram_levels),
            )
            telegram_payload = {
                **alert_payload,
                "selected_market_provider": runtime_context.get("selected_market_provider", "unavailable"),
                "data_mode": data_mode,
            }
            if hasattr(telegram, "send"):
                telegram_result = telegram.send(telegram_payload)
            else:
                try:
                    sent = telegram.emit(telegram_payload)
                    telegram_result = {
                        "sent": bool(sent),
                        "status": "sent" if sent else "failed",
                        "error": "",
                        "notification_level": decision.notification_level,
                    }
                except Exception as exc:
                    telegram_result = {
                        "sent": False,
                        "status": "failed",
                        "error": str(exc),
                        "notification_level": decision.notification_level,
                    }
    state_store.save(decision.next_state)
    packet = _build_packet(
        fixture,
        provider_health=provider_health,
        attention_snapshot=attention_snapshot,
        previous_state=previous_state,
        data_mode=data_mode,
        analysis=analysis,
        market_price_bar_count=len(runtime_context.get("market_price_bars", [])),
        related_asset_bar_count=len(runtime_context.get("related_asset_bars", [])),
        news_row_count=len(runtime_context.get("news_rows", [])),
        calendar_row_count=len(runtime_context.get("calendar_rows", [])),
        selected_market_provider=runtime_context.get("selected_market_provider", "unavailable"),
        provider_chain_status=runtime_context.get("provider_chain_status", []),
        fallback_reason=runtime_context.get("fallback_reason", ""),
    )
    monitor_run_id = timeline_store.record_monitor_run(
        run_started_at=anchor.isoformat(),
        run_type=run_type,
        data_mode=data_mode,
        backfill_required=backfill_required,
        last_successful_run_at=last_successful_run_at,
        no_news_found=bool(analysis.no_news_found),
        alert_suppressed_reason="" if decision.should_notify else decision.reason,
    )
    timeline_store.record_provider_health(monitor_run_id, packet["provider_health"])
    timeline_store.record_market_price_bars(monitor_run_id, runtime_context["market_price_bars"])
    timeline_store.record_related_asset_bars(monitor_run_id, runtime_context["related_asset_bars"])
    timeline_store.record_news_items(monitor_run_id, runtime_context["news_rows"])
    timeline_store.record_calendar_events(monitor_run_id, runtime_context["calendar_rows"])
    timeline_store.record_driver_attention_states(
        monitor_run_id,
        {key: asdict(value) for key, value in attention_snapshot.states.items()},
    )
    timeline_store.record_evidence_packet(monitor_run_id, packet)
    timeline_store.record_analysis_result(
        monitor_run_id,
        analysis.to_dict(),
        rejected_driver=getattr(analysis, "rejected_driver", None),
        rejection_reason=getattr(analysis, "rejection_reason", None),
    )
    timeline_store.record_alert(
        monitor_run_id,
        {
            "should_notify": decision.should_notify,
            "notification_level": decision.notification_level,
            "reason": decision.reason,
            "telegram": telegram_result,
        },
    )
    timeline_store.record_state_transition(
        monitor_run_id,
        {
            "is_new_state": decision.is_new_state,
            "is_continuation": decision.is_continuation,
            "previous_state_invalidated": decision.previous_state_invalidated,
            "state_change_reason": decision.state_change_reason,
            "confidence_changed": decision.confidence_changed,
            "confidence_delta": decision.confidence_delta,
            "invalidation_triggered_by": decision.invalidation_triggered_by,
            "next_state": asdict(decision.next_state),
        },
    )
    timeline_store.record_timeline_event(
        monitor_run_id,
        event_time=anchor.isoformat(),
        event_type="analysis",
        label=analysis.main_driver,
        payload={
            **_semantic_market_event_payload(
                fixture,
                analysis,
                decision,
                run_type=run_type,
                data_mode=data_mode,
            ),
            "analysis": analysis.to_dict(),
        },
    )
    if backfill_required:
        for item in runtime_context.get("recovery_timeline_events", []):
            timeline_store.record_timeline_event(
                monitor_run_id,
                event_time=item["event_time"],
                event_type=item["event_type"],
                label=item["label"],
                payload=item["payload"],
            )
        timeline_store.record_timeline_event(
            monitor_run_id,
            event_time=anchor.isoformat(),
            event_type="recovery_summary",
            label="backfill",
            payload={"summary": runtime_context["recovery_summary"], "data_mode": data_mode},
        )
    return {
        "monitor_run_id": monitor_run_id,
        "run_type": run_type,
        "backfill_required": backfill_required,
        "last_successful_run_at": last_successful_run_at,
        "evidence_packet": packet,
        "analysis": analysis.to_dict(),
        "notification": {
            "should_notify": decision.should_notify,
            "notification_level": decision.notification_level,
            "reason": decision.reason,
            "telegram": telegram_result,
        },
        "state_transition": {
            "is_new_state": decision.is_new_state,
            "is_continuation": decision.is_continuation,
            "previous_state_invalidated": decision.previous_state_invalidated,
            "state_change_reason": decision.state_change_reason,
            "confidence_changed": decision.confidence_changed,
            "confidence_delta": decision.confidence_delta,
            "invalidation_triggered_by": decision.invalidation_triggered_by,
            "next_state": asdict(decision.next_state),
        },
    }


def run_monitor_loop(
    config: MarketAgentConfig,
    interval_seconds: int,
    max_iterations: int | None = None,
    anchor_times: list[datetime] | None = None,
    state_path: Path | None = None,
    alerts_path: Path | None = None,
    cooldown_minutes: int | None = None,
    timeline_store_path: Path | None = None,
    provider_router: ProviderRouter | None = None,
) -> list[dict[str, Any]]:
    outcomes: list[dict[str, Any]] = []
    iteration = 0
    while max_iterations is None or iteration < max_iterations:
        anchor = None
        if anchor_times is not None:
            if iteration >= len(anchor_times):
                break
            anchor = anchor_times[iteration]
        outcomes.append(
            run_monitored_live_once(
                config=config,
                anchor_time=anchor,
                state_path=state_path,
                alerts_path=alerts_path,
                cooldown_minutes=cooldown_minutes,
                timeline_store_path=timeline_store_path,
                provider_router=provider_router,
            )
        )
        iteration += 1
        if max_iterations is not None and iteration >= max_iterations:
            break
        if interval_seconds > 0:
            time.sleep(interval_seconds)
    return outcomes
