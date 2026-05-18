from __future__ import annotations

from dataclasses import asdict
from datetime import datetime
import time
from pathlib import Path
from typing import Any

from .config import MarketAgentConfig
from .driver_attention import DriverAttentionManager
from .evidence import build_evidence_gate_result
from .llm_client import LocalLLMClient
from .notification_policy import decide_notification
from .notifier import FileNotificationSink, TelegramNotificationSink
from .models import CrossAssetSnapshot, ScenarioFixture
from .provider_health import build_fixture_provider_health, health_to_dict
from .pipeline import analyze_fixture_with_optional_llm
from .providers.calendar_events import load_calendar_events_in_window
from .providers.market_prices import load_recent_market_snapshot
from .providers.news_events import filter_news_in_window, load_rss_headlines
from .providers.related_assets import (
    load_related_assets_snapshot,
    load_related_assets_timeseries_snapshot,
)
from .state_store import JsonStateStore
from .timeline_store import TimelineStore


def _load_related_assets(
    path: Path | None,
    assets_dir: Path | None,
    anchor_time: datetime,
    window_minutes: int,
) -> dict[str, float]:
    snapshot = (
        load_related_assets_timeseries_snapshot(assets_dir, anchor_time, window_minutes)
        if assets_dir is not None and assets_dir.exists()
        else load_related_assets_snapshot(path)
    )
    return {
        "dxy_percent": snapshot.dxy_percent,
        "us10y_bps": snapshot.us10y_bps,
        "us2y_bps": snapshot.us2y_bps,
        "wti_percent": snapshot.wti_percent,
        "brent_percent": snapshot.brent_percent,
        "vix_percent": snapshot.vix_percent,
        "spx_percent": snapshot.spx_percent,
        "nasdaq_percent": snapshot.nasdaq_percent,
    }


def _merge_cross_asset(base: CrossAssetSnapshot, overrides: dict[str, float]) -> CrossAssetSnapshot:
    return CrossAssetSnapshot(
        dxy_percent=overrides.get("dxy_percent", base.dxy_percent),
        us10y_bps=overrides.get("us10y_bps", base.us10y_bps),
        us2y_bps=overrides.get("us2y_bps", base.us2y_bps),
        wti_percent=overrides.get("wti_percent", base.wti_percent),
        brent_percent=overrides.get("brent_percent", base.brent_percent),
        vix_percent=overrides.get("vix_percent", base.vix_percent),
        spx_percent=overrides.get("spx_percent", base.spx_percent),
        nasdaq_percent=overrides.get("nasdaq_percent", base.nasdaq_percent),
    )


def build_live_fixture(
    config: MarketAgentConfig,
    anchor_time: datetime,
    news_headlines: list[dict[str, Any]] | None = None,
) -> ScenarioFixture:
    base_fixture = load_recent_market_snapshot(config.price_data_path, anchor_time)
    related_assets = _load_related_assets(
        config.related_assets_path,
        config.related_assets_dir,
        anchor_time,
        config.move_window_minutes,
    )
    calendar_events = load_calendar_events_in_window(
        calendar_dir=config.calendar_dir,
        anchor_time=anchor_time,
        lookback_minutes=config.calendar_lookback_minutes,
        forward_minutes=config.post_move_news_minutes,
    )
    raw_headlines = news_headlines if news_headlines is not None else load_rss_headlines(config.rss_feeds)
    move_end = anchor_time
    move_start = anchor_time
    news = filter_news_in_window(
        headlines=raw_headlines,
        move_start=move_start,
        move_end=move_end,
        lookback_minutes=config.news_lookback_minutes,
        forward_minutes=config.post_move_news_minutes,
    )
    return ScenarioFixture(
        scenario_id="live_once",
        as_of_myt=anchor_time.strftime("%d-%m-%Y %H:%M"),
        market=base_fixture.market,
        cross_asset=_merge_cross_asset(base_fixture.cross_asset, related_assets),
        calendar_events=tuple(calendar_events),
        news=tuple(news),
        expected_llm_claim=None,
    )


def build_live_evidence_packet(
    config: MarketAgentConfig,
    anchor_time: datetime,
    news_headlines: list[dict[str, Any]] | None = None,
    previous_state=None,
    data_mode: str = "live_seen",
) -> dict[str, Any]:
    fixture = build_live_fixture(config, anchor_time=anchor_time, news_headlines=news_headlines)
    provider_health = build_fixture_provider_health(fixture, data_mode=data_mode)
    attention_snapshot = DriverAttentionManager().evaluate(
        fixture=fixture,
        provider_health=provider_health,
        evidence_status=build_evidence_gate_result(fixture, provider_health=provider_health).evidence_status,
        data_mode=data_mode,
    )
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
            {
                "timestamp_myt": item.timestamp_myt,
                "title": item.title,
                "source": item.source,
            }
            for item in fixture.calendar_events
        ],
        "news": [
            {
                "timestamp_myt": item.timestamp_myt,
                "title": item.title,
                "source": item.source,
            }
            for item in fixture.news
        ],
        "allowed_candidate_drivers": evidence.allowed_candidate_drivers,
        "blocked_drivers": evidence.blocked_drivers,
        "cross_asset_confirmation": evidence.cross_asset_confirmation,
        "evidence_status": evidence.evidence_status,
    }


def run_live_once(
    config: MarketAgentConfig,
    anchor_time: datetime | None = None,
    news_headlines: list[dict[str, Any]] | None = None,
    llm_client=None,
    previous_state=None,
    data_mode: str = "live_seen",
) -> tuple[ScenarioFixture, Any]:
    anchor = anchor_time or datetime.now().astimezone()
    fixture = build_live_fixture(config, anchor_time=anchor, news_headlines=news_headlines)
    provider_health = build_fixture_provider_health(fixture, data_mode=data_mode)
    attention_snapshot = DriverAttentionManager().evaluate(
        fixture=fixture,
        provider_health=provider_health,
        evidence_status=build_evidence_gate_result(fixture, provider_health=provider_health).evidence_status,
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
) -> dict[str, Any]:
    anchor = anchor_time or datetime.now().astimezone()
    state_store = JsonStateStore(state_path or config.state_store_path)
    timeline_store = TimelineStore(timeline_store_path or config.timeline_store_path)
    sink = FileNotificationSink(alerts_path or config.alerts_output_path)
    previous_state = state_store.load()
    last_successful_run_at = timeline_store.get_last_successful_run_at()
    backfill_required, run_type = _detect_gap(
        previous_run_at=last_successful_run_at,
        anchor=anchor,
        gap_minutes=config.backfill_gap_minutes,
    )
    data_mode = "backfilled" if backfill_required else "live_seen"
    fixture, analysis = run_live_once(
        config,
        anchor_time=anchor,
        news_headlines=news_headlines,
        llm_client=llm_client,
        previous_state=previous_state,
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
    packet = build_live_evidence_packet(
        config,
        anchor_time=anchor,
        news_headlines=news_headlines,
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
    attention_states = {}
    for entry in packet["active_driver_states"] + packet["dormant_driver_states"]:
        driver_id = entry["driver_id"]
        # rebuild from current evidence packet snapshot for persistence without losing detailed shape
        attention_states[driver_id] = next(
            (
                state
                for state in DriverAttentionManager().evaluate(
                    fixture=fixture,
                    provider_health=build_fixture_provider_health(fixture, data_mode=data_mode),
                    evidence_status=build_evidence_gate_result(
                        fixture,
                        provider_health=build_fixture_provider_health(fixture, data_mode=data_mode),
                    ).evidence_status,
                    data_mode=data_mode,
                ).states.values()
                if state.driver_id == driver_id
            ),
            None,
        )
    timeline_store.record_driver_attention_states(
        monitor_run_id,
        {key: asdict(value) for key, value in attention_states.items() if value is not None},
    )
    timeline_store.record_evidence_packet(monitor_run_id, packet)
    timeline_store.record_analysis_result(
        monitor_run_id,
        analysis.to_dict(),
        rejected_driver=getattr(analysis, "rejected_driver", None),
        rejection_reason=getattr(analysis, "rejection_reason", None),
    )
    timeline_store.record_alert(monitor_run_id, {
        "should_notify": decision.should_notify,
        "notification_level": decision.notification_level,
        "reason": decision.reason,
    })
    timeline_store.record_state_transition(monitor_run_id, {
        "is_new_state": decision.is_new_state,
        "is_continuation": decision.is_continuation,
        "previous_state_invalidated": decision.previous_state_invalidated,
        "state_change_reason": decision.state_change_reason,
        "confidence_changed": decision.confidence_changed,
        "confidence_delta": decision.confidence_delta,
        "invalidation_triggered_by": decision.invalidation_triggered_by,
        "next_state": asdict(decision.next_state),
    })
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
            )
        )
        iteration += 1
        if max_iterations is not None and iteration >= max_iterations:
            break
        if interval_seconds > 0:
            time.sleep(interval_seconds)
    return outcomes
