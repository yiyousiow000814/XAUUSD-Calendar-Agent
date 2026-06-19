from src.xauusd_market_agent.timeline_store import (
    DAY_REPLAY_ALERT_ROWS,
    DAY_REPLAY_DRIVER_ROWS,
    DAY_REPLAY_RELATED_ROWS_PER_SYMBOL,
    DAY_REPLAY_STATE_ROWS,
    DAY_REPLAY_TIMELINE_ROWS,
    TimelineStore,
)
import json


def test_replay_queries_return_combined_timeline(tmp_path) -> None:
    store = TimelineStore(tmp_path / "timeline.sqlite")
    run_id = store.record_monitor_run(
        run_started_at="2026-05-19T07:15:00+08:00",
        run_type="live",
        data_mode="live_seen",
        backfill_required=False,
        last_successful_run_at=None,
        no_news_found=False,
        alert_suppressed_reason="Suppressed duplicate alert.",
    )
    store.record_market_price_bars(
        run_id,
        [
            {"symbol": "XAUUSD", "data_timestamp": "2026-05-19T07:15:00+08:00", "open_price": 4500.0, "high_price": 4502.0, "low_price": 4490.0, "close_price": 4492.0, "source": "stub", "source_type": "spot", "data_mode": "live_seen", "is_stale": False, "stale_reason": ""},
        ],
    )
    store.record_related_asset_bars(
        run_id,
        [
            {"symbol": "dxy", "data_timestamp": "2026-05-19T07:15:00+08:00", "value": 104.2, "change_15m": 0.2, "change_30m": 0.2, "change_60m": 0.3, "change_value": 0.2, "change_unit": "percent", "source": "stub", "source_type": "proxy", "data_mode": "live_seen", "is_stale": False, "stale_reason": ""},
        ],
    )
    store.record_news_items(
        run_id,
        [
            {"published_at": "2026-05-19T07:10:00+08:00", "first_seen_at": "2026-05-19T07:15:00+08:00", "backfilled_at": None, "is_backfilled": False, "source": "Reuters", "title": "Fed headline", "link": "", "relevance_reason": "relevant", "impact_direction_on_gold": "bearish", "data_mode": "live_seen", "included": True, "filter_reason": "", "source_quality_score": 0.92, "matched_keywords": ["fed"], "categories": ["rss"]},
        ],
    )
    store.record_calendar_events(
        run_id,
        [
            {"scheduled_at": "2026-05-19T07:00:00+08:00", "source": "ForexFactory", "title": "CPI", "relevance_reason": "high impact", "impact_direction_on_gold": "unknown", "data_mode": "live_seen"},
        ],
    )
    store.record_alert(run_id, {"should_notify": False, "notification_level": "none", "reason": "cooldown"})
    store.record_alert(
        run_id,
        {
            "should_notify": True,
            "notification_level": "attention",
            "reason": "Fresh move confirmed.",
            "message": "XAUUSD down move confirmed by yields.",
        },
    )
    store.record_driver_attention_states(
        run_id,
        {
            "yields": {
                "driver_id": "yields",
                "label": "US Yields",
                "category": "macro",
                "current_state": "active",
                "priority": "core_structural",
                "relevance_score": 0.95,
                "activation_reason": "Fresh yield move confirms the XAUUSD move.",
                "deactivation_reason": "",
                "first_activated_at": "2026-05-19T07:15:00+08:00",
                "last_confirmed_at": "2026-05-19T07:15:00+08:00",
                "last_evidence_at": "2026-05-19T07:15:00+08:00",
                "decay_deadline": "2026-05-19T08:45:00+08:00",
                "linked_assets": ["us10y", "us2y"],
                "required_evidence_gates": ["us10y", "us2y"],
                "optional_evidence_gates": [],
                "current_evidence_summary": "US10Y confirms.",
                "current_counter_evidence": "",
                "confidence": "high",
                "source_count": 1,
                "related_news_count": 0,
                "related_calendar_events": 0,
                "notes": "",
                "data_mode": "live_seen",
            }
        },
    )
    store.record_timeline_event(
        run_id,
        event_time="2026-05-19T07:15:00+08:00",
        event_type="analysis",
        label="yields",
        payload={"data_mode": "live_seen"},
    )
    store.record_timeline_event(
        run_id,
        event_time="2026-05-19T07:16:00+08:00",
        event_type="market_alert",
        label="Yields pressure",
        payload={
            "semantic_type": "breakout",
            "impact_percent": -0.48,
            "main_driver": "yields",
            "summary": "US yields confirmed the XAUUSD down move.",
        },
    )

    replay = store.get_market_replay("2026-05-19T07:00:00+08:00", "2026-05-19T07:20:00+08:00")

    assert store.get_price_series("XAUUSD", "2026-05-19T07:00:00+08:00", "2026-05-19T07:20:00+08:00")
    assert store.get_related_asset_series("dxy", "2026-05-19T07:00:00+08:00", "2026-05-19T07:20:00+08:00")
    assert store.get_news_items("2026-05-19T07:00:00+08:00", "2026-05-19T07:20:00+08:00")
    assert replay["price_series"]
    assert replay["related_assets"]["dxy"]
    assert replay["news_items"]
    assert replay["calendar_events"]
    assert replay["driver_attention_timeline"]
    assert replay["timeline_events"]
    assert len(replay["month_summary_events"]) == 1
    assert replay["month_summary_events"][0]["label"] == "Yields pressure"
    assert replay["alerts"]
    assert replay["alerts"][0]["message"] == "XAUUSD down move confirmed by yields."
    assert replay["suppressed_alerts"]
    assert replay["suppressed_alerts"][0]["reason"] == "cooldown"


def test_replay_recovers_legacy_suppressed_reason_without_alert_row(tmp_path) -> None:
    store = TimelineStore(tmp_path / "timeline.sqlite")
    run_id = store.record_monitor_run(
        run_started_at="2026-05-19T07:15:00+08:00",
        run_type="live",
        data_mode="live_seen",
        backfill_required=False,
        last_successful_run_at=None,
        no_news_found=False,
        alert_suppressed_reason="Analysis result does not require notification.",
    )
    store.record_analysis_result(
        run_id,
        {
            "main_driver": "unknown",
            "cause_status": "unconfirmed",
            "confidence": "low",
            "should_notify": False,
        },
    )

    replay = store.get_market_replay("2026-05-19T07:00:00+08:00", "2026-05-19T07:20:00+08:00")

    assert replay["alerts"] == []
    assert len(replay["suppressed_alerts"]) == 1
    suppressed = replay["suppressed_alerts"][0]
    assert suppressed["monitor_run_id"] == run_id
    assert suppressed["run_started_at"] == "2026-05-19T07:15:00+08:00"
    assert suppressed["should_notify"] is False
    assert suppressed["notification_level"] == "none"
    assert suppressed["reason"] == "Analysis result does not require notification."
    assert suppressed["legacy_source"] == "monitor_runs.alert_suppressed_reason"


def test_replay_time_series_are_deduped_by_symbol_and_timestamp(tmp_path) -> None:
    store = TimelineStore(tmp_path / "timeline.sqlite")
    first_run_id = store.record_monitor_run(
        run_started_at="2026-05-19T07:15:00+08:00",
        run_type="live",
        data_mode="live_seen",
        backfill_required=False,
        last_successful_run_at=None,
        no_news_found=False,
        alert_suppressed_reason="",
    )
    second_run_id = store.record_monitor_run(
        run_started_at="2026-05-19T07:16:00+08:00",
        run_type="live",
        data_mode="live_seen",
        backfill_required=False,
        last_successful_run_at="2026-05-19T07:15:00+08:00",
        no_news_found=False,
        alert_suppressed_reason="",
    )
    repeated_price_time = "2026-05-19T07:15:00+08:00"
    repeated_related_time = "2026-05-19T07:14:00+08:00"
    store.record_market_price_bars(
        first_run_id,
        [
            {"symbol": "XAUUSD", "data_timestamp": repeated_price_time, "open_price": 4500.0, "close_price": 4501.0, "source": "first", "source_type": "spot", "data_mode": "live_seen"},
        ],
    )
    store.record_market_price_bars(
        second_run_id,
        [
            {"symbol": "XAUUSD", "data_timestamp": repeated_price_time, "open_price": 4500.0, "close_price": 4502.0, "source": "second", "source_type": "spot", "data_mode": "live_seen"},
        ],
    )
    store.record_related_asset_bars(
        first_run_id,
        [
            {"symbol": "dxy", "data_timestamp": repeated_related_time, "value": 104.1, "change_15m": 0.1, "change_30m": 0.1, "change_60m": 0.1, "change_value": 0.1, "change_unit": "percent", "source": "first", "source_type": "proxy", "data_mode": "live_seen"},
        ],
    )
    store.record_related_asset_bars(
        second_run_id,
        [
            {"symbol": "dxy", "data_timestamp": repeated_related_time, "value": 104.3, "change_15m": 0.3, "change_30m": 0.3, "change_60m": 0.3, "change_value": 0.3, "change_unit": "percent", "source": "second", "source_type": "proxy", "data_mode": "live_seen"},
        ],
    )

    replay = store.get_market_replay("2026-05-19T07:00:00+08:00", "2026-05-19T07:20:00+08:00")

    assert len(replay["price_series"]) == 1
    assert replay["price_series"][0]["close_price"] == 4502.0
    assert replay["price_series"][0]["source"] == "second"
    assert len(replay["related_assets"]["dxy"]) == 1
    assert replay["related_assets"]["dxy"][0]["value"] == 104.3
    assert replay["related_assets"]["dxy"][0]["source"] == "second"


def test_replay_carries_forward_last_price_anchor_when_day_window_has_no_price(tmp_path) -> None:
    store = TimelineStore(tmp_path / "timeline.sqlite")
    prior_run_id = store.record_monitor_run(
        run_started_at="2026-06-12T23:55:00+08:00",
        run_type="live",
        data_mode="market_closed",
        backfill_required=False,
        last_successful_run_at=None,
        no_news_found=False,
        alert_suppressed_reason="",
    )
    current_run_id = store.record_monitor_run(
        run_started_at="2026-06-14T10:00:00+08:00",
        run_type="live",
        data_mode="market_closed",
        backfill_required=False,
        last_successful_run_at="2026-06-12T23:55:00+08:00",
        no_news_found=False,
        alert_suppressed_reason="",
    )
    store.record_market_price_bars(
        prior_run_id,
        [
            {
                "symbol": "XAUUSD",
                "data_timestamp": "2026-06-12T23:55:00+08:00",
                "close_price": 4310.5,
                "source": "cTrader",
                "source_type": "spot",
                "data_mode": "market_closed",
            }
        ],
    )
    store.record_news_items(
        current_run_id,
        [
            {
                "published_at": "2026-06-14T08:42:22+00:00",
                "first_seen_at": "2026-06-14T10:00:00+08:00",
                "backfilled_at": None,
                "is_backfilled": False,
                "source": "CNBC",
                "title": "Oil headline stays active while gold market is closed",
                "link": "",
                "relevance_reason": "Market context while XAUUSD is closed.",
                "impact_direction_on_gold": "unknown",
                "data_mode": "live_seen",
                "included": True,
            }
        ],
    )

    strict_series = store.get_price_series(
        "XAUUSD",
        "2026-06-14T00:00:00+08:00",
        "2026-06-14T23:59:59+08:00",
    )
    replay = store.get_market_replay(
        "2026-06-14T00:00:00+08:00",
        "2026-06-14T23:59:59+08:00",
    )

    assert strict_series == []
    assert replay["news_items"]
    assert len(replay["price_series"]) == 1
    assert replay["price_series"][0]["close_price"] == 4310.5
    assert replay["price_series"][0]["replay_context_anchor"] is True
    assert replay["price_series"][0]["context_anchor_reason"] == "latest_price_before_replay_window"


def test_replay_repairs_legacy_replacement_characters_in_news_display_text(tmp_path) -> None:
    store = TimelineStore(tmp_path / "timeline.sqlite")
    run_id = store.record_monitor_run(
        run_started_at="2026-06-14T10:00:00+08:00",
        run_type="live",
        data_mode="live_seen",
        backfill_required=False,
        last_successful_run_at=None,
        no_news_found=False,
        alert_suppressed_reason="",
    )
    store.record_news_items(
        run_id,
        [
            {
                "published_at": "2026-06-14T08:42:22+00:00",
                "first_seen_at": "2026-06-14T10:00:00+08:00",
                "backfilled_at": None,
                "is_backfilled": False,
                "source": "MarketWatch",
                "title": "Gold isn�t the hedge we�re told it is � yet",
                "preview": "Markets don�t always follow the old story � traders adapt.",
                "link": "https://example.test/gold",
                "relevance_reason": "Gold headline.",
                "impact_direction_on_gold": "unknown",
                "data_mode": "live_seen",
                "included": True,
            }
        ],
    )

    replay = store.get_market_replay(
        "2026-06-14T00:00:00+08:00",
        "2026-06-14T23:59:59+08:00",
    )

    assert replay["news_items"][0]["title"] == "Gold isn't the hedge we're told it is - yet"
    assert replay["news_items"][0]["preview"] == "Markets don't always follow the old story - traders adapt."


def test_day_replay_budgets_high_volume_status_sections(tmp_path) -> None:
    store = TimelineStore(tmp_path / "timeline.sqlite")
    row_count = DAY_REPLAY_RELATED_ROWS_PER_SYMBOL + 40
    for index in range(row_count):
        minute = index % 60
        hour = 7 + index // 60
        timestamp = f"2026-05-19T{hour:02}:{minute:02}:00+08:00"
        run_id = store.record_monitor_run(
            run_started_at=timestamp,
            run_type="live",
            data_mode="live_seen",
            backfill_required=False,
            last_successful_run_at=None,
            no_news_found=False,
            alert_suppressed_reason="",
        )
        store.record_driver_attention_states(
            run_id,
            {
                f"driver-{index}": {
                    "driver_id": f"driver-{index}",
                    "label": f"Driver {index}",
                    "current_state": "active",
                    "priority": "temporary_event",
                    "relevance_score": 0.5,
                    "confidence": "low",
                    "activation_reason": "Fresh replay context.",
                    "deactivation_reason": "",
                    "first_activated_at": timestamp,
                    "last_confirmed_at": timestamp,
                    "decay_deadline": timestamp,
                    "current_evidence_summary": "Replay context.",
                    "current_counter_evidence": "",
                    "data_mode": "live_seen",
                }
            },
        )
        store.record_state_transition(run_id, {"state_change_reason": f"transition {index}"})
        store.record_alert(
            run_id,
            {
                "should_notify": False,
                "notification_level": "none",
                "reason": f"quiet {index}",
            },
        )
        store.record_timeline_event(
            run_id,
            event_time=timestamp,
            event_type="market_alert",
            label=f"Marker {index}",
            payload={
                "semantic_type": "breakout",
                "impact_percent": -0.2,
                "main_driver": "yields",
                "summary": f"Marker {index}",
            },
        )
        store.record_related_asset_bars(
            run_id,
            [
                {
                    "symbol": "dxy",
                    "data_timestamp": timestamp,
                    "value": 100 + index,
                    "change_15m": 0.1,
                    "change_30m": 0.1,
                    "change_60m": 0.1,
                    "change_value": 0.1,
                    "change_unit": "percent",
                    "source": "test",
                    "source_type": "proxy",
                    "data_mode": "live_seen",
                }
            ],
        )

    replay = store.get_market_replay(
        "2026-05-19T00:00:00+08:00",
        "2026-05-19T23:59:59+08:00",
    )

    assert len(replay["driver_attention_timeline"]) == DAY_REPLAY_DRIVER_ROWS
    assert replay["driver_attention_timeline"][0]["driver_id"] == f"driver-{row_count - DAY_REPLAY_DRIVER_ROWS}"
    assert len(replay["state_transitions"]) == DAY_REPLAY_STATE_ROWS
    assert replay["state_transitions"][0]["state_change_reason"] == f"transition {row_count - DAY_REPLAY_STATE_ROWS}"
    assert len(replay["suppressed_alerts"]) == DAY_REPLAY_ALERT_ROWS
    assert replay["suppressed_alerts"][0]["reason"] == f"quiet {row_count - DAY_REPLAY_ALERT_ROWS}"
    assert len(replay["timeline_events"]) == min(row_count, DAY_REPLAY_TIMELINE_ROWS)
    assert len(replay["related_assets"]["dxy"]) == DAY_REPLAY_RELATED_ROWS_PER_SYMBOL


def test_replay_dedupes_repeated_context_reviews_and_driver_snapshots(tmp_path) -> None:
    store = TimelineStore(tmp_path / "timeline.sqlite")
    first_run_id = store.record_monitor_run(
        run_started_at="2026-05-19T07:15:00+08:00",
        run_type="live",
        data_mode="stale",
        backfill_required=False,
        last_successful_run_at=None,
        no_news_found=False,
        alert_suppressed_reason="",
    )
    second_run_id = store.record_monitor_run(
        run_started_at="2026-05-19T07:16:00+08:00",
        run_type="live",
        data_mode="stale",
        backfill_required=False,
        last_successful_run_at="2026-05-19T07:15:00+08:00",
        no_news_found=False,
        alert_suppressed_reason="",
    )
    context_payload = {
        "semantic_type": "context_review",
        "trade_conclusion": False,
        "data_mode": "stale",
        "summary": "Market closed; news watch continues.",
        "news_count": 2,
        "calendar_count": 1,
        "latest_news": ["Iran headline"],
        "latest_calendar": ["CPI"],
        "missing_required": ["live_xauusd_spot"],
        "usable_inputs": ["news_context"],
        "context_only_inputs": ["market_closed_last_xauusd_spot"],
        "analysis": {"cause_status": "unconfirmed", "main_driver": "unknown", "confidence": "low", "analysis_engine": "llm_validated"},
    }
    store.record_timeline_event(
        first_run_id,
        event_time="2026-05-19T07:15:00+08:00",
        event_type="context_review",
        label="market_context",
        payload={**context_payload, "analysis": {**context_payload["analysis"], "timeline": [{"time_myt": "07:15"}]}},
    )
    store.record_timeline_event(
        second_run_id,
        event_time="2026-05-19T07:16:00+08:00",
        event_type="context_review",
        label="market_context",
        payload={**context_payload, "analysis": {**context_payload["analysis"], "timeline": [{"time_myt": "07:16"}]}},
    )
    driver_snapshot = {
        "driver_id": "geopolitics",
        "label": "Geopolitics",
        "category": "event",
        "current_state": "active",
        "priority": "temporary_event",
        "relevance_score": 0.78,
        "activation_reason": "Timestamped geopolitical headline has market confirmation.",
        "deactivation_reason": "",
        "first_activated_at": "2026-05-19T07:00:00+08:00",
        "last_confirmed_at": "2026-05-19T07:15:00+08:00",
        "last_evidence_at": "2026-05-19T07:15:00+08:00",
        "decay_deadline": "2026-05-19T08:15:00+08:00",
        "linked_assets": ["news"],
        "required_evidence_gates": ["news"],
        "optional_evidence_gates": [],
        "current_evidence_summary": "Geopolitics is actively repriced.",
        "current_counter_evidence": "",
        "confidence": "medium",
        "source_count": 1,
        "related_news_count": 2,
        "related_calendar_events": 0,
        "notes": "",
        "data_mode": "stale",
        "evidence_refs": [{"kind": "news", "title": "Iran headline", "source": "Reuters", "timestamp_myt": "19-05-2026 07:12"}],
    }
    store.record_driver_attention_states(first_run_id, {"geopolitics": driver_snapshot})
    store.record_driver_attention_states(
        second_run_id,
        {
            "geopolitics": {
                **driver_snapshot,
                "last_evidence_at": "2026-05-19T07:16:00+08:00",
                "decay_deadline": "2026-05-19T08:16:00+08:00",
            }
        },
    )

    replay = store.get_market_replay("2026-05-19T07:00:00+08:00", "2026-05-19T07:20:00+08:00")

    assert len(replay["timeline_events"]) == 1
    assert replay["timeline_events"][0]["event_time"] == "2026-05-19T07:15:00+08:00"
    assert len(replay["driver_attention_timeline"]) == 1
    assert replay["driver_attention_timeline"][0]["driver_id"] == "geopolitics"


def test_replay_keeps_filtered_news_out_of_market_markers_without_losing_audit_fields(tmp_path) -> None:
    store = TimelineStore(tmp_path / "timeline.sqlite")
    first_run_id = store.record_monitor_run(
        run_started_at="2026-05-19T07:05:00+08:00",
        run_type="live",
        data_mode="live_seen",
        backfill_required=False,
        last_successful_run_at=None,
        no_news_found=False,
        alert_suppressed_reason="",
    )
    second_run_id = store.record_monitor_run(
        run_started_at="2026-05-19T07:17:00+08:00",
        run_type="live",
        data_mode="live_seen",
        backfill_required=False,
        last_successful_run_at="2026-05-19T07:05:00+08:00",
        no_news_found=False,
        alert_suppressed_reason="",
    )
    base_item = {
        "published_at": "2026-05-19T07:01:00+08:00",
        "backfilled_at": None,
        "is_backfilled": False,
        "source": "Reuters",
        "title": "Fed headline repeats across RSS polls",
        "link": "https://example.com/fed-repeat",
        "relevance_reason": "Fresh macro headline.",
        "impact_direction_on_gold": "bearish_gold",
        "data_mode": "live_seen",
        "included": False,
        "review_status": "filtered",
    }
    store.record_news_items(
        first_run_id,
        [
            {
                **base_item,
                "first_seen_at": "2026-05-19T07:06:00+08:00",
                "filter_reason": "Background until market confirmation.",
            }
        ],
    )
    store.record_news_items(
        second_run_id,
        [
            {
                **base_item,
                "first_seen_at": "2026-05-19T07:18:00+08:00",
                "summary": "Repeated Fed headline kept for replay once.",
                "summary_source": "Local AI",
            }
        ],
    )

    replay = store.get_market_replay("2026-05-19T07:00:00+08:00", "2026-05-19T07:30:00+08:00")
    audit_items = store.get_news_items(
        "2026-05-19T07:00:00+08:00",
        "2026-05-19T07:30:00+08:00",
        include_filtered=True,
    )

    assert replay["news_items"] == []
    assert len(audit_items) == 1
    item = audit_items[0]
    assert item["title"] == "Fed headline repeats across RSS polls"
    assert item["seen_count"] == 2
    assert item["duplicate_count"] == 1
    assert item["first_seen_at"] == "2026-05-19T07:06:00+08:00"
    assert item["last_seen_at"] == "2026-05-19T07:18:00+08:00"
    assert item["fetched_at"] == "2026-05-19T07:18:00+08:00"
    assert item["summary_source"] == "Local AI"
    assert item["monitor_run_ids"] == [first_run_id, second_run_id]
    assert len(item["storage_row_ids"]) == 1


def test_replay_dedupes_same_source_headline_across_updated_timestamps(tmp_path) -> None:
    store = TimelineStore(tmp_path / "timeline.sqlite")
    first_run_id = store.record_monitor_run(
        run_started_at="2026-05-19T07:05:00+08:00",
        run_type="live",
        data_mode="live_seen",
        backfill_required=False,
        last_successful_run_at=None,
        no_news_found=False,
        alert_suppressed_reason="",
    )
    second_run_id = store.record_monitor_run(
        run_started_at="2026-05-19T07:20:00+08:00",
        run_type="live",
        data_mode="live_seen",
        backfill_required=False,
        last_successful_run_at="2026-05-19T07:05:00+08:00",
        no_news_found=False,
        alert_suppressed_reason="",
    )
    base_item = {
        "first_seen_at": "2026-05-19T07:05:00+08:00",
        "backfilled_at": None,
        "is_backfilled": False,
        "source": "Reuters",
        "title": "Iran headline repeats with updated feed timestamp",
        "link": "",
        "relevance_reason": "Fresh geopolitical headline.",
        "impact_direction_on_gold": "bullish_gold",
        "data_mode": "live_seen",
        "included": True,
        "filter_reason": "",
        "matched_keywords": ["iran"],
    }
    store.record_news_items(
        first_run_id,
        [{**base_item, "published_at": "2026-05-19T07:01:00+08:00"}],
    )
    store.record_news_items(
        second_run_id,
        [
            {
                **base_item,
                "published_at": "2026-05-19T07:11:00+08:00",
                "first_seen_at": "2026-05-19T07:20:00+08:00",
                "summary": "Repeated Iran headline kept once.",
                "summary_source": "Local AI",
            }
        ],
    )

    replay = store.get_market_replay("2026-05-19T07:00:00+08:00", "2026-05-19T07:30:00+08:00")

    assert len(replay["news_items"]) == 1
    item = replay["news_items"][0]
    assert item["title"] == "Iran headline repeats with updated feed timestamp"
    assert item["seen_count"] == 2
    assert item["duplicate_count"] == 1
    assert item["summary"] == "Repeated Iran headline kept once."
    assert item["monitor_run_ids"] == [first_run_id, second_run_id]


def test_replay_dedupes_near_duplicate_market_news_titles(tmp_path) -> None:
    store = TimelineStore(tmp_path / "timeline.sqlite")
    run_id = store.record_monitor_run(
        run_started_at="2026-06-18T22:40:00+08:00",
        run_type="live",
        data_mode="live_seen",
        backfill_required=False,
        last_successful_run_at=None,
        no_news_found=False,
        alert_suppressed_reason="",
    )
    store.record_news_items(
        run_id,
        [
            {
                "published_at": "2026-06-18T22:34:00+08:00",
                "first_seen_at": "2026-06-18T22:34:00+08:00",
                "backfilled_at": None,
                "is_backfilled": False,
                "source": "MarketWatch.com - Top Stories",
                "title": "A billion-dollar server company loses more than 40% of its value following short-seller report",
                "link": "",
                "relevance_reason": "Market risk headline.",
                "impact_direction_on_gold": "unknown",
                "data_mode": "live_seen",
                "included": True,
                "filter_reason": "",
            },
            {
                "published_at": "2026-06-18T22:34:00+08:00",
                "first_seen_at": "2026-06-18T22:35:00+08:00",
                "backfilled_at": None,
                "is_backfilled": False,
                "source": "MarketWatch.com - Top Stories",
                "title": "A billion-dollar server company just lost more than 40% of its value following a short-seller report",
                "summary": "Near-duplicate wording should stay one story.",
                "summary_source": "Local AI",
                "link": "",
                "relevance_reason": "Market risk headline.",
                "impact_direction_on_gold": "unknown",
                "data_mode": "live_seen",
                "included": True,
                "filter_reason": "",
            },
        ],
    )

    replay = store.get_market_replay("2026-06-18T22:00:00+08:00", "2026-06-18T23:00:00+08:00")

    assert len(replay["news_items"]) == 1
    item = replay["news_items"][0]
    assert item["summary"] == "Near-duplicate wording should stay one story."
    assert item["seen_count"] == 2
    assert item["duplicate_count"] == 1


def test_replay_removes_keyword_pile_summary_title_from_stored_news(tmp_path) -> None:
    store = TimelineStore(tmp_path / "timeline.sqlite")
    run_id = store.record_monitor_run(
        run_started_at="2026-06-14T07:50:00+08:00",
        run_type="live",
        data_mode="live_seen",
        backfill_required=False,
        last_successful_run_at=None,
        no_news_found=False,
        alert_suppressed_reason="",
    )
    store.record_news_items(
        run_id,
        [
            {
                "published_at": "2026-06-14T07:44:00+08:00",
                "first_seen_at": "2026-06-14T07:50:00+08:00",
                "backfilled_at": None,
                "is_backfilled": False,
                "source": "US Top News and Analysis",
                "title": "Trump says Iran deal will be signed Sunday, Strait of Hormuz to open immediately after",
                "summary_title": "Trump peace deal Iran",
                "summary": "Trump says a Sunday Iran deal could reopen Hormuz.",
                "summary_source": "Local AI",
                "link": "",
                "relevance_reason": "Fresh geopolitical headline.",
                "impact_direction_on_gold": "bullish_gold",
                "data_mode": "live_seen",
                "included": True,
                "filter_reason": "",
                "matched_keywords": ["iran", "hormuz"],
            }
        ],
    )

    replay = store.get_market_replay("2026-06-14T07:00:00+08:00", "2026-06-14T08:00:00+08:00")

    assert len(replay["news_items"]) == 1
    item = replay["news_items"][0]
    assert item["title"] == "Trump says Iran deal will be signed Sunday, Strait of Hormuz to open immediately after"
    assert "summary_title" not in item
    assert item["summary"] == "Trump says a Sunday Iran deal could reopen Hormuz."


def test_month_summary_dedupes_repeated_major_markers(tmp_path) -> None:
    store = TimelineStore(tmp_path / "timeline.sqlite")
    run_id = store.record_monitor_run(
        run_started_at="2026-05-19T07:15:00+08:00",
        run_type="live",
        data_mode="live_seen",
        backfill_required=False,
        last_successful_run_at=None,
        no_news_found=False,
        alert_suppressed_reason="",
    )
    marker = {
        "semantic_type": "breakout",
        "impact_percent": -0.48,
        "main_driver": "yields",
        "summary": "Yields confirmed the XAUUSD down move.",
    }
    store.record_timeline_event(
        run_id,
        event_time="2026-05-19T07:15:10+08:00",
        event_type="market_alert",
        label="Yields pressure",
        payload=marker,
    )
    store.record_timeline_event(
        run_id,
        event_time="2026-05-19T07:15:45+08:00",
        event_type="market_alert",
        label="Yields pressure",
        payload={**marker, "summary": "Duplicate repeat from same minute."},
    )

    replay = store.get_market_replay("2026-05-01T00:00:00+08:00", "2026-05-31T23:59:00+08:00")

    assert len(replay["month_summary_events"]) == 1
    assert replay["month_summary_events"][0]["label"] == "Yields pressure"


def test_replay_uses_existing_calendar_when_timeline_has_no_calendar_rows(tmp_path) -> None:
    calendar_dir = tmp_path / "data" / "Economic_Calendar"
    year_dir = calendar_dir / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text(
        json.dumps(
            [
                {
                    "Date": "2026-05-19",
                    "Day": "Tuesday",
                    "Time": "08:15",
                    "Cur.": "USD",
                    "Imp.": "High",
                    "Event": "Core CPI (MoM)",
                    "Actual": "",
                    "Forecast": "0.3%",
                    "Previous": "0.2%",
                },
                {
                    "Date": "2026-05-19",
                    "Day": "Tuesday",
                    "Time": "08:20",
                    "Cur.": "NZD",
                    "Imp.": "Low",
                    "Event": "Low noise event",
                    "Actual": "",
                    "Forecast": "",
                    "Previous": "",
                },
                {
                    "Date": "2026-05-19",
                    "Day": "Tuesday",
                    "Time": "All Day",
                    "Cur.": "BHD",
                    "Imp.": "Holiday",
                    "Event": "Eid al-Adha",
                    "Actual": "",
                    "Forecast": "",
                    "Previous": "",
                },
            ]
        ),
        encoding="utf-8",
    )
    store = TimelineStore(tmp_path / "timeline.sqlite", calendar_dir=calendar_dir)

    replay = store.get_market_replay("2026-05-19T07:00:00+08:00", "2026-05-19T09:00:00+08:00")

    assert [item["title"] for item in replay["calendar_events"]] == ["Core CPI (MoM)"]
    assert replay["calendar_events"][0]["data_mode"] == "calendar_context"
    assert replay["calendar_events"][0]["review_status"] == "unreviewed_context"
    assert replay["calendar_events"][0]["storage_status"] == "read_from_existing_calendar"


def test_replay_prefers_existing_calendar_over_stored_calendar_trace(tmp_path) -> None:
    calendar_dir = tmp_path / "data" / "Economic_Calendar"
    year_dir = calendar_dir / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text(
        json.dumps(
            [
                {
                    "Date": "2026-05-19",
                    "Day": "Tuesday",
                    "Time": "08:15",
                    "Cur.": "USD",
                    "Imp.": "High",
                    "Event": "Real Calendar CPI",
                    "Actual": "",
                    "Forecast": "0.3%",
                    "Previous": "0.2%",
                }
            ]
        ),
        encoding="utf-8",
    )
    store = TimelineStore(tmp_path / "timeline.sqlite", calendar_dir=calendar_dir)
    run_id = store.record_monitor_run(
        run_started_at="2026-05-19T08:00:00+08:00",
        run_type="live",
        data_mode="live_seen",
        backfill_required=False,
        last_successful_run_at=None,
        no_news_found=False,
        alert_suppressed_reason=None,
    )
    store.record_calendar_events(
        run_id,
        [
            {
                "scheduled_at": "2026-05-19T08:15:00+08:00",
                "source": "Stored trace",
                "title": "Stored Calendar Trace",
                "relevance_reason": "old trace",
                "impact_direction_on_gold": "unknown",
                "data_mode": "live_seen",
            }
        ],
    )

    replay = store.get_market_replay("2026-05-19T07:00:00+08:00", "2026-05-19T09:00:00+08:00")

    assert [item["title"] for item in replay["calendar_events"]] == ["Real Calendar CPI"]
    assert replay["calendar_events"][0]["source"] == "Economic Calendar"
