# XAUUSD Market Situation Agent Phase E Design

## Goal
Replace CSV-centric runtime assumptions with provider-driven live collection, backfill, and replay.

## Scope
- Phase E1: provider interfaces and router
- Phase E2: Yahoo chart provider
- Phase E3: RSS/news provider
- Phase E4: calendar / ForexFactory provider
- Phase E5: backfill and recovery manager
- Phase E6: replay queries and CLI
- Phase E7: cTrader skeleton

## Runtime Rules
- CSV remains fallback/debug only.
- Normal runtime uses provider router.
- If no provider is configured or available, store unavailable provider health and continue gracefully.
- `live_seen`, `backfilled`, `proxy`, `stale`, and `unavailable` must stay explicit through persistence and replay.
- Provider priority is explicit:
  1. cTrader spot, only when a real live implementation exists and is enabled
  2. Yahoo `GC=F` futures proxy
  3. local CSV fallback only when `MARKET_AGENT_CSV_FALLBACK_ENABLED=true`
  4. unavailable provider health when all sources fail
- `US2Y` must never silently reuse `^TNX`. If no reliable free 2Y source is configured, persist it as unavailable.

## Provider Model
- `MarketDataProvider`: latest bars + backfill bars
- `RelatedAssetsProvider`: latest series + backfill series
- `NewsProvider`: latest filtered items + backfill items
- `CalendarProvider`: window events + backfill events

All providers return normalized rows plus `ProviderHealth`.

## Env Examples
```powershell
$env:MARKET_AGENT_YAHOO_ENABLED = "true"
$env:MARKET_AGENT_YAHOO_FIXTURE_DIR = "tests/fixtures/providers"
$env:MARKET_AGENT_CSV_FALLBACK_ENABLED = "false"
$env:MARKET_AGENT_FOREX_FACTORY_FIXTURE_PATH = "tests/fixtures/providers/forex_factory.json"
$env:MARKET_AGENT_FOREX_FACTORY_SOURCE_URL = ""
$env:MARKET_AGENT_CTRADER_SAVED_SNAPSHOT_PATH = "user-data/ctrader_snapshot.json"
```

## RSS Audit Rules
- Store included and filtered RSS items together.
- Each item carries `included`, `filter_reason`, `source_quality_score`, `matched_keywords`, `categories`, and `score`.
- Filtered or low-signal items remain queryable in replay, but they must not become direct driver evidence.
- TODO for later phase: persist first-class filtered news counters and driver-specific news inclusion decisions.

## Recovery Model
- Detect gap from `last_successful_run_at`
- Call provider backfill interfaces for the gap
- Persist recovered price / asset / news / calendar rows
- Segment recovered XAUUSD moves
- Re-run evidence + attention on each segment
- Persist recovery summary and replay events

## Replay Model
- Query first-class tables, not only `timeline_events`
- Expose:
  - `get_price_series`
  - `get_related_asset_series`
  - `get_news_items`
  - `get_calendar_events`
  - `get_driver_attention_timeline`
  - `get_evidence_for_run`
  - `get_suppressed_alerts`
  - `get_state_transitions`
  - `get_market_replay`

## File Additions
- `src/xauusd_market_agent/providers/base.py`
- `src/xauusd_market_agent/providers/yahoo_chart.py`
- `src/xauusd_market_agent/providers/ctrader_provider.py`
- `src/xauusd_market_agent/providers/rss_provider.py`
- `src/xauusd_market_agent/providers/forex_factory_provider.py`
- `src/xauusd_market_agent/providers/provider_router.py`
- `src/xauusd_market_agent/backfill.py`
- `src/xauusd_market_agent/recovery.py`

## Tests
- Yahoo fixture parse / change windows / stale logic
- RSS parse / dedupe / timestamp / backfill fields
- ForexFactory parse
- cTrader missing config / saved snapshot fallback
- Provider router uses fixture providers and CSV fallback only when chosen
- Backfill stores recovered rows and summary
- Replay queries return ordered combined output
