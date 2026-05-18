# XAUUSD Market Situation Agent Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent market state, anti-spam notification policy, and a local notification sink so the market situation agent can decide whether to emit a meaningful alert across repeated live runs.

**Architecture:** Keep Phase 3 in `src/xauusd_market_agent` and build on the existing live pipeline. Introduce a JSON-backed state store, a deterministic notification policy that compares the current analysis against persisted state, and a local notification sink that writes alert records to disk. This keeps the notification path Windows-native and local-first while avoiding Telegram-specific coupling.

**Tech Stack:** Python 3, `pathlib`, `json`, `datetime`, `dataclasses`, `pytest`

---

### Task 1: Add persistent state store

**Files:**
- Create: `src/xauusd_market_agent/state_store.py`
- Create: `tests/test_state_store.py`

- [ ] **Step 1: Write the failing state-store test**

```python
from src.xauusd_market_agent.state_store import JsonStateStore
from src.xauusd_market_agent.state import empty_market_state


def test_json_state_store_round_trips_market_state(tmp_path):
    store = JsonStateStore(tmp_path / "state.json")
    state = empty_market_state(main_driver="yields", current_bias="bearish_gold")
    store.save(state)

    loaded = store.load()

    assert loaded.main_driver == "yields"
    assert loaded.current_bias == "bearish_gold"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_state_store.py -v`
Expected: FAIL because state store module does not exist.

- [ ] **Step 3: Write minimal JSON state store**

```python
class JsonStateStore:
    def load(self) -> MarketState: ...
    def save(self, state: MarketState) -> None: ...
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_state_store.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/xauusd_market_agent/state_store.py tests/test_state_store.py
git commit -m "feat: add persistent market state store"
```

### Task 2: Add anti-spam notification policy

**Files:**
- Create: `src/xauusd_market_agent/notification_policy.py`
- Create: `tests/test_notification_policy.py`

- [ ] **Step 1: Write the failing policy tests**

```python
from src.xauusd_market_agent.notification_policy import decide_notification
from src.xauusd_market_agent.state import empty_market_state
from src.xauusd_market_agent.fixtures import load_builtin_fixture


def test_notification_policy_suppresses_same_state_inside_cooldown():
    previous = empty_market_state(main_driver="yields", current_bias="bearish_gold")
    previous = previous.__class__(**{**previous.__dict__, "last_alert_time": "2026-05-19T00:00:00+08:00"})
    result = load_builtin_fixture("yield_pressure_confirmed").expected_rule_based_result

    decision = decide_notification(
        previous_state=previous,
        analysis_result=result,
        now_iso="2026-05-19T00:05:00+08:00",
        cooldown_minutes=30,
    )

    assert decision.should_notify is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_notification_policy.py -v`
Expected: FAIL because policy module does not exist.

- [ ] **Step 3: Write minimal cooldown/state-change policy**

```python
def decide_notification(previous_state, analysis_result, now_iso, cooldown_minutes):
    ...
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_notification_policy.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/xauusd_market_agent/notification_policy.py tests/test_notification_policy.py
git commit -m "feat: add anti-spam notification policy"
```

### Task 3: Add local notification sink and integrate live runs

**Files:**
- Create: `src/xauusd_market_agent/notifier.py`
- Modify: `src/xauusd_market_agent/config.py`
- Modify: `src/xauusd_market_agent/live_pipeline.py`
- Modify: `src/xauusd_market_agent/cli.py`
- Create: `tests/test_notifier.py`
- Create: `tests/test_live_monitor_run.py`

- [ ] **Step 1: Write the failing notifier tests**

```python
from src.xauusd_market_agent.notifier import FileNotificationSink


def test_file_notification_sink_appends_alert_record(tmp_path):
    sink = FileNotificationSink(tmp_path / "alerts.ndjson")
    sink.emit({"message": "test"})

    text = (tmp_path / "alerts.ndjson").read_text(encoding="utf-8")
    assert '"message": "test"' in text
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_notifier.py tests/test_live_monitor_run.py -v`
Expected: FAIL because notifier/live monitor integration does not exist.

- [ ] **Step 3: Write minimal notifier and one-shot monitored live run**

```python
def run_monitored_live_once(...):
    previous = store.load()
    fixture, analysis = run_live_once(...)
    decision = decide_notification(...)
    if decision.should_notify:
        sink.emit(...)
    store.save(...)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_notifier.py tests/test_live_monitor_run.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/xauusd_market_agent/notifier.py src/xauusd_market_agent/config.py src/xauusd_market_agent/live_pipeline.py src/xauusd_market_agent/cli.py tests/test_notifier.py tests/test_live_monitor_run.py
git commit -m "feat: add local monitored live run"
```

### Task 4: Verify and document monitored mode

**Files:**
- Modify: `docs/market-situation-agent-phase2.md`
- Create: `docs/market-situation-agent-phase3.md`

- [ ] **Step 1: Document monitored commands**

```markdown
python -m src.xauusd_market_agent.cli --monitor-once --format json
```

- [ ] **Step 2: Run Python tests**

Run: `python -m pytest tests -v`
Expected: PASS

- [ ] **Step 3: Run monitored live mode**

Run: `python -m src.xauusd_market_agent.cli --monitor-once --format json`
Expected: PASS and write local state/alert artifacts.

- [ ] **Step 4: Run Web UI checks**

Run: `npm --prefix app/webui ci`
Expected: PASS

Run: `npm --prefix app/webui run test`
Expected: PASS

Run: `npm --prefix app/webui run build`
Expected: PASS

- [ ] **Step 5: Rebuild installer**

Run: `.\app\installer\build_installer.ps1`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add docs/market-situation-agent-phase2.md docs/market-situation-agent-phase3.md
git commit -m "docs: add monitored live mode guide"
```
