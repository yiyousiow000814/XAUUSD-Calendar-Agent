from __future__ import annotations

import json
from pathlib import Path

from .models import CrossAssetSnapshot, Headline, MarketMove, ScenarioFixture

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_FIXTURES_DIR = REPO_ROOT / "tests" / "fixtures" / "market_agent"


def load_scenario_fixture(fixtures_dir: Path, scenario_id: str) -> ScenarioFixture:
    payload = json.loads((fixtures_dir / f"{scenario_id}.json").read_text(encoding="utf-8"))
    return ScenarioFixture(
        scenario_id=payload["scenario_id"],
        as_of_myt=payload["as_of_myt"],
        market=MarketMove.from_dict(payload["market"]),
        cross_asset=CrossAssetSnapshot.from_dict(payload["cross_asset"]),
        calendar_events=tuple(Headline.from_dict(item) for item in payload.get("calendar_events", [])),
        news=tuple(Headline.from_dict(item) for item in payload.get("news", [])),
        expected_llm_claim=payload.get("expected_llm_claim"),
    )


def load_builtin_fixture(scenario_id: str) -> ScenarioFixture:
    return load_scenario_fixture(DEFAULT_FIXTURES_DIR, scenario_id)


def list_builtin_scenarios() -> list[str]:
    return sorted(path.stem for path in DEFAULT_FIXTURES_DIR.glob("*.json"))
