# Market Agent Providers

## Provider policy

Market Agent is designed around provider interfaces. Manual local CSV files are fallback only.

Normal priority:

1. cTrader spot provider, only when a real implementation and credentials are available
2. Yahoo chart provider for proxy data
3. optional fallback providers
4. local CSV fallback only when explicitly enabled

If no provider is available, the system must not crash. It should surface provider health as unavailable.

## Current practical status

### XAUUSD

- cTrader live quote fetching is currently disabled unless implemented explicitly in code.
- Yahoo `GC=F` is the current proxy path.
- When Yahoo is used, the system must label it as:
  - `source_type=futures_proxy`
  - `data_mode=proxy`

Do not treat `GC=F` as true XAUUSD spot.

### Related assets

Current base telemetry targets include:

- DXY
- US10Y
- US2Y
- WTI
- Brent
- VIX
- SPX
- Nasdaq

Important caveat:

- `US2Y` must not silently reuse `^TNX`.
- If no reliable free US2Y source is available, it should remain unavailable.

### News

News is driven by RSS and feed queries. News can be delayed or noisy.

Store both:

- included items
- filtered or low-signal items with a reason

Backfilled news must preserve:

- `published_at`
- `first_seen_at`
- `backfilled_at`
- `is_backfilled`

Backfilled news must not be presented as live-seen.

### Calendar

Calendar data may come from:

- ForexFactory source URL
- optional local calendar source
- official references

If no calendar source is configured, provider health should show unavailable rather than silently pretending the feed is empty.

## Environment variables

```powershell
$env:MARKET_AGENT_YAHOO_ENABLED = "true"
$env:MARKET_AGENT_YAHOO_FIXTURE_DIR = "tests/fixtures/providers"
$env:MARKET_AGENT_CSV_FALLBACK_ENABLED = "false"
$env:MARKET_AGENT_FOREX_FACTORY_SOURCE_URL = ""
$env:NEWS_RSS_FEEDS = "https://www.federalreserve.gov/feeds/press_all.xml,https://www.cnbc.com/id/100003114/device/rss/rss.html"
$env:MARKET_AGENT_TIMELINE_STORE_PATH = "user-data/market_agent_timeline.sqlite"
$env:MARKET_AGENT_STATE_STORE_PATH = "user-data/market_agent_state.json"
$env:MARKET_AGENT_ALERTS_OUTPUT_PATH = "user-data/market_agent_alerts.ndjson"
$env:MARKET_AGENT_CTRADER_SAVED_SNAPSHOT_PATH = "user-data/ctrader_snapshot.json"
```

## Windows monitor commands

Run one monitoring pass:

```powershell
python -m src.xauusd_market_agent.cli --monitor-once
```

Run the monitoring loop:

```powershell
python -m src.xauusd_market_agent.cli --monitor-loop --interval-seconds 60
```

Replay a stored window:

```powershell
python -m src.xauusd_market_agent.cli --replay --start "2026-05-19T08:00:00+08:00" --end "2026-05-19T18:00:00+08:00"
```

List the timeline view:

```powershell
python -m src.xauusd_market_agent.cli --timeline --start "2026-05-19T08:00:00+08:00" --end "2026-05-19T18:00:00+08:00"
```

## Provider-health expectations

Every provider result should expose:

- source
- source type
- fetched time
- data timestamp
- data mode
- available or unavailable
- stale or fresh
- stale reason
- backend error

Evidence gate decisions must respect those states. Unavailable and stale are not the same as neutral.
