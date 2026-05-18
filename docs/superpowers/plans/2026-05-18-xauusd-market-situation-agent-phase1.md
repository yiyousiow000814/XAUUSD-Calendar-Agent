# XAUUSD Market Situation Agent Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fixture-driven, Windows-native Phase 1 market situation pipeline that detects meaningful XAUUSD moves, applies deterministic evidence gates, validates local-LLM output, and emits dry-run reports without requiring real APIs, Telegram, Docker, WSL2, or Ollama.

**Architecture:** Keep Phase 1 as a new Python package under `src/xauusd_market_agent` instead of extending the existing `scripts/calendar` workflow files. The current repo already has data-processing scripts and a Tauri desktop app, but no reusable Python package for stateful market-situation analysis. A dedicated package gives a stable `python -m ... --dry-run` entrypoint, isolates the event-driven logic from the calendar ETL scripts, and leaves a clean integration seam for Phase 2/3 connectors and later Tauri wiring.

**Tech Stack:** Python 3, `dataclasses`, `pathlib`, `json`, `argparse`, `pytest`

---

### Task 1: Scaffold the Phase 1 package and fixture loader

**Files:**
- Create: `src/xauusd_market_agent/__init__.py`
- Create: `src/xauusd_market_agent/models.py`
- Create: `src/xauusd_market_agent/fixtures.py`
- Create: `tests/test_fixtures.py`

- [ ] **Step 1: Write the failing fixture-loading test**

```python
from pathlib import Path

from xauusd_market_agent.fixtures import load_scenario_fixture


def test_load_scenario_fixture_returns_named_scenario():
    fixture = load_scenario_fixture(
        Path("tests/fixtures/market_agent"),
        "yield_pressure_confirmed",
    )

    assert fixture.scenario_id == "yield_pressure_confirmed"
    assert fixture.market.symbol == "XAUUSD"
    assert fixture.market.move_percent == -0.48
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_fixtures.py -v`
Expected: FAIL with `ModuleNotFoundError` or missing fixture loader.

- [ ] **Step 3: Write minimal package models and fixture loader**

```python
from dataclasses import dataclass
from pathlib import Path
import json


@dataclass(frozen=True)
class MarketMove:
    symbol: str
    move_percent: float


@dataclass(frozen=True)
class ScenarioFixture:
    scenario_id: str
    market: MarketMove


def load_scenario_fixture(fixtures_dir: Path, scenario_id: str) -> ScenarioFixture:
    payload = json.loads((fixtures_dir / f"{scenario_id}.json").read_text(encoding="utf-8"))
    return ScenarioFixture(
        scenario_id=payload["scenario_id"],
        market=MarketMove(**payload["market"]),
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_fixtures.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/xauusd_market_agent tests/test_fixtures.py tests/fixtures/market_agent
git commit -m "feat: scaffold market situation agent fixtures"
```

### Task 2: Implement deterministic trigger detection

**Files:**
- Create: `src/xauusd_market_agent/detectors.py`
- Create: `tests/test_market_move_detector.py`

- [ ] **Step 1: Write the failing trigger test**

```python
from xauusd_market_agent.detectors import detect_market_trigger
from xauusd_market_agent.fixtures import sample_market_snapshot


def test_detect_market_trigger_flags_large_15m_drop():
    trigger = detect_market_trigger(
        sample_market_snapshot(
            move_percent_15m=-0.48,
            move_percent_1h=-0.62,
        )
    )

    assert trigger.triggered is True
    assert "move_15m" in trigger.trigger_types
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_market_move_detector.py -v`
Expected: FAIL because detector is missing.

- [ ] **Step 3: Write minimal detector implementation**

```python
def detect_market_trigger(snapshot, thresholds=None):
    thresholds = thresholds or {"xau_move_15m_pct": 0.35, "xau_move_1h_pct": 0.7}
    trigger_types = []
    if abs(snapshot.market.move_percent_15m) >= thresholds["xau_move_15m_pct"]:
        trigger_types.append("move_15m")
    if abs(snapshot.market.move_percent_1h) >= thresholds["xau_move_1h_pct"]:
        trigger_types.append("move_1h")
    return TriggerDecision(triggered=bool(trigger_types), trigger_types=trigger_types)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_market_move_detector.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/xauusd_market_agent/detectors.py tests/test_market_move_detector.py
git commit -m "feat: add deterministic market trigger detector"
```

### Task 3: Implement cross-asset confirmation and evidence gates

**Files:**
- Create: `src/xauusd_market_agent/evidence.py`
- Create: `tests/test_cross_asset_detector.py`
- Create: `tests/test_evidence_gate.py`

- [ ] **Step 1: Write the failing evidence-gate tests**

```python
from xauusd_market_agent.evidence import build_evidence_gate_result
from xauusd_market_agent.fixtures import load_builtin_fixture


def test_yield_pressure_scenario_allows_usd_and_yields():
    result = build_evidence_gate_result(load_builtin_fixture("yield_pressure_confirmed"))

    assert "usd" in result.allowed_candidate_drivers
    assert "yields" in result.allowed_candidate_drivers
    assert "geopolitics" in result.blocked_drivers


def test_unconfirmed_scenario_blocks_macro_drivers():
    result = build_evidence_gate_result(load_builtin_fixture("unconfirmed_move"))

    assert result.allowed_candidate_drivers == ["technical_liquidation", "unknown"]
    assert "usd" in result.blocked_drivers
    assert "yields" in result.blocked_drivers
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_cross_asset_detector.py tests/test_evidence_gate.py -v`
Expected: FAIL because evidence module is missing.

- [ ] **Step 3: Write minimal cross-asset and gate logic**

```python
def build_evidence_gate_result(snapshot):
    allowed = []
    blocked = {}

    if snapshot.cross_asset.dxy_confirms:
        allowed.append("usd")
    else:
        blocked["usd"] = "DXY did not confirm the XAUUSD move."

    if snapshot.cross_asset.yields_confirm:
        allowed.append("yields")
    else:
        blocked["yields"] = "US10Y and US2Y did not confirm."

    if snapshot.cross_asset.oil_inflation_confirms:
        allowed.append("oil_inflation")
    else:
        blocked["oil_inflation"] = "Oil move or inflation chain did not confirm."

    if snapshot.cross_asset.risk_sentiment_confirms:
        allowed.append("risk_sentiment")
    else:
        blocked["risk_sentiment"] = "Risk sentiment proxies did not confirm."

    if snapshot.news.has_geopolitical_headline:
        allowed.append("geopolitics")
    else:
        blocked["geopolitics"] = "No timestamped geopolitical headline in the monitored window."

    if not allowed:
        allowed.extend(["technical_liquidation", "unknown"])

    return EvidenceGateResult(allowed_candidate_drivers=allowed, blocked_drivers=blocked)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_cross_asset_detector.py tests/test_evidence_gate.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/xauusd_market_agent/evidence.py tests/test_cross_asset_detector.py tests/test_evidence_gate.py
git commit -m "feat: add cross-asset evidence gate logic"
```

### Task 4: Implement state transition and suppression skeleton

**Files:**
- Create: `src/xauusd_market_agent/state.py`
- Create: `tests/test_state_transition.py`

- [ ] **Step 1: Write the failing state-transition tests**

```python
from xauusd_market_agent.state import apply_state_transition, empty_market_state
from xauusd_market_agent.fixtures import load_builtin_fixture


def test_state_changes_when_main_driver_changes():
    previous = empty_market_state(main_driver="yields", current_bias="bearish_gold")
    analysis = load_builtin_fixture("safe_haven_rebound")

    transition = apply_state_transition(previous, analysis.expected_output)

    assert transition.next_state.main_driver == "risk_sentiment"
    assert transition.should_notify is True
    assert transition.is_new_state is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_state_transition.py -v`
Expected: FAIL because state module is missing.

- [ ] **Step 3: Write minimal state comparison logic**

```python
def apply_state_transition(previous_state, analysis):
    changed = (
        previous_state.main_driver != analysis.main_driver
        or previous_state.current_bias != analysis.bias
    )
    return TransitionResult(
        next_state=MarketState(...),
        is_new_state=changed,
        should_notify=changed and analysis.should_notify,
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_state_transition.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/xauusd_market_agent/state.py tests/test_state_transition.py
git commit -m "feat: add market state transition skeleton"
```

### Task 5: Implement local LLM contract, validation, and fallback

**Files:**
- Create: `src/xauusd_market_agent/llm_client.py`
- Create: `src/xauusd_market_agent/validator.py`
- Create: `tests/test_llm_json_contract.py`
- Create: `tests/test_blocked_driver_validation.py`

- [ ] **Step 1: Write the failing validator tests**

```python
from xauusd_market_agent.validator import validate_llm_output


def test_validator_rejects_blocked_driver_claim():
    validated = validate_llm_output(
        llm_payload={"main_driver": "fed_rates", "bias": "bearish_gold"},
        allowed_candidate_drivers=["technical_liquidation", "unknown"],
        blocked_drivers={"fed_rates": "No Fed headline and yields did not confirm."},
    )

    assert validated.main_driver == "unknown"
    assert validated.rejected_driver == "fed_rates"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_llm_json_contract.py tests/test_blocked_driver_validation.py -v`
Expected: FAIL because validator is missing.

- [ ] **Step 3: Write minimal validator and Ollama skeleton**

```python
def validate_llm_output(llm_payload, allowed_candidate_drivers, blocked_drivers):
    driver = llm_payload.get("main_driver", "unknown")
    if driver not in allowed_candidate_drivers:
        return ValidationResult(
            main_driver="unknown",
            rejected_driver=driver,
            rejection_reason=blocked_drivers.get(driver, "Driver not allowed."),
        )
    return ValidationResult(main_driver=driver, rejected_driver=None, rejection_reason=None)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_llm_json_contract.py tests/test_blocked_driver_validation.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/xauusd_market_agent/llm_client.py src/xauusd_market_agent/validator.py tests/test_llm_json_contract.py tests/test_blocked_driver_validation.py
git commit -m "feat: add local llm contract validation"
```

### Task 6: Implement end-to-end dry-run reporter and scenario fixtures

**Files:**
- Create: `src/xauusd_market_agent/reporter.py`
- Create: `src/xauusd_market_agent/cli.py`
- Create: `tests/fixtures/market_agent/*.json`
- Create: `tests/test_dry_run_cli.py`

- [ ] **Step 1: Write the failing dry-run test**

```python
from xauusd_market_agent.cli import run_dry_scenario


def test_dry_run_returns_unconfirmed_report_for_unconfirmed_scenario():
    result = run_dry_scenario("unconfirmed_move")

    assert "No confirmed macro/news driver found." in result.user_message
    assert result.notification_level == "none"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_dry_run_cli.py -v`
Expected: FAIL because CLI is missing.

- [ ] **Step 3: Write minimal reporter and CLI**

```python
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--scenario", default="yield_pressure_confirmed")
    args = parser.parse_args()
    if args.dry_run:
        print(run_dry_scenario(args.scenario).render_text())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_dry_run_cli.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/xauusd_market_agent/reporter.py src/xauusd_market_agent/cli.py tests/fixtures/market_agent tests/test_dry_run_cli.py
git commit -m "feat: add dry-run situation reporting"
```

### Task 7: Full verification and Windows command documentation

**Files:**
- Modify: `README.md`
- Create: `docs/market-situation-agent-phase1.md`

- [ ] **Step 1: Document the Windows-native Phase 1 commands**

```markdown
python -m pytest tests/test_market_move_detector.py tests/test_cross_asset_detector.py tests/test_evidence_gate.py tests/test_state_transition.py tests/test_llm_json_contract.py tests/test_blocked_driver_validation.py tests/test_dry_run_cli.py
python -m src.xauusd_market_agent.cli --dry-run --scenario yield_pressure_confirmed
```

- [ ] **Step 2: Run Python test suite**

Run: `python -m pytest`
Expected: PASS

- [ ] **Step 3: Run web UI checks already required by repo policy**

Run: `npm --prefix app/webui ci`
Expected: PASS

Run: `npm --prefix app/webui run test`
Expected: PASS

Run: `npm --prefix app/webui run build`
Expected: PASS

- [ ] **Step 4: Run repo UI check after UI changes only**

Run: `npm run ui:check`
Expected: PASS when UI files changed; skip for Python-only Phase 1.

- [ ] **Step 5: Rebuild installer after verification checklist**

Run: `.\app\installer\build_installer.ps1`
Expected: PASS and installer EXEs regenerated locally without being committed.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/market-situation-agent-phase1.md
git commit -m "docs: document market situation agent phase 1"
```

## Self-Review

- Spec coverage: This plan covers mock fixtures, trigger detection, cross-asset gating, blocked-driver enforcement, local-LLM skeleton, strict validation, state transition skeleton, dry-run reporting, and Windows-native commands. It intentionally leaves real connectors, Telegram delivery, persistent state storage, and Tauri wiring to later phases.
- Placeholder scan: No `TODO` placeholders remain.
- Type consistency: The plan uses one package root (`xauusd_market_agent`) and keeps dry-run, evidence, validator, and state components under that package.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-18-xauusd-market-situation-agent-phase1.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
