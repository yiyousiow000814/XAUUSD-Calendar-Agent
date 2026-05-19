from datetime import datetime
from pathlib import Path

from src.xauusd_market_agent.config import MarketAgentConfig
from src.xauusd_market_agent.live_pipeline import build_live_evidence_packet, run_monitored_live_once
from src.xauusd_market_agent.providers.provider_router import ProviderRouter
from src.xauusd_market_agent.timeline_store import TimelineStore


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


def test_us2y_is_not_silently_mapped_to_us10y_when_using_yahoo_fixture(tmp_path) -> None:
    fixture_dir = Path(__file__).parent / "fixtures" / "providers"
    router = ProviderRouter(
        yahoo_enabled=True,
        yahoo_fixture_dir=fixture_dir,
        csv_fallback_enabled=False,
    )

    rows, health_map = router.fetch_related_assets_context(datetime.fromisoformat("2026-05-19T07:20:00+08:00"))

    assert any(row["symbol"] == "us10y" for row in rows)
    assert not any(row["symbol"] == "us2y" for row in rows)
    assert health_map["us2y"].is_available is False
    assert health_map["us2y"].data_mode == "unavailable"


def test_missing_csv_but_yahoo_fixture_exists_uses_proxy_without_crash(tmp_path) -> None:
    fixture_dir = Path(__file__).parent / "fixtures" / "providers"
    router = ProviderRouter(
        yahoo_enabled=True,
        yahoo_fixture_dir=fixture_dir,
        csv_fallback_enabled=False,
    )
    cfg = MarketAgentConfig(
        repo_root=tmp_path,
        price_data_path=tmp_path / "missing.csv",
        calendar_dir=tmp_path / "calendar",
        timeline_store_path=tmp_path / "timeline.sqlite",
        yahoo_enabled=True,
        yahoo_fixture_dir=fixture_dir,
        csv_fallback_enabled=False,
    )

    outcome = run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T07:20:00+08:00"),
        state_path=tmp_path / "state.json",
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=tmp_path / "timeline.sqlite",
        provider_router=router,
    )
    replay = TimelineStore(tmp_path / "timeline.sqlite").get_market_replay(
        "2026-05-19T07:00:00+08:00",
        "2026-05-19T07:30:00+08:00",
    )

    assert outcome["evidence_packet"]["provider_health"]["xauusd"]["source_type"] == "futures_proxy"
    assert outcome["evidence_packet"]["provider_health"]["xauusd"]["data_mode"] == "proxy"
    assert outcome["evidence_packet"]["market_move"]["symbol"] == "GC=F"
    assert outcome["evidence_packet"]["market_move"]["source_type"] == "futures_proxy"
    assert replay["price_series"][-1]["source_type"] == "futures_proxy"
    assert replay["price_series"][-1]["data_mode"] == "proxy"


def test_missing_csv_and_yahoo_disabled_returns_unavailable_provider_health(tmp_path) -> None:
    router = ProviderRouter(
        yahoo_enabled=False,
        csv_fallback_enabled=False,
    )
    cfg = MarketAgentConfig(
        repo_root=tmp_path,
        price_data_path=tmp_path / "missing.csv",
        calendar_dir=tmp_path / "calendar",
        timeline_store_path=tmp_path / "timeline.sqlite",
        yahoo_enabled=False,
        csv_fallback_enabled=False,
    )

    outcome = run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T07:20:00+08:00"),
        state_path=tmp_path / "state.json",
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=tmp_path / "timeline.sqlite",
        provider_router=router,
    )

    assert outcome["evidence_packet"]["provider_health"]["xauusd"]["is_available"] is False
    assert outcome["analysis"]["main_driver"] == "unknown"


def test_proxy_label_persists_into_evidence_packet(tmp_path) -> None:
    fixture_dir = Path(__file__).parent / "fixtures" / "providers"
    cfg = MarketAgentConfig(
        repo_root=tmp_path,
        price_data_path=tmp_path / "missing.csv",
        calendar_dir=tmp_path / "calendar",
        timeline_store_path=tmp_path / "timeline.sqlite",
        yahoo_enabled=True,
        yahoo_fixture_dir=fixture_dir,
        csv_fallback_enabled=False,
    )
    router = ProviderRouter.from_config(cfg)

    packet = build_live_evidence_packet(
        cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T07:20:00+08:00"),
        provider_router=router,
    )

    assert packet["provider_health"]["xauusd"]["source_type"] == "futures_proxy"
    assert packet["provider_health"]["xauusd"]["data_mode"] == "proxy"
    assert packet["market_move"]["source_type"] == "futures_proxy"


def test_ctrader_disabled_build_falls_through_to_yahoo_proxy(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("CTRADER_CLIENT_ID", "id")
    monkeypatch.setenv("CTRADER_CLIENT_SECRET", "secret")
    monkeypatch.setenv("CTRADER_ACCESS_TOKEN", "token")
    monkeypatch.setenv("CTRADER_ACCOUNT_ID", "acct")
    fixture_dir = Path(__file__).parent / "fixtures" / "providers"
    cfg = MarketAgentConfig(
        repo_root=tmp_path,
        price_data_path=tmp_path / "missing.csv",
        calendar_dir=tmp_path / "calendar",
        timeline_store_path=tmp_path / "timeline.sqlite",
        yahoo_enabled=True,
        yahoo_fixture_dir=fixture_dir,
        csv_fallback_enabled=False,
    )
    router = ProviderRouter.from_config(cfg)

    rows, health = router.fetch_market_context(datetime.fromisoformat("2026-05-19T07:20:00+08:00"))

    assert rows
    assert health.source_type == "futures_proxy"
    assert health.data_mode == "proxy"


def test_filtered_low_signal_headline_does_not_become_confirmed_cause(tmp_path) -> None:
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
        news_headlines=[
            {
                "title": "Opinion: Fed forecast into CPI week",
                "source": "Reuters Markets",
                "published_at": "2026-05-19T07:10:00+08:00",
                "included": False,
                "filter_reason": "low_signal_opinion_or_forecast",
                "source_quality_score": 0.92,
                "score": 0.42,
                "categories": ["rss", "filtered"],
                "matched_keywords": ["fed"],
            }
        ],
    )

    assert outcome["analysis"]["main_driver"] != "fed_rates"
    assert outcome["evidence_packet"]["allowed_candidate_drivers"] != ["fed_rates"]
