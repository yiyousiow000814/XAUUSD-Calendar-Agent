# Market Agent Providers

## Provider policy

Market Agent is designed around provider interfaces. Manual local CSV files are fallback only.

Normal priority:

1. cTrader CLI spot provider for true XAUUSD price, when configured
2. cTrader M1 trendbars for recovery and backfill, when configured
3. Yahoo chart provider for proxy data
4. optional fallback providers
5. local CSV fallback only when explicitly enabled

If no provider is available, the system must not crash. It should surface provider health as unavailable.

## Current practical status

### XAUUSD

- cTrader is the preferred provider path after Connect cTrader saves local CLI credentials and the connection test passes.
- cTrader uses the local CLI credential set: trading account, cTID or email, and password.
- Password values are stored only in the local user-data config, masked in UI responses, and not written to logs or process environment variables.
- The provider writes quote snapshots under user-data and can reuse them only as an explicit stale fallback.
- If cTrader spot or cTrader historical trendbars fail, ProviderRouter falls back to Yahoo `GC=F`.
- Yahoo `GC=F` remains the proxy path when cTrader is unavailable.
- When Yahoo is used, the system must label it as:
  - `source_type=futures_proxy`
  - `data_mode=proxy`

Do not treat `GC=F` as true XAUUSD spot.

### cTrader CLI auth and storage

The default desktop flow is:

1. click Connect cTrader
2. enter the trading account, cTID or email, and password expected by the local cTrader CLI
3. save the credential set under user-data
4. run the cTrader CLI connection test through the backend bridge
5. let backend provider policy resolve XAUUSD and any available cTrader context markets
6. use Yahoo or other backend fallback providers for markets that are not available through cTrader

Supported config fields:

- `CTRADER_ACCOUNT_ID`
- `CTRADER_CTID`
- `CTRADER_PASSWORD`
- `CTRADER_ENVIRONMENT=demo|live`
- `CTRADER_CONFIG_PATH`

The app stores cTrader config under user-data:

- `ctrader-cli.json`
- `ctrader-last-quote.json`

Important rules:

- do not commit cTrader credentials
- UI responses must show cTID and password as masked values only
- process logs and UI snapshots must not include the raw password
- the monitor loop receives `CTRADER_CONFIG_PATH` and reads the saved config through backend code; it does not receive the password as an environment variable
- if the CLI login or refresh handled by the CLI fails, provider health must show the auth failure honestly
- symbols are backend policy, not user setup

### cTrader bridge model

The desktop and Python provider use a short-lived bridge process:

1. load the saved cTrader CLI config
2. execute the configured cTrader CLI command
3. pass account ID, cTID, password, backend environment, and backend-selected market request through stdin JSON
4. run `test-connection`, `resolve-symbol`, `quote`, or `backfill`
5. parse JSON response back to the caller

This keeps the monitor loop synchronous while avoiding token forms in the desktop UI. The bridge must redact the password from errors and never echo stdin payloads to logs.

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

Auto Local AI setup:

- provider: Ollama
- endpoint: `http://localhost:11434`
- default model profile: `qwen3.5:4b`
- fallback profile: `qwen3.5:2b`
- lightweight profile: `qwen3.5:0.8b`
- temperature: `0.1`
- timeout: `20` seconds
- keep alive: `0`
- max context: `8192`

The desktop app detects OS, CPU, RAM, GPU, VRAM, Ollama install/running state, and installed local models. It recommends a model from the local profile policy. Ollama installation itself is guided by a download link. When Ollama is already installed, the app can pull the recommended model through the Ollama API after user approval and show pull progress.

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

Invalid JSON, unavailable Ollama, timeout, slow benchmark, failed model pull, or a blocked-driver claim must fall back to a smaller model or rule-based output. The validator remains the final guard.

The desktop app stores local LLM settings under user-data:

- `market-agent-llm.json`

## Environment variables

```powershell
$env:CTRADER_ACCOUNT_ID = ""
$env:CTRADER_CTID = ""
$env:CTRADER_PASSWORD = ""
$env:CTRADER_ENVIRONMENT = "demo"
$env:CTRADER_CONFIG_PATH = "user-data/ctrader-cli.json"
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
$env:LOCAL_LLM_MODEL = "qwen3.5:4b"
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
$env:CTRADER_ACCOUNT_ID = "123456"
$env:CTRADER_CTID = "name@example.com"
$env:CTRADER_PASSWORD = "your-password"
$env:CTRADER_ENVIRONMENT = "demo"
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
