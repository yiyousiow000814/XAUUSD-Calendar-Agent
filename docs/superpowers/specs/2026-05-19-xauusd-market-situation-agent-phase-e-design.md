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

## Provider Model
- `MarketDataProvider`: latest bars + backfill bars
- `RelatedAssetsProvider`: latest series + backfill series
- `NewsProvider`: latest filtered items + backfill items
- `CalendarProvider`: window events + backfill events

All providers return normalized rows plus `ProviderHealth`.

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
