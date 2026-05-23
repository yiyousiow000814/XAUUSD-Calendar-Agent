from datetime import datetime
import json
import sqlite3

from src.xauusd_market_agent.config import MarketAgentConfig
from src.xauusd_market_agent.live_pipeline import run_monitored_live_once
from src.xauusd_market_agent.provider_health import build_provider_health
from src.xauusd_market_agent.providers.provider_router import ProviderRouter
from src.xauusd_market_agent.timeline_store import TimelineStore


class StubLiveMarketProvider:
    def __init__(self, rows):
        self.rows = rows

    def fetch_latest(self, anchor_time):
        return self.rows, build_provider_health(
            source="cTrader",
            source_type="spot",
            data_mode="live_seen",
            is_available=True,
            data_timestamp=anchor_time.isoformat(),
            current_value=float(self.rows[-1]["close_price"]),
            previous_value=float(self.rows[0]["close_price"]),
            change_value=float(self.rows[-1]["close_price"]) - float(self.rows[0]["close_price"]),
        )

    def backfill(self, start, end):
        rows = [{**row, "data_mode": "backfilled"} for row in self.rows]
        return rows, build_provider_health(
            source="cTrader",
            source_type="spot",
            data_mode="backfilled",
            is_available=True,
            data_timestamp=end.isoformat(),
            current_value=float(rows[-1]["close_price"]),
            previous_value=float(rows[0]["close_price"]),
            change_value=float(rows[-1]["close_price"]) - float(rows[0]["close_price"]),
        )


def _live_price_rows() -> list[dict[str, object]]:
    return [
        {
            "symbol": "XAUUSD",
            "data_timestamp": "2026-05-19T07:00:00+08:00",
            "open_price": 4500.0,
            "close_price": 4501.0,
            "source": "cTrader",
            "source_type": "spot",
            "data_mode": "live_seen",
        },
        {
            "symbol": "XAUUSD",
            "data_timestamp": "2026-05-19T07:15:00+08:00",
            "open_price": 4501.0,
            "close_price": 4479.0,
            "source": "cTrader",
            "source_type": "spot",
            "data_mode": "live_seen",
        },
    ]


def _live_router(related_path=None, calendar_dir=None) -> ProviderRouter:
    return ProviderRouter(
        market_provider=StubLiveMarketProvider(_live_price_rows()),
        csv_related_assets_path=related_path,
        csv_calendar_dir=calendar_dir,
        yahoo_enabled=False,
    )


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
        yahoo_enabled=False,
    )

    first = run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T07:15:00+08:00"),
        state_path=tmp_path / "state.json",
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=tmp_path / "timeline.sqlite",
        provider_router=_live_router(related_path),
    )
    second = run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T07:15:00+08:00"),
        state_path=tmp_path / "state.json",
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=tmp_path / "timeline.sqlite",
        provider_router=_live_router(related_path),
    )

    with sqlite3.connect(tmp_path / "timeline.sqlite") as connection:
        run_count = connection.execute("SELECT COUNT(*) FROM monitor_runs").fetchone()[0]
        no_news_found = connection.execute(
            "SELECT no_news_found FROM monitor_runs ORDER BY id DESC LIMIT 1"
        ).fetchone()[0]
        attention_rows = connection.execute(
            "SELECT COUNT(*) FROM driver_attention_states"
        ).fetchone()[0]

    assert first["notification"]["should_notify"] is False
    assert second["notification"]["should_notify"] is False
    assert run_count == 2
    assert no_news_found == 1
    assert attention_rows > 0


def test_driver_attention_persists_across_monitor_runs(tmp_path) -> None:
    price_path = tmp_path / "prices.csv"
    price_path.write_text(
        "timestamp,open,high,low,close\n"
        "2026-05-19T07:00:00+08:00,4500,4502,4499,4501\n"
        "2026-05-19T07:15:00+08:00,4501,4503,4475,4479\n",
        encoding="utf-8",
    )
    related_path = tmp_path / "related_assets.json"
    related_path.write_text(
        json.dumps({"dxy_percent": 0.0, "us10y_bps": 5.1, "us2y_bps": 4.4, "wti_percent": 2.1, "brent_percent": 1.8}),
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
        yahoo_enabled=False,
    )

    run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T07:15:00+08:00"),
        state_path=tmp_path / "state.json",
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=tmp_path / "timeline.sqlite",
    )
    related_path.write_text(
        json.dumps({"dxy_percent": 0.0, "us10y_bps": 0.0, "us2y_bps": 0.0, "wti_percent": 0.0, "brent_percent": 0.0}),
        encoding="utf-8",
    )
    run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T07:30:00+08:00"),
        state_path=tmp_path / "state.json",
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=tmp_path / "timeline.sqlite",
    )

    with sqlite3.connect(tmp_path / "timeline.sqlite") as connection:
        row = connection.execute(
            """
            SELECT current_state
            FROM driver_attention_states
            WHERE driver_id = 'oil_inflation'
            ORDER BY id DESC LIMIT 1
            """
        ).fetchone()

    assert row[0] in {"cooling", "retired", "dormant", "watching"}


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


def test_recovery_run_persists_price_news_calendar_and_evidence(tmp_path) -> None:
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
    (year_dir / "2026_calendar.json").write_text(
        json.dumps(
            [{"Date": "2026-05-19", "Time": "07:00", "Currency": "USD", "Event": "CPI", "Imp.": "High"}]
        ),
        encoding="utf-8",
    )
    cfg = MarketAgentConfig(
        repo_root=tmp_path,
        price_data_path=price_path,
        calendar_dir=tmp_path / "calendar",
        related_assets_path=related_path,
        rss_feeds=[],
        timeline_store_path=tmp_path / "timeline.sqlite",
        backfill_gap_minutes=30,
        yahoo_enabled=False,
    )

    store = TimelineStore(tmp_path / "timeline.sqlite")
    store.record_monitor_run(
        run_started_at="2026-05-19T00:00:00+08:00",
        run_type="live",
        data_mode="live_seen",
        backfill_required=False,
        last_successful_run_at=None,
        no_news_found=False,
        alert_suppressed_reason="",
    )

    run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T07:30:00+08:00"),
        state_path=tmp_path / "state.json",
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=tmp_path / "timeline.sqlite",
        news_headlines=[
            {"title": "Recovered Fed headline", "source": "Reuters", "published_at": "2026-05-19T07:10:00+08:00"}
        ],
        provider_router=_live_router(related_path, tmp_path / "calendar"),
    )

    with sqlite3.connect(tmp_path / "timeline.sqlite") as connection:
        run = connection.execute(
            "SELECT run_type, data_mode, backfill_required FROM monitor_runs ORDER BY id DESC LIMIT 1"
        ).fetchone()
        market_rows = connection.execute("SELECT COUNT(*) FROM market_price_bars").fetchone()[0]
        backfilled_market_rows = connection.execute(
            "SELECT COUNT(*) FROM market_price_bars WHERE data_mode = 'backfilled'"
        ).fetchone()[0]
        related_rows = connection.execute("SELECT COUNT(*) FROM related_asset_bars").fetchone()[0]
        news_rows = connection.execute("SELECT COUNT(*) FROM news_items").fetchone()[0]
        calendar_rows = connection.execute("SELECT COUNT(*) FROM calendar_events").fetchone()[0]
        evidence_rows = connection.execute("SELECT COUNT(*) FROM evidence_packets").fetchone()[0]
        recovery_rows = connection.execute(
            "SELECT COUNT(*) FROM timeline_events WHERE event_type = 'recovery_summary'"
        ).fetchone()[0]

    assert run == ("live", "live_seen", 1)
    assert market_rows > 0
    assert backfilled_market_rows > 0
    assert related_rows > 0
    assert news_rows > 0
    assert calendar_rows > 0
    assert evidence_rows > 0
    assert recovery_rows > 0


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
        yahoo_enabled=False,
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


def test_live_mode_without_csv_fails_gracefully_and_persists_provider_health(tmp_path) -> None:
    related_path = tmp_path / "related_assets.json"
    related_path.write_text(json.dumps({"dxy_percent": 0.0, "us10y_bps": 0.0, "us2y_bps": 0.0}), encoding="utf-8")
    year_dir = tmp_path / "calendar" / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text("[]", encoding="utf-8")
    cfg = MarketAgentConfig(
        repo_root=tmp_path,
        price_data_path=tmp_path / "missing_prices.csv",
        calendar_dir=tmp_path / "calendar",
        related_assets_path=related_path,
        rss_feeds=[],
        timeline_store_path=tmp_path / "timeline.sqlite",
        yahoo_enabled=False,
    )

    outcome = run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T07:15:00+08:00"),
        state_path=tmp_path / "state.json",
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=tmp_path / "timeline.sqlite",
    )

    with sqlite3.connect(tmp_path / "timeline.sqlite") as connection:
        row = connection.execute(
            """
            SELECT payload_json
            FROM provider_health
            WHERE provider_key = 'xauusd'
            ORDER BY id DESC LIMIT 1
            """
        ).fetchone()

    payload = json.loads(row[0])

    assert outcome["analysis"]["main_driver"] == "unknown"
    assert payload["is_available"] is False
    assert payload["data_mode"] == "unavailable"
