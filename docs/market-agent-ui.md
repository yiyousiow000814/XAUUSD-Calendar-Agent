# Market Agent UI

## Purpose

The desktop app now exposes Market Agent as a first-class view instead of hiding it inside the Activity drawer.

This view is intended for:

- current market situation
- driver attention state
- provider health
- replay and timeline review
- evidence inspection for a selected run

This view is not a trading-entry panel. It does not provide prediction, TP, or SL logic.

## Open the UI

1. Launch the desktop app.
2. Use the top app bar button `Market Agent`.
3. The Activity drawer card remains a compact preview only. Use `Open Market Agent` there to jump into the full page.
4. Use `Data Sources` on the Market Agent page to follow cTrader, Local AI, Telegram, monitoring, and backend activity.

## What the page shows

### Live Situation

- current bias
- main driver
- cause status
- confidence
- current thesis
- latest analysis time
- latest notification level
- current source mode and source type

Important labels:

- `PROXY` means the market view is using proxy data.
- `futures_proxy` means Yahoo `GC=F`, not true XAUUSD spot.
- `BACKFILLED` means the system reconstructed data after downtime.
- `STALE` means the data is present but too old for strong evidence use.
- `UNAVAILABLE` means no usable data was returned.

### Driver Attention

The Driver Attention table shows each monitored driver and its current lifecycle state:

- dormant
- watching
- emerging
- active
- cooling
- retired
- unknown

This is where you can verify that:

- oil is monitored but not always active
- geopolitics is not treated as active without timestamped headline plus confirmation
- DXY and yields can remain observed without automatically becoming the main driver

### Provider Health

The Provider Health table shows:

- source
- source type
- data mode
- available or unavailable
- stale or fresh
- source timestamps
- backend error or stale reason

Honest current status:

- cTrader is the preferred true XAUUSD spot path.
- cTrader uses the local CLI credential set: trading account, cTID or email, and password.
- Yahoo `GC=F` is shown as `futures_proxy`.
- cTrader snapshot fallback is labeled stale when it is used.
- US2Y may remain unavailable if no reliable source exists.
- CSV is fallback and debug only, not the intended normal path.

### Data Sources

The `Data Sources` panel is a guided setup flow. It shows setup actions plus one backend activity strip for:

- price source
- related assets
- news
- calendar
- local LLM
- Telegram
- monitor loop

The cTrader step lets you:

- save the cTrader CLI credential set into user-data
- run the backend cTrader CLI connection check
- let backend provider policy resolve XAUUSD and context markets automatically
- clear the saved config

Saved cTID and password values remain masked in the UI. The frontend must not display raw secrets after persistence, and symbols are not user-facing setup fields.

The LLM step lets you choose the local analysis mode:

- Auto
- `qwen3.5:4b`
- `qwen3.5:0.8b`
- Rule-based only

LLM is optional. The rule-based evidence gate works when LLM is disabled. LLM is called only after meaningful triggers, recovery summaries, or explicit analysis requests. It is not the source of truth; invalid JSON and blocked-driver claims fall back to guarded rule-based output.

The Monitoring step exposes:

- Run Monitor Once
- Start Monitor Loop
- Stop Monitor Loop
- Backfill & Recover

`Backfill & Recover` calls the explicit recovery command. It detects missed periods through monitor state, reconstructs missed data when possible, and records recovery status in user-data.

### Market Replay

The Market Replay area supports:

- range presets: last 1h, last 4h, today
- custom start and end
- price series summary
- related asset summary
- timeline events
- news items
- calendar events
- driver attention changes
- state transitions
- alerts
- suppressed alerts
- recovery and backfilled markers

Clicking a timeline item, alert, or suppressed alert loads the evidence panel for that run.

Replay keeps the source label honest:

- cTrader rows remain `spot`
- Yahoo rows remain `futures_proxy`
- recovery rows remain `backfilled`

### Evidence Panel

The Evidence Panel renders structured data for the selected monitor run:

- allowed candidate drivers
- blocked drivers
- evidence status
- cross-asset confirmation
- provider health at the run
- driver attention states at the run
- analysis result

The panel is designed to avoid hiding decisions behind raw JSON dumps.

## Backing data

The full Market Agent page reads from:

- `market_agent_timeline.sqlite`
- `market_agent_state.json`
- `market_agent_alerts.ndjson`

If SQLite is missing or incomplete, the UI shows an empty-state message instead of crashing.

The provider configuration panel reads and writes:

- `ctrader-cli.json`
- `ctrader-last-quote.json`

under the app user-data directory.

LLM and Telegram configuration are stored under the app user-data directory:

- `market-agent-llm.json`
- `market-agent-telegram.json`

## Related CLI commands

Run once:

```powershell
python -m src.xauusd_market_agent.cli --monitor-once
```

Run continuously:

```powershell
python -m src.xauusd_market_agent.cli --monitor-loop --interval-seconds 60
```

Run backfill and recovery:

```powershell
python -m src.xauusd_market_agent.cli --backfill-recovery
```

Typical local LLM setup:

```powershell
$env:LOCAL_LLM_ENABLED = "true"
$env:LOCAL_LLM_PROVIDER = "ollama"
$env:LOCAL_LLM_ENDPOINT = "http://localhost:11434"
$env:LOCAL_LLM_MODEL = "qwen3.5:4b"
$env:LOCAL_LLM_TEMPERATURE = "0.1"
$env:LOCAL_LLM_TIMEOUT_SECONDS = "20"
$env:LOCAL_LLM_KEEP_ALIVE = "0"
$env:LOCAL_LLM_MAX_CONTEXT = "8192"
```

The desktop UI defaults to Auto Local AI. It detects Ollama and the local machine profile, recommends `qwen3.5:4b`, `qwen3.5:2b`, `qwen3.5:0.8b`, or rule-based only, and asks before pulling multi-GB models. Ollama installation is still a guided manual step.

Typical cTrader setup before running the CLI directly:

```powershell
$env:CTRADER_ACCOUNT_ID = "123456"
$env:CTRADER_CTID = "name@example.com"
$env:CTRADER_PASSWORD = "your-password"
$env:CTRADER_ENVIRONMENT = "demo"
$env:CTRADER_CONFIG_PATH = "user-data/ctrader-cli.json"
```

The desktop UI defaults to Connect cTrader for the local cTrader CLI path. Users enter trading account, cTID or email, and password; the app saves the credentials under user-data and masks them after save. Backend provider policy handles XAUUSD, related cTrader markets, and fallback sources such as DXY, yields, oil, VIX, SPX, and Nasdaq without asking the user to configure symbols.

Replay a time range:

```powershell
python -m src.xauusd_market_agent.cli --replay --start "2026-05-19T08:00:00+08:00" --end "2026-05-19T18:00:00+08:00"
```

View timeline events:

```powershell
python -m src.xauusd_market_agent.cli --timeline --start "2026-05-19T08:00:00+08:00" --end "2026-05-19T18:00:00+08:00"
```
