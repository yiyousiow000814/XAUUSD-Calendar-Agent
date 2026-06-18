import sqlite3
from datetime import datetime
import json
from pathlib import Path

from src.xauusd_market_agent.config import MarketAgentConfig
from src.xauusd_market_agent.live_pipeline import build_live_evidence_packet, run_monitored_live_once
from src.xauusd_market_agent.provider_health import build_provider_health
from src.xauusd_market_agent.providers.ctrader_provider import CTraderProvider
from src.xauusd_market_agent.providers.provider_router import ProviderRouter
from src.xauusd_market_agent.providers.trading_economics import (
    TradingEconomicsQuoteProvider,
    TradingEconomicsUS2YProvider,
)
from src.xauusd_market_agent.providers.yahoo_chart import YahooChartProvider
from src.xauusd_market_agent.timeline_store import TimelineStore


def test_calendar_provider_reports_dataset_gap_when_calendar_stops_before_anchor(tmp_path) -> None:
    calendar_dir = tmp_path / "calendar"
    year_dir = calendar_dir / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text(
        json.dumps(
            [
                {"Date": "2026-04-30", "Time": "09:00", "Cur.": "USD", "Event": "GDP", "Imp.": "High"},
            ]
        ),
        encoding="utf-8",
    )
    router = ProviderRouter(csv_calendar_dir=calendar_dir)

    rows, health = router.fetch_calendar_context(datetime.fromisoformat("2026-05-25T11:30:00+08:00"))

    assert rows == []
    assert health.is_available is False
    assert health.data_mode == "dataset_gap"
    assert "30-04-2026" in health.stale_reason
    assert health.metadata["dataset_end"] == "2026-04-30"


def test_calendar_provider_handles_empty_existing_calendar_without_crashing(tmp_path) -> None:
    calendar_dir = tmp_path / "calendar"
    year_dir = calendar_dir / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text("[]", encoding="utf-8")
    router = ProviderRouter(csv_calendar_dir=calendar_dir)

    rows, health = router.fetch_calendar_context(datetime.fromisoformat("2026-05-25T11:30:00+08:00"))

    assert rows == []
    assert health.is_available is False
    assert health.data_mode == "unavailable"
    assert health.metadata["row_count"] == 0


def test_calendar_provider_reports_available_when_dataset_covers_anchor_but_window_is_empty(tmp_path) -> None:
    calendar_dir = tmp_path / "calendar"
    year_dir = calendar_dir / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text(
        json.dumps(
            [
                {"Date": "2026-05-25", "Time": "08:00", "Cur.": "USD", "Event": "Durable Goods", "Imp.": "High"},
                {"Date": "2026-05-25", "Time": "18:00", "Cur.": "USD", "Event": "Fed Speaker", "Imp.": "Medium"},
            ]
        ),
        encoding="utf-8",
    )
    router = ProviderRouter(csv_calendar_dir=calendar_dir)

    rows, health = router.fetch_calendar_context(datetime.fromisoformat("2026-05-25T12:30:00+08:00"))

    assert rows == []
    assert health.is_available is True
    assert health.data_mode == "live_seen"
    assert health.current_value == 0.0
    assert health.metadata["dataset_end"] == "2026-05-25"


def test_calendar_provider_from_config_uses_extended_forward_window(tmp_path) -> None:
    calendar_dir = tmp_path / "calendar"
    year_dir = calendar_dir / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text(
        json.dumps(
            [
                {
                    "Date": "2026-06-15",
                    "Time": "20:30",
                    "Cur.": "USD",
                    "Event": "Empire State Manufacturing Index",
                    "Imp.": "Medium",
                },
            ]
        ),
        encoding="utf-8",
    )
    cfg = MarketAgentConfig(
        repo_root=tmp_path,
        calendar_dir=calendar_dir,
        calendar_forward_minutes=4320,
        rss_feeds=[],
    )
    router = ProviderRouter.from_config(cfg)

    rows, health = router.fetch_calendar_context(datetime.fromisoformat("2026-06-13T20:55:00+08:00"))

    assert [row["title"] for row in rows] == ["Empire State Manufacturing Index"]
    assert health.is_available is True
    assert health.current_value == 1.0


def test_market_agent_config_disables_csv_fallback_by_default(tmp_path) -> None:
    cfg = MarketAgentConfig(
        repo_root=tmp_path,
        price_data_path=tmp_path / "missing.csv",
        calendar_dir=tmp_path / "calendar",
        timeline_store_path=tmp_path / "timeline.sqlite",
    )

    assert cfg.csv_fallback_enabled is False


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
            fetched_at=anchor_time.isoformat(),
        )

    def backfill(self, start, end):
        return self.fetch_latest(end)


class UnavailableCTraderProvider:
    def fetch_latest(self, anchor_time):
        reason = "Waiting for fresh cTrader live stream snapshot."
        return [], build_provider_health(
            source="cTrader",
            source_type="spot",
            data_mode="unavailable",
            is_available=False,
            stale_reason=reason,
            error=reason,
            data_timestamp=anchor_time.isoformat(),
        )

    def backfill(self, start, end):
        return [], build_provider_health(
            source="cTrader",
            source_type="spot",
            data_mode="unavailable",
            is_available=False,
            stale_reason="Automatic cTrader CLI history bridge is disabled.",
            error="Automatic cTrader CLI history bridge is disabled.",
            data_timestamp=end.isoformat(),
        )


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


def test_market_router_preserves_ctrader_unavailable_reason() -> None:
    router = ProviderRouter(
        ctrader_provider=UnavailableCTraderProvider(),
        yahoo_enabled=False,
        csv_fallback_enabled=False,
    )

    rows, health = router.fetch_market_context(datetime.fromisoformat("2026-06-17T20:05:00+08:00"))

    assert rows == []
    assert health.data_mode == "unavailable"
    assert health.is_available is False
    assert health.stale_reason == "Waiting for fresh cTrader live stream snapshot."
    assert health.error == "Waiting for fresh cTrader live stream snapshot."
    assert router.last_market_provider_meta["fallback_reason"] == "Waiting for fresh cTrader live stream snapshot."


def test_us2y_is_not_silently_mapped_or_marked_unavailable_when_using_yahoo_fixture(tmp_path) -> None:
    fixture_dir = Path(__file__).parent / "fixtures" / "providers"
    router = ProviderRouter(
        yahoo_enabled=True,
        yahoo_fixture_dir=fixture_dir,
        csv_fallback_enabled=False,
    )

    rows, health_map = router.fetch_related_assets_context(datetime.fromisoformat("2026-05-19T07:20:00+08:00"))

    assert any(row["symbol"] == "us10y" for row in rows)
    assert not any(row["symbol"] == "us2y" for row in rows)
    assert "us2y" not in health_map


def test_yahoo_related_assets_can_merge_configured_us2y_csv_fallback(tmp_path) -> None:
    fixture_dir = Path(__file__).parent / "fixtures" / "providers"
    related_dir = tmp_path / "related-assets"
    related_dir.mkdir()
    (related_dir / "us2y.csv").write_text(
        "timestamp,close\n"
        "2026-05-19T07:00:00+08:00,4.60\n"
        "2026-05-19T07:15:00+08:00,4.65\n",
        encoding="utf-8",
    )
    router = ProviderRouter(
        yahoo_enabled=True,
        yahoo_fixture_dir=fixture_dir,
        csv_fallback_enabled=True,
        csv_related_assets_dir=related_dir,
    )

    rows, health_map = router.fetch_related_assets_context(datetime.fromisoformat("2026-05-19T07:20:00+08:00"))

    assert any(row["symbol"] == "us10y" and row["source"] == "Yahoo Finance" for row in rows)
    us2y_rows = [row for row in rows if row["symbol"] == "us2y"]
    assert len(us2y_rows) == 1
    assert us2y_rows[0]["source_type"] == "local_csv_fallback"
    assert round(us2y_rows[0]["change_value"], 6) == 5.0
    assert health_map["us2y"].is_available is True
    assert health_map["us2y"].data_mode == "stale"


def test_yahoo_related_assets_fetches_live_us2y_when_trading_economics_is_enabled(monkeypatch, tmp_path) -> None:
    fixture_dir = Path(__file__).parent / "fixtures" / "providers"

    def fake_fetch_latest(self, anchor_time):
        health_builder = __import__("src.xauusd_market_agent.provider_health", fromlist=["build_provider_health"]).build_provider_health
        return [
            {
                "symbol": "us2y",
                "data_timestamp": "2026-05-19T07:15:00+08:00",
                "value": 4.65,
                "close": 4.65,
                "change_15m": 5.0,
                "change_30m": 5.0,
                "change_60m": 5.0,
                "change_value": 5.0,
                "change_unit": "bps",
                "source": "Trading Economics",
                "source_type": "yield_quote",
                "data_mode": "live_seen",
                "is_stale": False,
                "stale_reason": "",
            }
        ], health_builder(
            source="Trading Economics US2Y",
            source_type="yield_quote",
            data_mode="live_seen",
            is_available=True,
            current_value=4.65,
            change_value=5.0,
            change_unit="bps",
            raw_source_id="USGG2YR:IND",
            data_timestamp="2026-05-19T07:15:00+08:00",
        )

    monkeypatch.setattr(TradingEconomicsUS2YProvider, "fetch_latest", fake_fetch_latest)
    router = ProviderRouter(
        yahoo_enabled=True,
        yahoo_fixture_dir=fixture_dir,
        csv_fallback_enabled=False,
        trading_economics_us2y_enabled=True,
        trading_economics_us2y_cache_path=tmp_path / "us2y-cache.json",
    )

    rows, health_map = router.fetch_related_assets_context(datetime.fromisoformat("2026-05-19T07:20:00+08:00"))

    assert any(row["symbol"] == "us10y" and row["source"] == "Yahoo Finance" for row in rows)
    assert any(row["symbol"] == "us2y" and row["source"] == "Trading Economics" for row in rows)
    assert health_map["us2y"].is_available is True
    assert health_map["us2y"].data_mode == "live_seen"


def test_related_asset_fallback_does_not_replace_with_stale_quote(monkeypatch, tmp_path) -> None:
    def fake_yahoo_fetch(self, symbol, anchor_time):
        return [
            {
                "symbol": "NQ=F",
                "timestamp": "2026-05-19T07:00:00+08:00",
                "close": 18200.0,
                "source": "Yahoo Finance",
                "source_type": "proxy",
                "data_mode": "live_seen",
            }
        ], build_provider_health(
            source="NQ=F",
            source_type="proxy",
            data_mode="live_seen",
            is_available=True,
            is_stale=True,
            stale_reason="Latest chart point is older than freshness threshold.",
            data_timestamp="2026-05-19T07:00:00+08:00",
            current_value=18200.0,
            raw_source_id="NQ=F",
        )

    def fake_te_fetch(self, anchor_time):
        return [
            {
                "symbol": "nasdaq",
                "data_timestamp": "2026-05-19T06:30:00+08:00",
                "value": 18100.0,
                "source": "Trading Economics",
                "source_type": "equity_index_quote",
                "data_mode": "live_seen",
                "is_stale": True,
                "stale_reason": "Quote is stale.",
            }
        ], build_provider_health(
            source="Trading Economics Nasdaq",
            source_type="equity_index_quote",
            data_mode="live_seen",
            is_available=True,
            is_stale=True,
            stale_reason="Quote is stale.",
            data_timestamp="2026-05-19T06:30:00+08:00",
            current_value=18100.0,
            raw_source_id="CCMP:IND",
        )

    monkeypatch.setattr(YahooChartProvider, "fetch_related_asset", fake_yahoo_fetch)
    monkeypatch.setattr(TradingEconomicsQuoteProvider, "fetch_latest", fake_te_fetch)
    router = ProviderRouter(
        yahoo_enabled=True,
        trading_economics_quotes_cache_dir=tmp_path,
    )

    rows, health_map = router.fetch_related_assets_context(datetime.fromisoformat("2026-05-19T07:20:00+08:00"))

    assert any(row["symbol"] == "nasdaq" and row["source"] == "Yahoo Finance" for row in rows)
    assert health_map["nasdaq"].source == "NQ=F"
    assert health_map["nasdaq"].is_stale is True


def test_related_asset_csv_fallback_is_context_only_not_live_evidence(tmp_path) -> None:
    related_path = tmp_path / "related.json"
    related_path.write_text(
        """
        {
          "dxy_percent": 0.31,
          "us10y_bps": 5.2,
          "us2y_bps": 0.0,
          "wti_percent": 1.8,
          "brent_percent": 1.6,
          "vix_percent": 0.2,
          "spx_percent": -0.1,
          "nasdaq_percent": -0.2
        }
        """,
        encoding="utf-8",
    )
    router = ProviderRouter(
        yahoo_enabled=False,
        csv_fallback_enabled=True,
        csv_related_assets_path=related_path,
    )

    rows, health_map = router.fetch_related_assets_context(datetime.fromisoformat("2026-05-19T07:20:00+08:00"))

    assert rows
    assert rows[0]["data_mode"] == "stale"
    assert rows[0]["is_stale"] is True
    assert health_map["dxy"].data_mode == "stale"
    assert health_map["dxy"].is_stale is True
    assert health_map["us10y"].data_mode == "stale"
    assert health_map["us10y"].is_stale is True


def test_missing_csv_but_yahoo_fixture_exists_does_not_use_proxy_as_live(tmp_path) -> None:
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
    with sqlite3.connect(tmp_path / "timeline.sqlite") as connection:
        market_count = connection.execute("SELECT COUNT(*) FROM market_price_bars").fetchone()[0]

    assert outcome["evidence_packet"]["provider_health"]["xauusd"]["is_available"] is False
    assert outcome["evidence_packet"]["provider_health"]["xauusd"]["data_mode"] == "unavailable"
    assert outcome["evidence_packet"]["evidence_chain_status"]["status"] == "context_only"
    assert outcome["evidence_packet"]["evidence_chain_status"]["can_show_current_conclusion"] is False
    assert "live_xauusd_spot" in outcome["evidence_packet"]["evidence_chain_status"]["missing_required"]
    assert outcome["analysis"]["main_driver"] == "unknown"
    assert outcome["analysis"]["cause_status"] == "unconfirmed"
    assert market_count == 0


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
    assert outcome["evidence_packet"]["evidence_chain_status"]["can_show_current_conclusion"] is False
    assert outcome["analysis"]["main_driver"] == "unknown"


def test_proxy_source_is_recorded_as_chain_status_not_live_evidence(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("CTRADER_ENABLED", "false")
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

    assert packet["provider_health"]["xauusd"]["is_available"] is False
    assert packet["provider_health"]["xauusd"]["data_mode"] == "unavailable"
    assert packet["evidence_chain_status"]["status"] == "context_only"
    assert packet["evidence_chain_status"]["can_show_current_conclusion"] is False
    assert packet["selected_market_provider"] == "unavailable"
    assert any(item["provider"] == "yahoo_gc_f_proxy" for item in packet["provider_chain_status"])


def test_ctrader_disabled_build_does_not_promote_yahoo_proxy_to_live(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("CTRADER_ENABLED", "false")
    monkeypatch.setenv("CTRADER_ACCOUNT_ID", "acct")
    monkeypatch.setenv("CTRADER_CTID", "trader@example.com")
    monkeypatch.setenv("CTRADER_PASSWORD", "secret")
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

    assert rows == []
    assert health.is_available is False
    assert health.data_mode == "unavailable"
    assert router.last_market_provider_meta["selected_market_provider"] == "unavailable"
    assert any(item["provider"] == "yahoo_gc_f_proxy" for item in router.last_market_provider_meta["provider_chain_status"])


class StubCTraderProvider:
    def __init__(self, *, rows, health, backfill_rows=None, backfill_health=None, backfill_error=None):
        self.rows = rows
        self.health = health
        self.backfill_rows = backfill_rows if backfill_rows is not None else rows
        self.backfill_health = backfill_health if backfill_health is not None else health
        self.backfill_error = backfill_error

    def fetch_latest(self, anchor_time):
        return self.rows, self.health

    def backfill(self, start, end):
        if self.backfill_error:
            raise self.backfill_error
        return self.backfill_rows, self.backfill_health


def test_fresh_ctrader_spot_wins_over_yahoo_proxy(tmp_path) -> None:
    fixture_dir = Path(__file__).parent / "fixtures" / "providers"
    health_builder = __import__("src.xauusd_market_agent.provider_health", fromlist=["build_provider_health"]).build_provider_health
    ctrader = StubCTraderProvider(
        rows=[
            {
                "symbol": "XAUUSD",
                "data_timestamp": "2026-05-19T07:20:00+08:00",
                "open": 4500.0,
                "high": 4503.0,
                "low": 4498.0,
                "close": 4501.0,
                "bid": 4500.9,
                "ask": 4501.1,
                "source": "cTrader CLI",
                "source_type": "spot",
                "data_mode": "live_seen",
                "is_stale": False,
                "stale_reason": "",
            }
        ],
        health=health_builder(
            source="cTrader",
            source_type="spot",
            data_mode="live_seen",
            is_available=True,
            is_stale=False,
            current_value=4501.0,
            data_timestamp="2026-05-19T07:20:00+08:00",
        ),
    )
    router = ProviderRouter(
        yahoo_enabled=True,
        yahoo_fixture_dir=fixture_dir,
        csv_fallback_enabled=False,
        ctrader_provider=ctrader,
    )

    rows, health = router.fetch_market_context(datetime.fromisoformat("2026-05-19T07:20:00+08:00"))

    assert rows[-1]["source_type"] == "spot"
    assert health.source_type == "spot"
    assert router.last_market_provider_meta["selected_market_provider"] == "ctrader_spot"
    assert router.last_market_provider_meta["provider_chain_status"][0]["provider"] == "ctrader_spot"


def test_ctrader_backfill_failure_falls_back_to_yahoo_proxy(tmp_path) -> None:
    fixture_dir = Path(__file__).parent / "fixtures" / "providers"
    health_builder = __import__("src.xauusd_market_agent.provider_health", fromlist=["build_provider_health"]).build_provider_health
    ctrader = StubCTraderProvider(
        rows=[],
        health=health_builder(
            source="cTrader",
            source_type="spot",
            data_mode="live_seen",
            is_available=True,
            is_stale=False,
            current_value=4501.0,
            data_timestamp="2026-05-19T07:20:00+08:00",
        ),
        backfill_error=RuntimeError("The installed cTrader CLI does not expose this command through the local adapter."),
    )
    router = ProviderRouter(
        yahoo_enabled=True,
        yahoo_fixture_dir=fixture_dir,
        csv_fallback_enabled=False,
        ctrader_provider=ctrader,
    )

    rows, health = router.backfill_market_context(
        datetime.fromisoformat("2026-05-19T07:20:00+08:00"),
        datetime.fromisoformat("2026-05-25T11:00:00+08:00"),
    )

    assert rows
    assert health.source == "GC=F"
    assert router.last_market_provider_meta["selected_market_provider"] == "yahoo_gc_f_proxy"
    chain = router.last_market_provider_meta["provider_chain_status"]
    assert chain[0]["provider"] == "ctrader_spot"
    assert chain[0]["is_available"] is False
    assert chain[0]["data_mode"] == "unavailable"
    assert "does not expose this command" in chain[0]["stale_reason"]
    assert any(item["provider"] == "yahoo_gc_f_proxy" for item in chain)


def test_stale_ctrader_keeps_last_spot_price_without_promoting_proxy(tmp_path) -> None:
    fixture_dir = Path(__file__).parent / "fixtures" / "providers"
    health_builder = __import__("src.xauusd_market_agent.provider_health", fromlist=["build_provider_health"]).build_provider_health
    ctrader = StubCTraderProvider(
        rows=[
            {
                "symbol": "XAUUSD",
                "data_timestamp": "2026-05-19T07:00:00+08:00",
                "open": 4500.0,
                "high": 4501.0,
                "low": 4499.0,
                "close": 4500.5,
                "source": "cTrader saved snapshot",
                "source_type": "spot_snapshot",
                "data_mode": "stale",
                "is_stale": True,
                "stale_reason": "Snapshot stale.",
            }
        ],
        health=health_builder(
            source="cTrader",
            source_type="spot_snapshot",
            data_mode="stale",
            is_available=True,
            is_stale=True,
            stale_reason="Snapshot stale.",
            current_value=4500.5,
            data_timestamp="2026-05-19T07:00:00+08:00",
        ),
    )
    router = ProviderRouter(
        yahoo_enabled=True,
        yahoo_fixture_dir=fixture_dir,
        csv_fallback_enabled=False,
        ctrader_provider=ctrader,
    )

    rows, health = router.fetch_market_context(datetime.fromisoformat("2026-05-19T07:20:00+08:00"))

    assert rows
    assert health.source_type == "spot_snapshot"
    assert health.data_mode == "stale"
    assert health.is_stale is True
    assert router.last_market_provider_meta["selected_market_provider"] == "ctrader_spot_stale"
    assert router.last_market_provider_meta["fallback_reason"]
    assert router.last_market_provider_meta["provider_chain_status"][0]["provider"] == "ctrader_spot"
    assert router.last_market_provider_meta["provider_chain_status"][0]["data_mode"] == "stale"
    assert any(item["provider"] == "yahoo_gc_f_proxy" for item in router.last_market_provider_meta["provider_chain_status"])


def test_old_ctrader_live_seen_quote_is_treated_as_market_closed_context(tmp_path) -> None:
    fixture_dir = Path(__file__).parent / "fixtures" / "providers"
    health_builder = __import__("src.xauusd_market_agent.provider_health", fromlist=["build_provider_health"]).build_provider_health
    ctrader = StubCTraderProvider(
        rows=[
            {
                "symbol": "XAUUSD",
                "data_timestamp": "2026-05-15T07:15:00+08:00",
                "open": 4500.0,
                "high": 4501.0,
                "low": 4478.0,
                "close": 4479.0,
                "source": "cTrader CLI",
                "source_type": "spot",
                "data_mode": "live_seen",
                "is_stale": False,
                "stale_reason": "",
            }
        ],
        health=health_builder(
            source="cTrader",
            source_type="spot",
            data_mode="live_seen",
            is_available=True,
            is_stale=False,
            current_value=4479.0,
            data_timestamp="2026-05-15T07:15:00+08:00",
            fetched_at="2026-05-23T17:20:47+08:00",
        ),
    )
    router = ProviderRouter(
        yahoo_enabled=True,
        yahoo_fixture_dir=fixture_dir,
        csv_fallback_enabled=False,
        ctrader_provider=ctrader,
    )

    rows, health = router.fetch_market_context(datetime.fromisoformat("2026-05-23T17:20:47+08:00"))

    assert rows[-1]["data_mode"] == "stale"
    assert rows[-1]["is_stale"] is True
    assert health.data_mode == "stale"
    assert health.is_stale is True
    assert health.current_value == 4479.0
    assert "market may be closed" in health.stale_reason
    assert router.last_market_provider_meta["selected_market_provider"] == "ctrader_spot_stale"


def test_provider_chain_status_persists_into_evidence_packet(tmp_path) -> None:
    fixture_dir = Path(__file__).parent / "fixtures" / "providers"
    health_builder = __import__("src.xauusd_market_agent.provider_health", fromlist=["build_provider_health"]).build_provider_health
    ctrader = StubCTraderProvider(
        rows=[],
        health=health_builder(
            source="cTrader",
            source_type="spot",
            data_mode="unavailable",
            is_available=False,
            is_stale=False,
            error="auth_failed",
            stale_reason="auth_failed",
            data_timestamp="2026-05-19T07:20:00+08:00",
        ),
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
    router = ProviderRouter(
        yahoo_enabled=True,
        yahoo_fixture_dir=fixture_dir,
        csv_fallback_enabled=False,
        ctrader_provider=ctrader,
    )

    packet = build_live_evidence_packet(
        cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T07:20:00+08:00"),
        provider_router=router,
    )

    assert packet["selected_market_provider"] == "unavailable"
    assert packet["provider_chain_status"][0]["provider"] == "ctrader_spot"
    assert packet["provider_chain_status"][0]["error"] == "auth_failed"
    assert any(item["provider"] == "yahoo_gc_f_proxy" for item in packet["provider_chain_status"])
    assert packet["fallback_reason"]


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
