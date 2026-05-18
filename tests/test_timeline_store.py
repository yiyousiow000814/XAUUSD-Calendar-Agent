from datetime import datetime
import json
import sqlite3

from src.xauusd_market_agent.config import MarketAgentConfig
from src.xauusd_market_agent.live_pipeline import run_monitored_live_once
from src.xauusd_market_agent.timeline_store import TimelineStore


def test_every_monitor_run_persists_even_when_alert_is_suppressed(tmp_path) -> None:
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
        timeline_store_path=tmp_path / "timeline.sqlite",
    )

    first = run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T07:15:00+08:00"),
        state_path=tmp_path / "state.json",
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=tmp_path / "timeline.sqlite",
    )
    second = run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T07:15:00+08:00"),
        state_path=tmp_path / "state.json",
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=tmp_path / "timeline.sqlite",
    )

    with sqlite3.connect(tmp_path / "timeline.sqlite") as connection:
        run_count = connection.execute("SELECT COUNT(*) FROM monitor_runs").fetchone()[0]
        no_news_found = connection.execute(
            "SELECT no_news_found FROM monitor_runs ORDER BY id DESC LIMIT 1"
        ).fetchone()[0]

    assert first["notification"]["should_notify"] is True
    assert second["notification"]["should_notify"] is False
    assert run_count == 2
    assert no_news_found == 1


def test_recovery_run_is_stored_with_backfilled_mode(tmp_path) -> None:
    store = TimelineStore(tmp_path / "timeline.sqlite")
    first_run_id = store.record_monitor_run(
        run_started_at="2026-05-19T00:00:00+08:00",
        run_type="live",
        data_mode="live_seen",
        backfill_required=False,
        last_successful_run_at=None,
        no_news_found=False,
        alert_suppressed_reason="",
    )
    store.record_timeline_event(
        first_run_id,
        event_time="2026-05-19T00:00:00+08:00",
        event_type="analysis",
        label="yields",
        payload={"run_type": "live"},
    )
    recovery_run_id = store.record_monitor_run(
        run_started_at="2026-05-19T08:30:00+08:00",
        run_type="recovery",
        data_mode="backfilled",
        backfill_required=True,
        last_successful_run_at="2026-05-19T00:00:00+08:00",
        no_news_found=True,
        alert_suppressed_reason="Recovered gap without alert.",
    )
    store.record_timeline_event(
        recovery_run_id,
        event_time="2026-05-19T08:30:00+08:00",
        event_type="recovery_analysis",
        label="backfill",
        payload={"data_mode": "backfilled"},
    )

    with sqlite3.connect(tmp_path / "timeline.sqlite") as connection:
        row = connection.execute(
            "SELECT run_type, data_mode, backfill_required FROM monitor_runs WHERE id = ?",
            (recovery_run_id,),
        ).fetchone()

    timeline = store.get_timeline("2026-05-19T08:00:00+08:00", "2026-05-19T09:00:00+08:00")

    assert row == ("recovery", "backfilled", 1)
    assert timeline[0]["event_type"] == "recovery_analysis"


def test_rejected_llm_driver_is_stored_in_analysis_results(tmp_path) -> None:
    class FakeBlockedLLM:
        def analyze(self, evidence_packet):
            return {
                "bias": "bearish_gold",
                "main_driver": "fed_rates",
                "secondary_driver": None,
                "cause_status": "possible",
                "confidence": "medium",
                "is_new_state": True,
                "is_continuation": False,
                "previous_state_invalidated": False,
                "should_notify": True,
                "notification_level": "level_2",
                "no_news_found": True,
                "allowed_candidate_drivers_used": ["fed_rates"],
                "rejected_or_blocked_drivers_acknowledged": False,
                "timeline": [],
                "cross_asset_confirmation": {
                    "dxy": "neutral",
                    "us10y": "neutral",
                    "us2y": "neutral",
                    "oil": "neutral",
                    "vix_equities": "neutral",
                },
                "evidence_status": {
                    "dxy": "not_confirming",
                    "us10y": "not_confirming",
                    "us2y": "not_confirming",
                    "oil": "not_confirming",
                    "vix_equities": "not_confirming",
                    "news": "no_relevant_news_found",
                },
                "causal_chain": "Fed pressure likely drove gold lower.",
                "invalidation_conditions": [],
                "user_message": "Fed pressure hit gold.",
            }

    price_path = tmp_path / "prices.csv"
    price_path.write_text(
        "timestamp,open,high,low,close\n"
        "2026-05-19T07:00:00+08:00,4500,4502,4499,4501\n"
        "2026-05-19T07:15:00+08:00,4501,4503,4475,4479\n",
        encoding="utf-8",
    )
    related_path = tmp_path / "related_assets.json"
    related_path.write_text(
        json.dumps({"dxy_percent": 0.0, "us10y_bps": 0.0, "us2y_bps": 0.0}),
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
        timeline_store_path=tmp_path / "timeline.sqlite",
    )

    run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T07:15:00+08:00"),
        state_path=tmp_path / "state.json",
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=tmp_path / "timeline.sqlite",
        llm_client=FakeBlockedLLM(),
    )

    with sqlite3.connect(tmp_path / "timeline.sqlite") as connection:
        row = connection.execute(
            "SELECT rejected_driver, rejection_reason FROM analysis_results ORDER BY id DESC LIMIT 1"
        ).fetchone()

    assert row == ("fed_rates", "Fed/rates evidence is missing or stale.")
