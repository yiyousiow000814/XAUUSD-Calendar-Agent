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
from .models import CrossAssetSnapshot, Headline, MarketMove, ProviderHealth, ScenarioFixture
from .notification_policy import decide_notification
from .notifier import FileNotificationSink, TelegramNotificationSink
from .provider_health import build_fixture_provider_health, build_provider_health, health_to_dict
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


def _unavailable_market_fixture(anchor_time: datetime) -> ScenarioFixture:
    return ScenarioFixture(
        scenario_id="live_market_unavailable",
        as_of_myt=anchor_time.strftime("%d-%m-%Y %H:%M"),
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


def _load_related_assets(
    path: Path | None,
    assets_dir: Path | None,
    anchor_time: datetime,
    window_minutes: int,
) -> tuple[dict[str, float], dict[str, ProviderHealth], list[dict[str, Any]]]:
    snapshot = (
        load_related_assets_timeseries_snapshot(assets_dir, anchor_time, window_minutes)
        if assets_dir is not None and assets_dir.exists()
        else load_related_assets_snapshot(path)
    )
    values = {
        "dxy_percent": snapshot.dxy_percent,
        "us10y_bps": snapshot.us10y_bps,
        "us2y_bps": snapshot.us2y_bps,
        "wti_percent": snapshot.wti_percent,
        "brent_percent": snapshot.brent_percent,
        "vix_percent": snapshot.vix_percent,
        "spx_percent": snapshot.spx_percent,
        "nasdaq_percent": snapshot.nasdaq_percent,
    }
    source_type = "local_csv_fallback" if assets_dir is not None and assets_dir.exists() else "json_cache"
    provider_health = {
        "dxy": build_provider_health(
            source="DXY",
            source_type=source_type,
            data_mode="live_seen" if (assets_dir is not None and assets_dir.exists()) or (path is not None and path.exists()) else "unavailable",
            is_available=((assets_dir is not None and assets_dir.exists()) or (path is not None and path.exists())),
            current_value=snapshot.dxy_percent,
            change_value=snapshot.dxy_percent,
            change_unit="percent",
        ),
        "us10y": build_provider_health(
            source="US10Y",
            source_type=source_type,
            data_mode="live_seen" if ((assets_dir is not None and assets_dir.exists()) or (path is not None and path.exists())) else "unavailable",
            is_available=((assets_dir is not None and assets_dir.exists()) or (path is not None and path.exists())),
            current_value=snapshot.us10y_bps,
            change_value=snapshot.us10y_bps,
            change_unit="bps",
        ),
        "us2y": build_provider_health(
            source="US2Y",
            source_type=source_type,
            data_mode="live_seen" if ((assets_dir is not None and assets_dir.exists()) or (path is not None and path.exists())) else "unavailable",
            is_available=((assets_dir is not None and assets_dir.exists()) or (path is not None and path.exists())),
            current_value=snapshot.us2y_bps,
            change_value=snapshot.us2y_bps,
            change_unit="bps",
        ),
        "wti": build_provider_health(
            source="WTI",
            source_type=source_type,
            data_mode="live_seen" if ((assets_dir is not None and assets_dir.exists()) or (path is not None and path.exists())) else "unavailable",
            is_available=((assets_dir is not None and assets_dir.exists()) or (path is not None and path.exists())),
            current_value=snapshot.wti_percent,
            change_value=snapshot.wti_percent,
            change_unit="percent",
        ),
        "brent": build_provider_health(
            source="Brent",
            source_type=source_type,
            data_mode="live_seen" if ((assets_dir is not None and assets_dir.exists()) or (path is not None and path.exists())) else "unavailable",
            is_available=((assets_dir is not None and assets_dir.exists()) or (path is not None and path.exists())),
            current_value=snapshot.brent_percent,
            change_value=snapshot.brent_percent,
            change_unit="percent",
        ),
        "vix": build_provider_health(
            source="VIX",
            source_type=source_type,
            data_mode="live_seen" if ((assets_dir is not None and assets_dir.exists()) or (path is not None and path.exists())) else "unavailable",
            is_available=((assets_dir is not None and assets_dir.exists()) or (path is not None and path.exists())),
            current_value=snapshot.vix_percent,
            change_value=snapshot.vix_percent,
            change_unit="percent",
        ),
        "spx": build_provider_health(
            source="SPX",
            source_type=source_type,
            data_mode="live_seen" if ((assets_dir is not None and assets_dir.exists()) or (path is not None and path.exists())) else "unavailable",
            is_available=((assets_dir is not None and assets_dir.exists()) or (path is not None and path.exists())),
            current_value=snapshot.spx_percent,
            change_value=snapshot.spx_percent,
            change_unit="percent",
        ),
        "nasdaq": build_provider_health(
            source="Nasdaq",
            source_type=source_type,
            data_mode="live_seen" if ((assets_dir is not None and assets_dir.exists()) or (path is not None and path.exists())) else "unavailable",
            is_available=((assets_dir is not None and assets_dir.exists()) or (path is not None and path.exists())),
            current_value=snapshot.nasdaq_percent,
            change_value=snapshot.nasdaq_percent,
            change_unit="percent",
        ),
    }
    related_rows = [
        {
            "symbol": symbol.upper(),
            "data_timestamp": anchor_time.isoformat(),
            "change_value": value.change_value or 0.0,
            "change_unit": value.change_unit,
            "data_mode": value.data_mode,
            "source_type": value.source_type,
        }
        for symbol, value in provider_health.items()
    ]
    return values, provider_health, related_rows


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


def _load_market_context(
    config: MarketAgentConfig,
    anchor_time: datetime,
) -> tuple[ScenarioFixture, ProviderHealth, list[dict[str, Any]]]:
    try:
        fixture = load_recent_market_snapshot(config.price_data_path, anchor_time)
        price_bar = {
            "symbol": fixture.market.symbol,
            "data_timestamp": anchor_time.isoformat(),
            "open_price": fixture.market.from_price,
            "high_price": fixture.market.to_price,
            "low_price": fixture.market.to_price,
            "close_price": fixture.market.to_price,
            "move_percent": fixture.market.move_percent,
            "data_mode": "live_seen",
            "source_type": "local_csv_fallback",
        }
        health = build_provider_health(
            source="XAUUSD",
            source_type="local_csv_fallback",
            data_mode="live_seen",
            is_available=True,
            current_value=fixture.market.to_price,
            previous_value=fixture.market.from_price,
            change_value=fixture.market.move_percent,
            change_unit="percent",
            data_timestamp=anchor_time.isoformat(),
        )
        return fixture, health, [price_bar]
    except Exception as exc:
        fixture = _unavailable_market_fixture(anchor_time)
        health = build_provider_health(
            source="XAUUSD",
            source_type="provider_interface",
            data_mode="unavailable",
            is_available=False,
            error=str(exc),
            stale_reason="No live provider configured and CSV fallback unavailable.",
            data_timestamp=anchor_time.isoformat(),
        )
        return fixture, health, []


def _headlines_to_rows(
    items: tuple[Headline, ...],
    *,
    first_seen_at: str,
    data_mode: str,
) -> list[dict[str, Any]]:
    return [
        {
            "published_at": f"{item.timestamp_myt}:00+08:00".replace(" ", "T"),
            "first_seen_at": first_seen_at,
            "backfilled_at": first_seen_at if data_mode == "backfilled" else None,
            "is_backfilled": data_mode == "backfilled",
            "source": item.source,
            "title": item.title,
            "link": "",
            "relevance_reason": item.relevance_reason,
            "impact_direction_on_gold": item.impact_direction_on_gold,
            "data_mode": data_mode,
        }
        for item in items
    ]


def _calendar_to_rows(
    items: tuple[Headline, ...],
    *,
    data_mode: str,
) -> list[dict[str, Any]]:
    return [
        {
            "scheduled_at": f"{item.timestamp_myt}:00+08:00".replace(" ", "T"),
            "source": item.source,
            "title": item.title,
            "relevance_reason": item.relevance_reason,
            "impact_direction_on_gold": item.impact_direction_on_gold,
            "data_mode": data_mode,
        }
        for item in items
    ]


def _build_runtime_context(
    config: MarketAgentConfig,
    anchor_time: datetime,
    news_headlines: list[dict[str, Any]] | None = None,
    *,
    data_mode: str = "live_seen",
) -> dict[str, Any]:
    base_fixture, xau_health, market_rows = _load_market_context(config, anchor_time)
    related_assets, related_health, related_rows = _load_related_assets(
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
    news = filter_news_in_window(
        headlines=raw_headlines,
        move_start=anchor_time,
        move_end=anchor_time,
        lookback_minutes=config.news_lookback_minutes,
        forward_minutes=config.post_move_news_minutes,
    )
    fixture = ScenarioFixture(
        scenario_id="live_once",
        as_of_myt=anchor_time.strftime("%d-%m-%Y %H:%M"),
        market=base_fixture.market,
        cross_asset=_merge_cross_asset(base_fixture.cross_asset, related_assets),
        calendar_events=tuple(calendar_events),
        news=tuple(news),
        expected_llm_claim=None,
    )
    provider_health = {
        "xauusd": xau_health,
        **related_health,
        "news": build_provider_health(
            source="News",
            source_type="rss_provider_interface" if config.rss_feeds else "provider_interface",
            data_mode=data_mode if news else "unavailable",
            is_available=bool(news),
            current_value=float(len(news)),
            data_timestamp=anchor_time.isoformat(),
        ),
        "calendar": build_provider_health(
            source="Economic Calendar",
            source_type="calendar_provider_interface",
            data_mode=data_mode if calendar_events else "unavailable",
            is_available=bool(calendar_events),
            current_value=float(len(calendar_events)),
            data_timestamp=anchor_time.isoformat(),
        ),
    }
    return {
        "fixture": fixture,
        "provider_health": provider_health,
        "market_price_bars": [
            {**row, "data_mode": data_mode} for row in market_rows
        ],
        "related_asset_bars": [
            {**row, "data_mode": data_mode} for row in related_rows
        ],
        "news_rows": _headlines_to_rows(tuple(news), first_seen_at=anchor_time.isoformat(), data_mode=data_mode),
        "calendar_rows": _calendar_to_rows(tuple(calendar_events), data_mode=data_mode),
    }


def _run_recovery_backfill(
    config: MarketAgentConfig,
    *,
    previous_run_at: str,
    anchor_time: datetime,
    news_headlines: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    context = _build_runtime_context(
        config,
        anchor_time=anchor_time,
        news_headlines=news_headlines,
        data_mode="backfilled",
    )
    context["recovery_summary"] = (
        f"Recovered market context from {previous_run_at} to {anchor_time.isoformat()} using current provider interfaces."
    )
    return context


def build_live_fixture(
    config: MarketAgentConfig,
    anchor_time: datetime,
    news_headlines: list[dict[str, Any]] | None = None,
) -> ScenarioFixture:
    return _build_runtime_context(config, anchor_time=anchor_time, news_headlines=news_headlines)["fixture"]


def build_live_evidence_packet(
    config: MarketAgentConfig,
    anchor_time: datetime,
    news_headlines: list[dict[str, Any]] | None = None,
    previous_state=None,
    data_mode: str = "live_seen",
) -> dict[str, Any]:
    context = _build_runtime_context(config, anchor_time=anchor_time, news_headlines=news_headlines, data_mode=data_mode)
    fixture = context["fixture"]
    provider_health = context["provider_health"]
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
    context = _build_runtime_context(config, anchor_time=anchor, news_headlines=news_headlines, data_mode=data_mode)
    fixture = context["fixture"]
    provider_health = context["provider_health"]
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
            news_headlines=news_headlines,
        )
        if backfill_required
        else _build_runtime_context(config, anchor_time=anchor, news_headlines=news_headlines, data_mode=data_mode)
    )
    fixture = runtime_context["fixture"]
    provider_health = runtime_context["provider_health"]
    attention_snapshot = DriverAttentionManager().evaluate(
        fixture=fixture,
        provider_health=provider_health,
        evidence_status=build_evidence_gate_result(fixture, provider_health=provider_health).evidence_status,
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
    packet = {
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
        "previous_state": asdict(previous_state),
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
        "allowed_candidate_drivers": build_evidence_gate_result(
            fixture,
            provider_health=provider_health,
            attention_snapshot=attention_snapshot,
        ).allowed_candidate_drivers,
        "blocked_drivers": build_evidence_gate_result(
            fixture,
            provider_health=provider_health,
            attention_snapshot=attention_snapshot,
        ).blocked_drivers,
        "cross_asset_confirmation": build_evidence_gate_result(
            fixture,
            provider_health=provider_health,
            attention_snapshot=attention_snapshot,
        ).cross_asset_confirmation,
        "evidence_status": build_evidence_gate_result(
            fixture,
            provider_health=provider_health,
            attention_snapshot=attention_snapshot,
        ).evidence_status,
    }
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
    timeline_store.record_driver_attention_states(monitor_run_id, {key: asdict(value) for key, value in attention_snapshot.states.items()})
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
    if backfill_required:
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
