# XAUUSD Market Situation Agent Phase 5

## What Phase 5 adds

Phase 5 closes the MVP loop by surfacing market-agent output inside the desktop app:

- Tauri command to load persisted market-agent state and recent alert history
- Web UI panel for current market-agent thesis and recent alerts
- desktop-friendly artifact lookup across app data, portable `user-data`, and local repo development paths

This phase does not invent new analysis. It exposes the validated Phase 1-4 output so the desktop shell can review current state and recent alerts without opening raw JSON or NDJSON files.

## New modules

- `market_agent` command in the Tauri backend
- `MarketAgentPanel` in the React UI

## Current behavior

- the Activity drawer now shows the current market-agent state when artifacts exist
- recent alert history is displayed from newest to oldest
- if artifacts are missing, the panel states that clearly instead of fabricating data

## Verification commands

```powershell
cargo test market_agent --manifest-path app/tauri/src-tauri/Cargo.toml
python -m pytest tests/test_fixtures.py tests/test_market_move_detector.py tests/test_cross_asset_detector.py tests/test_evidence_gate.py tests/test_state_transition.py tests/test_llm_json_contract.py tests/test_blocked_driver_validation.py tests/test_dry_run_cli.py tests/test_market_price_provider.py tests/test_related_assets_provider.py tests/test_related_assets_series_provider.py tests/test_related_assets_refresh.py tests/test_calendar_provider.py tests/test_news_provider.py tests/test_rss_loader.py tests/test_live_pipeline.py tests/test_live_config.py tests/test_notification_policy.py tests/test_state_store.py tests/test_notifier.py tests/test_telegram_notifier.py tests/test_alert_history.py tests/test_monitor_loop.py tests/test_live_monitor_run.py tests/test_llm_integration.py tests/test_llm_repair.py -v
npm --prefix app/webui run test
npm --prefix app/webui run build
npm run ui:check
```
