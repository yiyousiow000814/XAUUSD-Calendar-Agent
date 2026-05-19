from __future__ import annotations

from dataclasses import asdict
from datetime import datetime
import time
from pathlib import Path
from typing import Any

from .backfill import BackfillManager
from .config import MarketAgentConfig
from .driver_attention import DriverAttentionManager
from .evidence import build_evidence_gate_result
from .llm_client import LocalLLMClient
from .models import CrossAssetSnapshot, Headline, MarketMove, ProviderHealth, ScenarioFixture
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
    return ScenarioFixture(
        scenario_id=scenario_id,
        as_of_myt=anchor_time.astimezone().strftime("%d-%m-%Y %H:%M"),
        market=market,
        cross_asset=_cross_asset_from_rows(related_asset_bars),
        calendar_events=tuple(_headline_from_calendar(item) for item in calendar_rows),
        news=tuple(_headline_from_news(item) for item in news_rows),
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


def _build_packet(
    fixture: ScenarioFixture,
    *,
    provider_health: dict[str, ProviderHealth],
    attention_snapshot: Any,
    previous_state: Any,
    data_mode: str,
) -> dict[str, Any]:
    evidence = build_evidence_gate_result(
        fixture,
        provider_health=provider_health,
        attention_snapshot=attention_snapshot,
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
        },
        "provider_health": health_to_dict(provider_health),
        "active_driver_states": attention_snapshot.active_driver_states,
        "dormant_driver_states": attention_snapshot.dormant_driver_states,
        "driver_attention_summary": attention_snapshot.driver_attention_summary,
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
        data_mode=data_mode,
    )
    return _build_packet(
        fixture,
        provider_health=provider_health,
        attention_snapshot=attention_snapshot,
        previous_state=previous_state,
        data_mode=data_mode,
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
        data_mode=data_mode,
    )
    result = analyze_fixture_with_optional_llm(
        fixture,
        llm_client=llm_client or LocalLLMClient(),
        previous_state=previous_state,
        provider_health=provider_health,
        attention_snapshot=attention_snapshot,
        data_mode=data_mode,
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
    data_mode = "backfilled" if backfill_required else "live_seen"
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
    decision = decide_notification(
        previous_state=previous_state,
        analysis_result=analysis,
        now_iso=anchor.isoformat(),
        cooldown_minutes=cooldown_minutes or config.notification_cooldown_minutes,
    )
    if decision.should_notify:
        message = analysis.user_message
        sink.emit(
            {
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
        )
        if config.telegram_enabled:
            TelegramNotificationSink(
                bot_token=config.telegram_bot_token,
                chat_id=config.telegram_chat_id,
                timeout_seconds=config.telegram_timeout_seconds,
            ).emit({"message": message})
    state_store.save(decision.next_state)
    packet = _build_packet(
        fixture,
        provider_health=provider_health,
        attention_snapshot=attention_snapshot,
        previous_state=previous_state,
        data_mode=data_mode,
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
            "run_type": run_type,
            "data_mode": data_mode,
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
