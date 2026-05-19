# Market Agent Providers

## Provider policy

Market Agent is designed around provider interfaces. Manual local CSV files are fallback only.

Normal priority:

1. cTrader Open API spot provider for true XAUUSD price, when configured
2. cTrader M1 trendbars for recovery and backfill, when configured
3. Yahoo chart provider for proxy data
4. optional fallback providers
5. local CSV fallback only when explicitly enabled

If no provider is available, the system must not crash. It should surface provider health as unavailable.

## Current practical status

### XAUUSD

- cTrader is now the preferred provider path when `clientId`, `clientSecret`, `accessToken`, and `accountId` are configured.
- cTrader uses Open API client credentials plus account token auth. It does not use a password.
- The provider writes quote snapshots under user-data and can reuse them only as an explicit stale fallback.
- If cTrader spot or cTrader historical trendbars fail, ProviderRouter falls back to Yahoo `GC=F`.
- Yahoo `GC=F` remains the proxy path when cTrader is unavailable.
- When Yahoo is used, the system must label it as:
  - `source_type=futures_proxy`
  - `data_mode=proxy`

Do not treat `GC=F` as true XAUUSD spot.

### cTrader auth and storage

Supported config fields:

- `CTRADER_CLIENT_ID`
- `CTRADER_CLIENT_SECRET`
- `CTRADER_ACCESS_TOKEN`
- `CTRADER_REFRESH_TOKEN`
- `CTRADER_ACCOUNT_ID`
- `CTRADER_ENVIRONMENT=demo|live`
- `CTRADER_SYMBOL`
- `CTRADER_APP_REDIRECT_URI`
- `CTRADER_CONFIG_PATH`
- `CTRADER_TOKEN_STORE_PATH`
- `CTRADER_SNAPSHOT_PATH`

The app stores cTrader config under user-data:

- `ctrader-openapi.json`
- `ctrader-token.json`
- `ctrader-last-quote.json`

Important rules:

- do not store or request a cTrader password
- do not commit tokens or client secrets
- UI responses must show masked values only
- if access token auth fails and a refresh token exists, the bridge attempts token refresh
- the desktop `Refresh Token` action updates the user-data token store and only returns masked config back to UI
- if refresh fails, provider health must show the auth failure honestly

### cTrader bridge model

The desktop and Python provider use a short-lived bridge process:

1. application auth
2. account list lookup by access token
3. account auth
4. symbol resolution
5. quote subscribe or trendbar request
6. JSON response back to the caller

This keeps the monitor loop synchronous while still using the official cTrader Open API SDK.

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

## Local LLM

The local LLM path is optional and disabled by default.

Default setup:

- provider: Ollama
- endpoint: `http://localhost:11434`
- model: `qwen3:4b`
- temperature: `0.1`
- timeout: `20` seconds
- keep alive: `0`
- max context: `8192`

The LLM is not a provider of market truth. It only receives the evidence packet after a meaningful trigger, driver-state change, high-impact event, recovery summary, or explicit user analysis action.

The prompt includes:

- market move
- provider health
- active and dormant driver states
- driver attention summary
- allowed candidate drivers
- blocked drivers
- cross-asset confirmation
- evidence status
- timeline
- previous state

Invalid JSON, unavailable Ollama, timeout, or a blocked-driver claim must fall back to rule-based output. The validator remains the final guard.

The desktop app stores local LLM settings under user-data:

- `market-agent-llm.json`

## Environment variables

```powershell
$env:CTRADER_CLIENT_ID = ""
$env:CTRADER_CLIENT_SECRET = ""
$env:CTRADER_ACCESS_TOKEN = ""
$env:CTRADER_REFRESH_TOKEN = ""
$env:CTRADER_ACCOUNT_ID = ""
$env:CTRADER_ENVIRONMENT = "demo"
$env:CTRADER_SYMBOL = "XAUUSD"
$env:CTRADER_APP_REDIRECT_URI = "http://localhost"
$env:CTRADER_CONFIG_PATH = "user-data/ctrader-openapi.json"
$env:CTRADER_TOKEN_STORE_PATH = "user-data/ctrader-token.json"
$env:CTRADER_SNAPSHOT_PATH = "user-data/ctrader-last-quote.json"
$env:CTRADER_BRIDGE_PYTHON = "python"
$env:MARKET_AGENT_YAHOO_ENABLED = "true"
$env:MARKET_AGENT_YAHOO_FIXTURE_DIR = "tests/fixtures/providers"
$env:MARKET_AGENT_CSV_FALLBACK_ENABLED = "false"
$env:MARKET_AGENT_FOREX_FACTORY_SOURCE_URL = ""
$env:NEWS_RSS_FEEDS = "https://www.federalreserve.gov/feeds/press_all.xml,https://www.cnbc.com/id/100003114/device/rss/rss.html"
$env:MARKET_AGENT_TIMELINE_STORE_PATH = "user-data/market_agent_timeline.sqlite"
$env:MARKET_AGENT_STATE_STORE_PATH = "user-data/market_agent_state.json"
$env:MARKET_AGENT_ALERTS_OUTPUT_PATH = "user-data/market_agent_alerts.ndjson"
$env:MARKET_AGENT_CTRADER_SAVED_SNAPSHOT_PATH = "user-data/ctrader-last-quote.json"
$env:LOCAL_LLM_ENABLED = "false"
$env:LOCAL_LLM_PROVIDER = "ollama"
$env:LOCAL_LLM_ENDPOINT = "http://localhost:11434"
$env:LOCAL_LLM_MODEL = "qwen3:4b"
$env:LOCAL_LLM_TEMPERATURE = "0.1"
$env:LOCAL_LLM_TIMEOUT_SECONDS = "20"
$env:LOCAL_LLM_KEEP_ALIVE = "0"
$env:LOCAL_LLM_MAX_CONTEXT = "8192"
$env:MARKET_AGENT_TELEGRAM_ENABLED = "false"
$env:MARKET_AGENT_TELEGRAM_BOT_TOKEN = ""
$env:MARKET_AGENT_TELEGRAM_CHAT_ID = ""
$env:MARKET_AGENT_TELEGRAM_TIMEOUT_SECONDS = "10"
$env:MARKET_AGENT_TELEGRAM_LEVELS = "level_2,level_3"
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

Run backfill and recovery:

```powershell
python -m src.xauusd_market_agent.cli --backfill-recovery
```

Run a cTrader-backed pass with Yahoo fallback still enabled:

```powershell
$env:CTRADER_CLIENT_ID = "your-client-id"
$env:CTRADER_CLIENT_SECRET = "your-client-secret"
$env:CTRADER_ACCESS_TOKEN = "your-access-token"
$env:CTRADER_REFRESH_TOKEN = "your-refresh-token"
$env:CTRADER_ACCOUNT_ID = "123456"
$env:CTRADER_ENVIRONMENT = "demo"
$env:CTRADER_SYMBOL = "XAUUSD"
python -m src.xauusd_market_agent.cli --monitor-once
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
