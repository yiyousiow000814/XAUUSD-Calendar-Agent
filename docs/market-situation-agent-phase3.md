# XAUUSD Market Situation Agent Phase 3

## What Phase 3 adds

Phase 3 turns the live local analysis path into a stateful monitored pass:

- persistent market state stored as JSON
- anti-spam notification policy with cooldown
- local alert sink written as NDJSON
- `--monitor-once` CLI mode

This keeps the notification path local and Windows-native. No cloud service or background daemon is required in this phase.

## New modules

- `src/xauusd_market_agent/state_store.py`: JSON-backed market state persistence
- `src/xauusd_market_agent/notification_policy.py`: deterministic cooldown and state-change logic
- `src/xauusd_market_agent/notifier.py`: local alert sink

## Monitored command

Run one monitored local pass:

```powershell
python -m src.xauusd_market_agent.cli --monitor-once
```

Run one monitored local pass as JSON:

```powershell
python -m src.xauusd_market_agent.cli --monitor-once --format json
```

Run the local monitor loop:

```powershell
python -m src.xauusd_market_agent.cli --monitor-loop --interval-seconds 60
```

Run one bounded loop for testing:

```powershell
python -m src.xauusd_market_agent.cli --monitor-loop --interval-seconds 0 --max-iterations 1
```

Use a fixed anchor time:

```powershell
python -m src.xauusd_market_agent.cli --monitor-once --format json --anchor-time 2026-05-19T07:15:00+08:00
```

## New environment knobs

```text
MARKET_AGENT_STATE_STORE_PATH=...
MARKET_AGENT_ALERTS_OUTPUT_PATH=...
MARKET_AGENT_NOTIFICATION_COOLDOWN_MINUTES=30
```

Default outputs:

- state: `user-data/market_agent_state.json`
- alerts: `user-data/market_agent_alerts.ndjson`

Optional Telegram delivery:

```text
MARKET_AGENT_TELEGRAM_ENABLED=true
MARKET_AGENT_TELEGRAM_BOT_TOKEN=...
MARKET_AGENT_TELEGRAM_CHAT_ID=...
MARKET_AGENT_TELEGRAM_TIMEOUT_SECONDS=10
```

Behavior:

- local file alerts remain the primary sink
- Telegram is an additional sink
- missing Telegram config does not break monitored runs

## Current behavior

- repeated same-state alerts are suppressed inside cooldown
- state-changing alerts can still emit inside cooldown
- each monitored run updates persistent state even when no alert is emitted

## Current limitations

- Phase 3 does not yet expose detailed state-transition reasons
- invalidation tracking is still basic in this phase
- Phase 4 adds richer state-transition metadata and invalidation tracing
