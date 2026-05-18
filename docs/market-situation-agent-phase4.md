# XAUUSD Market Situation Agent Phase 4

## What Phase 4 adds

Phase 4 deepens the state-aware layer added in Phase 3:

- persisted market state now keeps `cause_status`, last analysis time, last notification level, and state-change reason
- state transitions separate material state changes from diagnostic changes such as confidence-only drift
- previous-state invalidation is tracked explicitly with concrete trigger reasons
- monitored output now includes a `state_transition` block so each alert decision is traceable

This keeps the monitored agent conservative: confidence changes are visible, but they do not automatically become a new alertable state. A prior thesis is only treated as invalidated when the current analysis materially contradicts it.

Phase 5 remains open for UI integration, historical review, and deeper backtesting.

## New transition metadata

Persisted state fields now include:

- `cause_status`
- `last_analysis_time`
- `last_notification_level`
- `state_change_reason`
- `invalidation_triggered`
- `invalidation_triggered_by`

Monitored runs expose:

```powershell
python -m src.xauusd_market_agent.cli --monitor-once --format json
```

The JSON now includes:

- `notification`
- `state_transition.is_new_state`
- `state_transition.is_continuation`
- `state_transition.previous_state_invalidated`
- `state_transition.state_change_reason`
- `state_transition.confidence_changed`
- `state_transition.confidence_delta`
- `state_transition.invalidation_triggered_by`
- `state_transition.next_state`

## Current behavior

- confidence-only changes are tracked but do not bypass cooldown by themselves
- `no_meaningful_change` does not invalidate the previous thesis
- unconfirmed analysis can invalidate a prior high-confidence thesis when bias/driver evidence materially breaks

## Verification commands

```powershell
python -m pytest tests/test_state_transition.py tests/test_notification_policy.py tests/test_state_store.py tests/test_live_monitor_run.py -v
python -m pytest tests/test_fixtures.py tests/test_market_move_detector.py tests/test_cross_asset_detector.py tests/test_evidence_gate.py tests/test_state_transition.py tests/test_llm_json_contract.py tests/test_blocked_driver_validation.py tests/test_dry_run_cli.py tests/test_market_price_provider.py tests/test_related_assets_provider.py tests/test_related_assets_series_provider.py tests/test_related_assets_refresh.py tests/test_calendar_provider.py tests/test_news_provider.py tests/test_rss_loader.py tests/test_live_pipeline.py tests/test_live_config.py tests/test_notification_policy.py tests/test_state_store.py tests/test_notifier.py tests/test_telegram_notifier.py tests/test_alert_history.py tests/test_monitor_loop.py tests/test_live_monitor_run.py tests/test_llm_integration.py tests/test_llm_repair.py -v
```
