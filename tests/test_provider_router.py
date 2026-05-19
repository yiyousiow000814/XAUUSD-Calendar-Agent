from datetime import datetime

from src.xauusd_market_agent.config import MarketAgentConfig
from src.xauusd_market_agent.live_pipeline import run_monitored_live_once
from src.xauusd_market_agent.providers.provider_router import ProviderRouter


class StubMarketProvider:
    def fetch_latest(self, anchor_time):
        return [
            {
                "symbol": "XAUUSD",
                "data_timestamp": "2026-05-19T07:00:00+08:00",
                "open_price": 4500.0,
                "high_price": 4505.0,
                "low_price": 4498.0,
                "close_price": 4502.0,
                "source": "stub",
                "source_type": "spot",
                "data_mode": "live_seen",
                "is_stale": False,
                "stale_reason": "",
            },
            {
                "symbol": "XAUUSD",
                "data_timestamp": "2026-05-19T07:15:00+08:00",
                "open_price": 4502.0,
                "high_price": 4503.0,
                "low_price": 4478.0,
                "close_price": 4479.0,
                "source": "stub",
                "source_type": "spot",
                "data_mode": "live_seen",
                "is_stale": False,
                "stale_reason": "",
            },
        ], __import__("src.xauusd_market_agent.provider_health", fromlist=["build_provider_health"]).build_provider_health(
            source="XAUUSD",
            source_type="spot",
            data_mode="live_seen",
            is_available=True,
            current_value=4479.0,
            previous_value=4500.0,
            change_value=-0.466,
            change_unit="percent",
            data_timestamp="2026-05-19T07:15:00+08:00",
        )

    def backfill(self, start, end):
        return self.fetch_latest(end)


class StubRelatedProvider:
    def fetch_latest(self, anchor_time):
        health_builder = __import__("src.xauusd_market_agent.provider_health", fromlist=["build_provider_health"]).build_provider_health
        rows = [
            {"symbol": "dxy", "data_timestamp": "2026-05-19T07:15:00+08:00", "value": 104.2, "change_15m": 0.21, "change_30m": 0.22, "change_60m": 0.25, "change_value": 0.21, "change_unit": "percent", "source": "stub", "source_type": "proxy", "data_mode": "live_seen", "is_stale": False, "stale_reason": ""},
            {"symbol": "us10y", "data_timestamp": "2026-05-19T07:15:00+08:00", "value": 4.28, "change_15m": 5.1, "change_30m": 5.1, "change_60m": 5.1, "change_value": 5.1, "change_unit": "bps", "source": "stub", "source_type": "proxy", "data_mode": "live_seen", "is_stale": False, "stale_reason": ""},
            {"symbol": "us2y", "data_timestamp": "2026-05-19T07:15:00+08:00", "value": 4.7, "change_15m": 4.4, "change_30m": 4.4, "change_60m": 4.4, "change_value": 4.4, "change_unit": "bps", "source": "stub", "source_type": "proxy", "data_mode": "live_seen", "is_stale": False, "stale_reason": ""},
        ]
        health = {
            "dxy": health_builder(source="DXY", source_type="proxy", data_mode="live_seen", current_value=104.2, change_value=0.21, change_unit="percent", data_timestamp="2026-05-19T07:15:00+08:00"),
            "us10y": health_builder(source="US10Y", source_type="proxy", data_mode="live_seen", current_value=4.28, change_value=5.1, change_unit="bps", data_timestamp="2026-05-19T07:15:00+08:00"),
            "us2y": health_builder(source="US2Y", source_type="proxy", data_mode="live_seen", current_value=4.7, change_value=4.4, change_unit="bps", data_timestamp="2026-05-19T07:15:00+08:00"),
        }
        return rows, health

    def backfill(self, start, end):
        return self.fetch_latest(end)


def test_live_monitor_path_works_without_csv_when_provider_exists(tmp_path) -> None:
    router = ProviderRouter(
        market_provider=StubMarketProvider(),
        related_assets_provider=StubRelatedProvider(),
    )
    cfg = MarketAgentConfig(
        repo_root=tmp_path,
        price_data_path=tmp_path / "missing.csv",
        calendar_dir=tmp_path / "calendar",
        timeline_store_path=tmp_path / "timeline.sqlite",
    )

    outcome = run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T07:15:00+08:00"),
        state_path=tmp_path / "state.json",
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=tmp_path / "timeline.sqlite",
        provider_router=router,
    )

    assert outcome["analysis"]["main_driver"] in {"usd", "yields"}
    assert outcome["analysis"]["cause_status"] in {"likely", "possible", "confirmed", "unconfirmed"}
