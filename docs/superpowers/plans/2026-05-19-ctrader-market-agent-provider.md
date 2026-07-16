# cTrader Market Agent Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement real cTrader Open API spot quote and trendbar backfill support as the preferred XAUUSD provider, with honest fallback to Yahoo `GC=F`, safe token/config handling, Tauri commands, and Market Agent provider configuration UI.

**Architecture:** Use a bridge-based Python cTrader adapter instead of leaving the current provider disabled. The synchronous monitor pipeline keeps its current shape while `CTraderProvider` delegates live quote, symbol resolution, account validation, token refresh, and M1 backfill to a short-lived helper process that uses Spotware’s official Python Open API SDK. Tauri owns user-data config persistence and masking; Python owns runtime provider loading and backfill/provider-router selection.

**Tech Stack:** Python, Spotware `ctrader-open-api` SDK, subprocess bridge, SQLite timeline store, Tauri/Rust commands, React/Vitest, ui-check.

---

### Task 1: Define cTrader config, secret storage, and provider response contract

**Files:**
- Create: `docs/market-agent-providers.md` (update)
- Modify: `src/xauusd_market_agent/config.py`
- Modify: `src/xauusd_market_agent/models.py`
- Modify: `src/xauusd_market_agent/live_pipeline.py`
- Test: `tests/test_ctrader_provider.py`

- [ ] **Step 1: Write the failing config/loading tests**

```python
def test_ctrader_config_loads_from_env_and_json(tmp_path, monkeypatch):
    ...

def test_ctrader_ui_payload_masks_secrets(tmp_path):
    ...

def test_ctrader_missing_config_reports_disabled():
    ...
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_ctrader_provider.py -k "config or masks or disabled" -v`
Expected: FAIL because the current provider only checks four env vars and exposes no structured config/masking helpers.

- [ ] **Step 3: Add minimal config model and evidence fields**

Implement:
- `CTraderOpenApiConfig` dataclass in `config.py`
- env + `user-data/ctrader-openapi.json` + token-store merge
- masked serialization helper for UI/Tauri responses
- live-pipeline evidence packet fields:
  - `selected_market_provider`
  - `provider_chain_status`
  - `fallback_reason`

- [ ] **Step 4: Run targeted tests**

Run: `python -m pytest tests/test_ctrader_provider.py -k "config or masks or disabled" -v`
Expected: PASS

### Task 2: Implement the cTrader bridge protocol and fake-client test seam

**Files:**
- Create: `src/xauusd_market_agent/providers/ctrader_bridge.py`
- Modify: `src/xauusd_market_agent/providers/ctrader_provider.py`
- Test: `tests/test_ctrader_provider.py`

- [ ] **Step 1: Write the failing bridge/provider tests**

```python
def test_ctrader_live_quote_uses_bridge_result_and_writes_snapshot(tmp_path):
    ...

def test_ctrader_symbol_resolution_exact_and_normalized_names():
    ...

def test_ctrader_stale_snapshot_is_not_selected_as_fresh():
    ...
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_ctrader_provider.py -k "live_quote or symbol_resolution or stale_snapshot" -v`
Expected: FAIL because there is no bridge and no real quote/symbol handling.

- [ ] **Step 3: Implement bridge request/response contract**

Implement:
- bridge CLI modes: `test-connection`, `resolve-symbol`, `quote`, `backfill`, `refresh-token`
- official SDK auth flow:
  - `ProtoOAApplicationAuthReq`
  - `ProtoOAGetAccountListByAccessTokenReq`
  - `ProtoOAAccountAuthReq`
- quote flow:
  - symbol resolve
  - `ProtoOASubscribeSpotsReq`
  - wait for `ProtoOASpotEvent`
- snapshot write with `bid`, `ask`, `mid`, `symbol_id`, `environment`

- [ ] **Step 4: Run targeted tests**

Run: `python -m pytest tests/test_ctrader_provider.py -k "live_quote or symbol_resolution or stale_snapshot" -v`
Expected: PASS

### Task 3: Implement cTrader M1 backfill and router priority

**Files:**
- Modify: `src/xauusd_market_agent/providers/ctrader_provider.py`
- Modify: `src/xauusd_market_agent/providers/provider_router.py`
- Modify: `src/xauusd_market_agent/backfill.py`
- Test: `tests/test_ctrader_provider.py`
- Test: `tests/test_provider_router.py`
- Test: `tests/test_backfill.py`

- [ ] **Step 1: Write failing router/backfill tests**

```python
def test_fresh_ctrader_spot_wins_over_yahoo_proxy(tmp_path):
    ...

def test_ctrader_backfill_returns_spot_rows_before_yahoo_proxy(tmp_path):
    ...

def test_provider_chain_status_records_ctrader_failure_then_yahoo_fallback(tmp_path):
    ...
```

- [ ] **Step 2: Run tests to verify failure**

Run: `python -m pytest tests/test_ctrader_provider.py tests/test_provider_router.py tests/test_backfill.py -k "ctrader or provider_chain_status" -v`
Expected: FAIL because router currently treats cTrader as disabled and exposes no fallback chain metadata.

- [ ] **Step 3: Implement provider priority and backfill**

Implement:
- ProviderRouter priority:
  1. cTrader spot
  2. cTrader saved snapshot if explicitly allowed and not too stale
  3. Yahoo `GC=F` proxy
  4. CSV fallback only if enabled
  5. unavailable
- market rows preserve `spot` vs `futures_proxy`
- `provider_chain_status` stored in evidence packet
- backfill uses cTrader M1 trendbars first; Yahoo only on failure

- [ ] **Step 4: Run targeted tests**

Run: `python -m pytest tests/test_ctrader_provider.py tests/test_provider_router.py tests/test_backfill.py -k "ctrader or provider_chain_status" -v`
Expected: PASS

### Task 4: Expose cTrader config/test commands through Tauri

**Files:**
- Modify: `app/tauri/src-tauri/src/commands/market_agent.rs`
- Modify: `app/tauri/src-tauri/src/main.rs`
- Test: `app/tauri/src-tauri/src/commands/market_agent.rs`

- [ ] **Step 1: Write failing Rust command tests**

Add tests for:
- loading provider config from user-data
- masked secret response
- missing config returns `available=false` or disabled status without panic

- [ ] **Step 2: Run Rust tests to verify failure**

Run: `cargo test --manifest-path app/tauri/src-tauri/Cargo.toml market_agent`
Expected: FAIL because config commands do not exist yet.

- [ ] **Step 3: Implement commands**

Implement:
- `get_market_agent_provider_config`
- `save_market_agent_provider_config`
- `test_ctrader_connection`
- `resolve_ctrader_symbol`
- `get_ctrader_quote_test`
- `clear_ctrader_config`

- [ ] **Step 4: Run Rust tests**

Run: `cargo test --manifest-path app/tauri/src-tauri/Cargo.toml market_agent`
Expected: PASS

### Task 5: Add first-class provider configuration UI

**Files:**
- Modify: `app/webui/src/types.ts`
- Modify: `app/webui/src/api.ts`
- Modify: `app/webui/src/App.tsx`
- Modify: `app/webui/src/components/MarketAgentPage.tsx`
- Create: `app/webui/src/components/MarketAgentProviderConfig.tsx`
- Create: `app/webui/src/components/MarketAgentProviderConfig.css`
- Test: `app/webui/src/__tests__/market-agent-page.test.tsx`
- Test: `app/webui/src/__tests__/market-agent-view-switch.test.tsx`

- [ ] **Step 1: Write failing frontend tests**

Add tests for:
- cTrader config panel renders
- masked secrets render as masked values
- Yahoo fallback label remains visible
- test-connection and open-market-agent flows work in mock backend

- [ ] **Step 2: Run frontend tests to verify failure**

Run: `npm --prefix app/webui run test`
Expected: FAIL because the page has no provider config component or commands.

- [ ] **Step 3: Implement the UI**

Implement:
- Data Sources / Provider Health config section under Market Agent
- fields: environment, clientId, clientSecret, accessToken, refreshToken, accountId, symbol, symbolId override, snapshot/token-store paths
- actions: Test Connection, Resolve Symbol, Save Config, Clear Config, Refresh Token, Start Live Quote Test
- explicit status copy for cTrader/yahoo fallback/proxy/stale/unavailable

- [ ] **Step 4: Run frontend tests**

Run: `npm --prefix app/webui run test`
Expected: PASS

### Task 6: Completion verification and docs

**Files:**
- Modify: `docs/market-agent-providers.md`
- Modify: `docs/market-agent-ui.md`
- Modify: `requirements.txt`
- Modify: `.github/workflows/*` only if CI needs explicit dependency/install coverage

- [ ] **Step 1: Update docs**

Document:
- cTrader clientId/clientSecret/accessToken/refreshToken/accountId flow
- no password use/storage
- token-store and config paths
- Yahoo fallback caveat
- startup backfill order
- Windows commands

- [ ] **Step 2: Run full verification**

Run:
- `python -m pytest tests/test_market_move_detector.py tests/test_cross_asset_detector.py tests/test_evidence_gate.py tests/test_state_transition.py tests/test_llm_json_contract.py tests/test_blocked_driver_validation.py tests/test_dry_run_cli.py tests/test_llm_integration.py tests/test_llm_repair.py tests/test_driver_attention.py tests/test_provider_health.py tests/test_timeline_store.py tests/test_yahoo_chart_provider.py tests/test_rss_provider.py tests/test_forex_factory_provider.py tests/test_ctrader_provider.py tests/test_provider_router.py tests/test_backfill.py tests/test_replay_queries.py -v`
- `npm --prefix app/webui run test`
- `npm --prefix app/webui run build`
- `cargo fmt --manifest-path app/tauri/src-tauri/Cargo.toml --check`
- `cargo clippy --manifest-path app/tauri/src-tauri/Cargo.toml -- -D warnings`
- `cargo test --manifest-path app/tauri/src-tauri/Cargo.toml`
- `npm run ui:check`
- `.\app\installer\build_installer.ps1 -RepoRoot (Resolve-Path ".")`

- [ ] **Step 3: Review ui-check screenshots**

Review 5 random Light/Dark screenshots from `app/tests-ui/artifacts/ui-check/` and fix issues before final push if any regression is found.
