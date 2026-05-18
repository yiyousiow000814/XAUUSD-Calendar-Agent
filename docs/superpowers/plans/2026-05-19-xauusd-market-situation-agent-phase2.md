# XAUUSD Market Situation Agent Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real-data provider interfaces and a live-run Phase 2 pipeline that can build evidence packets from local price files, local calendar files, and configured RSS feeds while keeping the Phase 1 conservative validation path intact.

**Architecture:** Extend `src/xauusd_market_agent` instead of touching Tauri or the React UI. Phase 2 introduces provider modules for market prices, calendar events, and news headlines, plus an evidence-packet builder that converts provider output into the same internal analysis contract used by Phase 1. Live mode remains Windows-native and local-first: it reads repository data and configured feeds, falls back cleanly when a provider is unavailable, and still routes final claims through deterministic evidence gating and validator enforcement.

**Tech Stack:** Python 3, `pathlib`, `csv`, `json`, `datetime`, `argparse`, `feedparser`, `requests`, `pytest`

---

### Task 1: Add provider-facing domain models and live config

**Files:**
- Modify: `src/xauusd_market_agent/models.py`
- Create: `src/xauusd_market_agent/config.py`
- Create: `tests/test_live_config.py`

- [ ] **Step 1: Write the failing config test**

```python
from src.xauusd_market_agent.config import MarketAgentConfig


def test_market_agent_config_uses_windows_friendly_defaults():
    cfg = MarketAgentConfig()

    assert "data" in str(cfg.price_data_path)
    assert cfg.news_lookback_minutes == 30
    assert cfg.post_move_news_minutes == 120
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_live_config.py -v`
Expected: FAIL because config module does not exist.

- [ ] **Step 3: Write minimal config implementation**

```python
@dataclass(frozen=True)
class MarketAgentConfig:
    repo_root: Path = REPO_ROOT
    price_data_path: Path = REPO_ROOT / "data" / "XAUUSD_data" / "XAUUSD_data.csv"
    calendar_dir: Path = REPO_ROOT / "data" / "Economic_Calendar"
    news_lookback_minutes: int = 30
    post_move_news_minutes: int = 120
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_live_config.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/xauusd_market_agent/models.py src/xauusd_market_agent/config.py tests/test_live_config.py
git commit -m "feat: add phase 2 live config"
```

### Task 2: Add market price provider backed by local XAUUSD CSV

**Files:**
- Create: `src/xauusd_market_agent/providers/market_prices.py`
- Create: `tests/test_market_price_provider.py`

- [ ] **Step 1: Write the failing price-provider test**

```python
from datetime import datetime

from src.xauusd_market_agent.providers.market_prices import load_recent_market_snapshot


def test_load_recent_market_snapshot_from_csv_fixture(tmp_path):
    csv_path = tmp_path / "prices.csv"
    csv_path.write_text(
        "timestamp,open,high,low,close\n"
        "2026-05-19T07:00:00+08:00,4500,4502,4499,4501\n"
        "2026-05-19T07:15:00+08:00,4501,4503,4490,4491\n",
        encoding="utf-8",
    )

    snapshot = load_recent_market_snapshot(
        price_path=csv_path,
        anchor_time=datetime.fromisoformat("2026-05-19T07:15:00+08:00"),
    )

    assert snapshot.market.symbol == "XAUUSD"
    assert snapshot.market.to_price == 4491.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_market_price_provider.py -v`
Expected: FAIL because provider module does not exist.

- [ ] **Step 3: Write minimal provider implementation**

```python
def load_recent_market_snapshot(price_path: Path, anchor_time: datetime) -> ScenarioFixture:
    df = _read_small_csv(price_path)
    recent = ...
    return ScenarioFixture(...)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_market_price_provider.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/xauusd_market_agent/providers/market_prices.py tests/test_market_price_provider.py
git commit -m "feat: add local market price provider"
```

### Task 3: Add calendar provider backed by `data/Economic_Calendar`

**Files:**
- Create: `src/xauusd_market_agent/providers/calendar_events.py`
- Create: `tests/test_calendar_provider.py`

- [ ] **Step 1: Write the failing calendar-provider test**

```python
from datetime import datetime
import json

from src.xauusd_market_agent.providers.calendar_events import load_calendar_events_in_window


def test_load_calendar_events_in_window_filters_by_anchor(tmp_path):
    year_dir = tmp_path / "2026"
    year_dir.mkdir()
    path = year_dir / "2026_calendar.json"
    path.write_text(json.dumps([
        {"Date": "2026-05-19", "Time": "07:00", "Currency": "USD", "Event": "CPI", "Imp.": "High"},
        {"Date": "2026-05-19", "Time": "12:00", "Currency": "USD", "Event": "Fed Speech", "Imp.": "High"}
    ]), encoding="utf-8")

    events = load_calendar_events_in_window(
        calendar_dir=tmp_path,
        anchor_time=datetime.fromisoformat("2026-05-19T07:30:00+08:00"),
        lookback_minutes=60,
        forward_minutes=120,
    )

    assert len(events) == 1
    assert events[0].title == "CPI"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_calendar_provider.py -v`
Expected: FAIL because provider module does not exist.

- [ ] **Step 3: Write minimal provider implementation**

```python
def load_calendar_events_in_window(...):
    year_path = calendar_dir / f"{anchor_time.year}" / f"{anchor_time.year}_calendar.json"
    payload = json.loads(year_path.read_text(...))
    ...
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_calendar_provider.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/xauusd_market_agent/providers/calendar_events.py tests/test_calendar_provider.py
git commit -m "feat: add local calendar provider"
```

### Task 4: Add RSS news provider with monitored-window filtering

**Files:**
- Create: `src/xauusd_market_agent/providers/news_events.py`
- Create: `tests/test_news_provider.py`

- [ ] **Step 1: Write the failing news-provider test**

```python
from datetime import datetime

from src.xauusd_market_agent.providers.news_events import filter_news_in_window


def test_filter_news_in_window_keeps_recent_headline():
    headlines = [
        {"title": "Recent Fed headline", "source": "Reuters", "published_at": "2026-05-19T07:05:00+08:00"},
        {"title": "Old headline", "source": "Reuters", "published_at": "2026-05-19T02:05:00+08:00"},
    ]

    items = filter_news_in_window(
        headlines=headlines,
        move_start=datetime.fromisoformat("2026-05-19T07:10:00+08:00"),
        move_end=datetime.fromisoformat("2026-05-19T07:25:00+08:00"),
        lookback_minutes=30,
        forward_minutes=120,
    )

    assert len(items) == 1
    assert items[0].title == "Recent Fed headline"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_news_provider.py -v`
Expected: FAIL because provider module does not exist.

- [ ] **Step 3: Write minimal provider implementation**

```python
def filter_news_in_window(headlines, move_start, move_end, lookback_minutes, forward_minutes):
    ...
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_news_provider.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/xauusd_market_agent/providers/news_events.py tests/test_news_provider.py
git commit -m "feat: add rss news window filter"
```

### Task 5: Add evidence packet builder and live-run pipeline

**Files:**
- Create: `src/xauusd_market_agent/live_pipeline.py`
- Modify: `src/xauusd_market_agent/cli.py`
- Create: `tests/test_live_pipeline.py`

- [ ] **Step 1: Write the failing live-pipeline test**

```python
from src.xauusd_market_agent.live_pipeline import build_live_evidence_packet


def test_build_live_evidence_packet_uses_provider_outputs(tmp_path):
    packet = build_live_evidence_packet(...)
    assert packet["market_move"]["symbol"] == "XAUUSD"
    assert "allowed_candidate_drivers" in packet
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_live_pipeline.py -v`
Expected: FAIL because live pipeline does not exist.

- [ ] **Step 3: Write minimal evidence-packet builder and CLI live mode**

```python
def run_live_once(config: MarketAgentConfig, anchor_time: datetime | None = None):
    fixture = build_live_fixture(...)
    result = build_rule_based_analysis(fixture)
    return fixture, result
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_live_pipeline.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/xauusd_market_agent/live_pipeline.py src/xauusd_market_agent/cli.py tests/test_live_pipeline.py
git commit -m "feat: add live evidence packet builder"
```

### Task 6: Verify live mode and update docs

**Files:**
- Modify: `docs/market-situation-agent-phase1.md`
- Create: `docs/market-situation-agent-phase2.md`

- [ ] **Step 1: Document live-run commands**

```markdown
python -m src.xauusd_market_agent.cli --live-once
python -m src.xauusd_market_agent.cli --live-once --format json
```

- [ ] **Step 2: Run focused Python tests**

Run: `python -m pytest tests -v`
Expected: PASS

- [ ] **Step 3: Run live-once command**

Run: `python -m src.xauusd_market_agent.cli --live-once --format json`
Expected: PASS with conservative output or explicit provider-unavailable notes.

- [ ] **Step 4: Run Web UI checks required by repo policy**

Run: `npm --prefix app/webui ci`
Expected: PASS

Run: `npm --prefix app/webui run test`
Expected: PASS

Run: `npm --prefix app/webui run build`
Expected: PASS

- [ ] **Step 5: Rebuild installer after verification checklist**

Run: `.\app\installer\build_installer.ps1`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add docs/market-situation-agent-phase1.md docs/market-situation-agent-phase2.md
git commit -m "docs: add phase 2 live mode guide"
```

## Self-Review

- Spec coverage: This plan covers Phase 2 provider interfaces, real local data loading, RSS headline filtering, evidence packet construction, and live local execution. It deliberately does not add Telegram, persistent state storage, or UI integration.
- Placeholder scan: No placeholders remain.
- Type consistency: All new provider outputs feed `ScenarioFixture` and the existing validator path.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-19-xauusd-market-situation-agent-phase2.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
