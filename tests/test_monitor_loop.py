from datetime import datetime
import json

from src.xauusd_market_agent.config import MarketAgentConfig
from src.xauusd_market_agent.live_pipeline import MonitorLock, run_monitor_loop
from src.xauusd_market_agent.provider_health import build_provider_health
from src.xauusd_market_agent.providers.provider_router import ProviderRouter


class StubLiveMarketProvider:
    def fetch_latest(self, anchor_time):
        rows = [
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
        return rows, build_provider_health(
            source="cTrader",
            source_type="spot",
            data_mode="live_seen",
            is_available=True,
            data_timestamp=anchor_time.isoformat(),
            current_value=4479.0,
            previous_value=4501.0,
            change_value=-22.0,
        )


class StubNewsProvider:
    def fetch_latest(self, anchor_time):
        return [
            {
                "published_at": anchor_time.isoformat(),
                "first_seen_at": anchor_time.isoformat(),
                "backfilled_at": None,
                "is_backfilled": False,
                "source": "Reuters",
                "title": "Fed speakers keep Treasury yields in focus",
                "link": "https://example.com/fed-yields",
                "relevance_reason": "Fresh macro headline.",
                "impact_direction_on_gold": "bearish_gold",
                "data_mode": "live_seen",
                "included": True,
                "filter_reason": "",
                "source_quality_score": 0.92,
                "score": 0.82,
                "matched_keywords": ["fed", "yield"],
                "categories": ["macro"],
            }
        ], build_provider_health(
            source="App news collector",
            source_type="rss_provider",
            data_mode="live_seen",
            is_available=True,
            data_timestamp=anchor_time.isoformat(),
            current_value=1.0,
        )

    def backfill(self, start, end):
        return self.fetch_latest(end)


class StubCalendarProvider:
    def fetch_window(self, anchor_time):
        return [
            {
                "scheduled_at": anchor_time.isoformat(),
                "source": "Economic Calendar",
                "title": "Fed Chair Powell Speaks",
                "relevance_reason": "USD high importance event",
                "impact_direction_on_gold": "unknown",
                "data_mode": "live_seen",
            }
        ], build_provider_health(
            source="Economic Calendar",
            source_type="calendar_provider",
            data_mode="live_seen",
            is_available=True,
            data_timestamp=anchor_time.isoformat(),
            current_value=1.0,
        )

    def backfill(self, start, end):
        return self.fetch_window(end)


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
        provider_router=ProviderRouter(
            market_provider=StubLiveMarketProvider(),
            csv_related_assets_path=related_path,
            yahoo_enabled=False,
        ),
    )

    assert len(outcomes) == 2
    assert outcomes[0]["notification"]["should_notify"] is False
    assert outcomes[1]["notification"]["should_notify"] is False


def test_run_monitor_loop_writes_backend_activity_status(tmp_path) -> None:
    status_path = tmp_path / "monitor_status.json"
    cfg = MarketAgentConfig(
        repo_root=tmp_path,
        calendar_dir=tmp_path / "calendar",
        yahoo_enabled=False,
        monitor_lock_path=tmp_path / "market_agent_monitor.lock",
    )

    outcomes = run_monitor_loop(
        config=cfg,
        interval_seconds=0,
        max_iterations=1,
        anchor_times=[datetime.fromisoformat("2026-05-19T07:15:00+08:00")],
        state_path=tmp_path / "state.json",
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=tmp_path / "timeline.sqlite",
        provider_router=ProviderRouter(
            market_provider=StubLiveMarketProvider(),
            news_provider=StubNewsProvider(),
            calendar_provider=StubCalendarProvider(),
            yahoo_enabled=False,
        ),
        status_path=status_path,
    )

    assert len(outcomes) == 1
    status = json.loads(status_path.read_text(encoding="utf-8"))
    assert status["phase"] == "stopped"
    assert status["lastRunAt"] == "2026-05-19T07:15:00+08:00"
    assert status["lastSuccessAt"] == "2026-05-19T07:15:00+08:00"
    assert status["activity"]["ctrader"]["status"] == "live"
    assert status["activity"]["ctrader"]["label"] == "XAUUSD live"
    assert status["activity"]["history"]["status"] == "idle"
    assert status["activity"]["context"]["status"] == "active"
    assert status["activity"]["context"]["newsCount"] == 1
    assert status["activity"]["context"]["calendarCount"] == 1
    assert status["activity"]["llm"]["status"] in {"skipped", "validated", "unavailable"}
    assert status["activity"]["alerts"]["status"] in {"sent", "suppressed", "idle"}


def test_run_monitor_loop_does_not_start_when_lock_is_held(tmp_path) -> None:
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
        price_data_path=tmp_path / "prices.csv",
        calendar_dir=tmp_path / "calendar",
        related_assets_path=related_path,
        yahoo_enabled=False,
        monitor_lock_path=tmp_path / "market_agent_monitor.lock",
    )

    with MonitorLock(cfg.monitor_lock_path) as lock:
        assert lock is not None
        outcomes = run_monitor_loop(
            config=cfg,
            interval_seconds=0,
            max_iterations=1,
            anchor_times=[datetime.fromisoformat("2026-05-19T07:15:00+08:00")],
            state_path=tmp_path / "state.json",
            alerts_path=tmp_path / "alerts.ndjson",
            provider_router=ProviderRouter(
                market_provider=StubLiveMarketProvider(),
                csv_related_assets_path=related_path,
                yahoo_enabled=False,
            ),
        )

    assert outcomes == [
        {
            "ok": False,
            "phase": "already_running",
            "message": "Monitor loop is already running.",
        }
    ]
    assert not (tmp_path / "alerts.ndjson").exists()
