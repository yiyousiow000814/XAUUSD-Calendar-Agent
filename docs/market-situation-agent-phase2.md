# XAUUSD Market Situation Agent Phase 2

## What Phase 2 adds

Phase 2 keeps the Phase 1 conservative analysis path and adds real local-data inputs:

- local price provider backed by `data/XAUUSD_data/XAUUSD_data.csv`
- local related-assets provider backed by a JSON snapshot file
- local calendar provider backed by `data/Economic_Calendar/<year>/<year>_calendar.json`
- RSS news provider support from configured feeds
- monitored-window filtering for calendar events and headlines
- live evidence-packet construction
- `--live-once` CLI mode
- optional local LLM invocation on top of the evidence packet, still guarded by validator + fallback

The final analysis still runs through deterministic evidence gates and conservative rule-based output. If a provider is unavailable, the pipeline falls back to empty inputs instead of inventing evidence.

Phase 3 adds persisted state and monitored alert decisions. See [Phase 3](market-situation-agent-phase3.md).

## New modules

- `src/xauusd_market_agent/config.py`: Windows-friendly local configuration
- `src/xauusd_market_agent/providers/market_prices.py`: tail-reading local XAUUSD CSV provider
- `src/xauusd_market_agent/providers/related_assets.py`: local related-assets snapshot loader
- `src/xauusd_market_agent/providers/calendar_events.py`: calendar window loader
- `src/xauusd_market_agent/providers/news_events.py`: RSS/news window loader and filter
- `src/xauusd_market_agent/live_pipeline.py`: live fixture and evidence-packet builder

## Live run commands

Run one local live pass:

```powershell
python -m src.xauusd_market_agent.cli --live-once
```

Run one local live pass as JSON:

```powershell
python -m src.xauusd_market_agent.cli --live-once --format json
```

Use a fixed anchor time:

```powershell
python -m src.xauusd_market_agent.cli --live-once --format json --anchor-time 2026-05-19T00:31:00+08:00
```

## Environment knobs

Optional paths:

```text
MARKET_AGENT_PRICE_DATA_PATH=...
MARKET_AGENT_CALENDAR_DIR=...
MARKET_AGENT_RELATED_ASSETS_PATH=...
```

Example related-assets snapshot:

```json
{
  "dxy_percent": 0.22,
  "us10y_bps": 5.1,
  "us2y_bps": 4.4,
  "wti_percent": 1.6,
  "brent_percent": 1.4,
  "vix_percent": 5.8,
  "spx_percent": -1.1,
  "nasdaq_percent": -1.3
}
```

Optional timing controls:

```text
MARKET_AGENT_NEWS_LOOKBACK_MINUTES=30
MARKET_AGENT_POST_MOVE_NEWS_MINUTES=120
MARKET_AGENT_CALENDAR_LOOKBACK_MINUTES=60
MARKET_AGENT_MOVE_WINDOW_MINUTES=15
```

Optional RSS list:

```text
NEWS_RSS_FEEDS=https://example.com/rss,https://example.com/feed.xml
```

The RSS loader uses Python standard library XML parsing, so live mode does not depend on `feedparser` being installed.

If `LOCAL_LLM_ENABLED=true` and the configured Ollama endpoint is reachable, `live-once` can pass the evidence packet through the local LLM. The final output is still guarded by the blocked-driver validator and falls back to deterministic analysis on any LLM failure or invalid output.

## Current limitations

- Related assets still need an explicit local source file to move beyond neutral/unavailable status.
- Phase 2 does not persist market state yet.
- Phase 2 does not send notifications.
- Phase 2 does not integrate with the desktop UI yet.
