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

- cTrader live quote fetching is currently disabled unless explicitly implemented later.
- Yahoo `GC=F` is shown as `futures_proxy`.
- US2Y may remain unavailable if no reliable source is configured.
- CSV is fallback and debug only, not the intended normal path.

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

## Related CLI commands

Run once:

```powershell
python -m src.xauusd_market_agent.cli --monitor-once
```

Run continuously:

```powershell
python -m src.xauusd_market_agent.cli --monitor-loop --interval-seconds 60
```

Replay a time range:

```powershell
python -m src.xauusd_market_agent.cli --replay --start "2026-05-19T08:00:00+08:00" --end "2026-05-19T18:00:00+08:00"
```

View timeline events:

```powershell
python -m src.xauusd_market_agent.cli --timeline --start "2026-05-19T08:00:00+08:00" --end "2026-05-19T18:00:00+08:00"
```
