# XAUUSD Market Situation Agent Phase A-D Design

## Goal
Make attention, evidence gating, and persistence real, not decorative.

## Data Model
- `ProviderHealth`: `source`, `source_type`, `fetched_at`, `data_timestamp`, `data_mode`, `is_available`, `is_stale`, `stale_reason`, `error`.
- `DriverAttentionState`: `driver_id`, `label`, `category`, `current_state`, `priority`, `relevance_score`, `activation_reason`, `deactivation_reason`, `first_activated_at`, `last_confirmed_at`, `last_evidence_at`, `decay_deadline`, `linked_assets`, `required_evidence_gates`, `optional_evidence_gates`, `current_evidence_summary`, `current_counter_evidence`, `confidence`, `source_count`, `related_news_count`, `related_calendar_events`, `notes`, `data_mode`.
- `TimelineEntry`: unified replay row for price, asset, news, calendar, evidence, analysis, alert, and recovery events.

## Attention Lifecycle
- `dormant`: default for structural and conditional drivers.
- `watching`: cheap signal appeared, but no confirmation.
- `emerging`: repeated or clustered evidence, still unconfirmed.
- `active`: evidence gates pass and current move aligns.
- `cooling`: no fresh confirmation and decay has started.
- `retired`: driver no longer relevant to current regime.
- `unknown`: no driver passes.

Attention must influence analysis: only `active` or `emerging` drivers can enter the candidate set unless a direct evidence gate also passes.

## Evidence Gate Changes
- Add freshness-aware statuses: `confirming`, `contradicting`, `neutral`, `stale`, `unavailable`, `not_confirming`.
- `usd` requires fresh DXY confirmation.
- `yields` requires fresh US10Y or US2Y confirmation.
- `fed_rates` requires Fed/calendar/news evidence or fresh yield confirmation.
- `oil_inflation` requires fresh oil move plus a supporting channel from yields/inflation/geopolitics.
- `geopolitics` requires timestamped headline plus market reaction.
- `risk_sentiment` requires fresh VIX/equities confirmation.
- `technical_liquidation` remains fallback only when macro/news is missing.

## SQLite Schema
- `monitor_runs`
- `market_price_bars`
- `related_asset_bars`
- `news_items`
- `calendar_events`
- `provider_health`
- `driver_attention_states`
- `evidence_packets`
- `analysis_results`
- `alerts`
- `state_transitions`

Every monitor pass writes a `monitor_run_id`, even if suppressed.

## File Changes
- Add: `src/xauusd_market_agent/provider_health.py`
- Add: `src/xauusd_market_agent/driver_attention.py`
- Add: `src/xauusd_market_agent/timeline_store.py`
- Modify: `src/xauusd_market_agent/evidence.py`
- Modify: `src/xauusd_market_agent/models.py`
- Modify: `src/xauusd_market_agent/pipeline.py`
- Modify: `src/xauusd_market_agent/live_pipeline.py`
- Modify: `src/xauusd_market_agent/llm_client.py`
- Modify: `src/xauusd_market_agent/cli.py`
- Add/update tests in `tests/test_driver_attention.py`, `tests/test_provider_health.py`, `tests/test_timeline_store.py`, `tests/test_evidence_gate.py`, `tests/test_llm_integration.py`

## Tests
- Oil defaults to dormant.
- Oil becomes active only with fresh oil move plus channel confirmation.
- DXY stale cannot confirm usd.
- US10Y unavailable cannot confirm yields.
- Fresh DXY + fresh US10Y confirms rates/USD pressure.
- Geopolitics is blocked without timestamped headline.
- Micro theme starts watching/emerging, not active macro.
- Driver decays to cooling/retired without refresh.
- Every monitor run persists, including suppressed alerts and `no_news_found`.
- Recovery/backfill run persists with `data_mode=backfilled`.
- LLM prompt contains provider health, attention states, previous state, allowed/blocked drivers, and evidence status.
- Blocked-driver LLM claims are rejected.

## Phase Scope
- Phase A: expand evidence packet and prompt inputs.
- Phase B: provider health and freshness-aware gates.
- Phase C: driver attention manager and lifecycle transitions.
- Phase D: SQLite timeline store plus monitor/recovery persistence.
