# XAUUSD Market Situation Agent Phase 1

## Why Phase 1 lives in `src/xauusd_market_agent`

The current repository already contains:

- economic calendar and research-oriented Python scripts under `scripts/`
- a Windows desktop shell under `app/tauri`
- a React UI under `app/webui`

Phase 1 is intentionally implemented as a standalone Python package under `src/xauusd_market_agent` because it needs:

- a stable Windows-native `python -m ... --dry-run` entrypoint
- fixture-driven tests without real APIs
- deterministic logic that can later be reused by CLI, Task Scheduler, or the Tauri backend

This keeps the event-driven market-state logic separate from the existing calendar ETL scripts and avoids coupling Phase 1 to the desktop app too early.

Phase 2 extends the same package with live local-data providers. See [Phase 2](market-situation-agent-phase2.md).

## Phase 1 scope

Included:

- fixture-driven XAUUSD move detection
- deterministic cross-asset confirmation
- evidence gates and blocked-driver generation
- allowed candidate driver generation
- state transition skeleton
- local LLM interface skeleton for Ollama
- strict JSON validation
- blocked-driver rejection
- rule-based fallback analysis
- dry-run text or JSON output

Not included:

- real market data APIs
- real news APIs
- Telegram notifications
- persistent state store
- automatic background scheduling
- Tauri UI integration

## Package layout

- `src/xauusd_market_agent/models.py`: typed dataclasses for fixtures, analysis, and state
- `src/xauusd_market_agent/fixtures.py`: built-in fixture loading
- `src/xauusd_market_agent/detectors.py`: trigger detection
- `src/xauusd_market_agent/evidence.py`: cross-asset confirmation and evidence gates
- `src/xauusd_market_agent/pipeline.py`: deterministic Phase 1 orchestration
- `src/xauusd_market_agent/validator.py`: strict JSON schema and blocked-driver rejection
- `src/xauusd_market_agent/llm_client.py`: optional Ollama client skeleton
- `src/xauusd_market_agent/state.py`: state transition skeleton
- `src/xauusd_market_agent/reporter.py`: user-facing dry-run report formatting
- `src/xauusd_market_agent/cli.py`: `python -m ...` entrypoint

## Built-in scenarios

Fixtures live in `tests/fixtures/market_agent` and include:

- `yield_pressure_confirmed`
- `oil_inflation_pressure`
- `safe_haven_rebound`
- `unconfirmed_move`
- `no_meaningful_change`
- `llm_hallucination_guard`

## Windows commands

List available dry-run scenarios:

```powershell
python -m src.xauusd_market_agent.cli --list-scenarios
```

Run one dry-run scenario as text:

```powershell
python -m src.xauusd_market_agent.cli --dry-run --scenario yield_pressure_confirmed
```

Run one dry-run scenario as JSON:

```powershell
python -m src.xauusd_market_agent.cli --dry-run --scenario unconfirmed_move --format json
```

Run the focused Phase 1 tests:

```powershell
python -m pytest tests/test_fixtures.py tests/test_market_move_detector.py tests/test_cross_asset_detector.py tests/test_evidence_gate.py tests/test_state_transition.py tests/test_llm_json_contract.py tests/test_blocked_driver_validation.py tests/test_dry_run_cli.py -v
```

## Local LLM behavior

Phase 1 does not require Ollama. If Ollama is unavailable or disabled, the pipeline uses the deterministic rule-based path only.

Supported environment variables:

```text
LOCAL_LLM_ENABLED=true
LOCAL_LLM_PROVIDER=ollama
LOCAL_LLM_ENDPOINT=http://localhost:11434
LOCAL_LLM_MODEL=qwen3.5:4b
LOCAL_LLM_TEMPERATURE=0.1
LOCAL_LLM_TIMEOUT_SECONDS=20
LOCAL_LLM_KEEP_ALIVE=0
LOCAL_LLM_MAX_CONTEXT=8192
```

The LLM is not the source of truth. Phase 1 keeps the final guard in `validator.py`, which rejects blocked driver claims and falls back to conservative output. The desktop setup can recommend and pull `qwen3.5` profiles after user approval when Ollama is already installed; Ollama installation itself remains a guided manual step.
