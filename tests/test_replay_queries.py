from src.xauusd_market_agent.timeline_store import TimelineStore


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
    assert replay["suppressed_alerts"]
