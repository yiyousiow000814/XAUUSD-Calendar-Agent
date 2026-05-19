from datetime import datetime
import json

from src.xauusd_market_agent.config import MarketAgentConfig
from src.xauusd_market_agent.live_pipeline import run_monitor_loop


def test_run_monitor_loop_executes_multiple_iterations_without_crashing(tmp_path) -> None:
    price_path = tmp_path / "prices.csv"
    price_path.write_text(
        "timestamp,open,high,low,close\n"
        "2026-05-19T07:00:00+08:00,4500,4502,4499,4501\n"
        "2026-05-19T07:15:00+08:00,4501,4503,4475,4479\n",
        encoding="utf-8",
    )
    related_path = tmp_path / "related_assets.json"
    related_path.write_text(
        json.dumps({"dxy_percent": 0.22, "us10y_bps": 5.1, "us2y_bps": 4.4}),
        encoding="utf-8",
    )
    year_dir = tmp_path / "calendar" / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text("[]", encoding="utf-8")

    cfg = MarketAgentConfig(
        repo_root=tmp_path,
        price_data_path=price_path,
        calendar_dir=tmp_path / "calendar",
        related_assets_path=related_path,
        rss_feeds=[],
        yahoo_enabled=False,
    )

    outcomes = run_monitor_loop(
        config=cfg,
        interval_seconds=0,
        max_iterations=2,
        anchor_times=[
            datetime.fromisoformat("2026-05-19T07:15:00+08:00"),
            datetime.fromisoformat("2026-05-19T07:15:00+08:00"),
        ],
        state_path=tmp_path / "state.json",
        alerts_path=tmp_path / "alerts.ndjson",
    )

    assert len(outcomes) == 2
    assert outcomes[0]["notification"]["should_notify"] is True
    assert outcomes[1]["notification"]["should_notify"] is False
