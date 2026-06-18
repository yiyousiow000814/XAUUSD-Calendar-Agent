from src.xauusd_market_agent import config as market_config
from src.xauusd_market_agent.config import CTraderCliConfig, MarketAgentConfig


def test_market_agent_config_uses_windows_friendly_defaults() -> None:
    cfg = MarketAgentConfig()

    assert "data" in str(cfg.price_data_path)
    assert cfg.yahoo_enabled is True
    assert cfg.rss_feeds
    assert cfg.news_lookback_minutes == 30
    assert cfg.post_move_news_minutes == 120


def test_market_agent_config_prefers_synced_user_calendar(tmp_path, monkeypatch) -> None:
    synced = tmp_path / "user-data" / "data" / "Economic_Calendar"
    bundled = tmp_path / "data" / "Economic_Calendar"
    synced.mkdir(parents=True)
    bundled.mkdir(parents=True)
    monkeypatch.setattr(market_config, "REPO_ROOT", tmp_path)
    monkeypatch.delenv("MARKET_AGENT_CALENDAR_DIR", raising=False)

    cfg = market_config.MarketAgentConfig()

    assert cfg.calendar_dir == synced


def test_ctrader_config_normalizes_legacy_last_quote_path(tmp_path) -> None:
    config_path = tmp_path / "ctrader-cli.json"
    config_path.write_text(
        """
        {
          "enabled": true,
          "accountId": "123456",
          "ctid": "trader@example.com",
          "password": "secret",
          "symbol": "XAUUSD",
          "snapshotPath": "user-data/ctrader-last-quote.json"
        }
        """,
        encoding="utf-8",
    )

    cfg = CTraderCliConfig.from_sources(
        MarketAgentConfig(repo_root=tmp_path, ctrader_config_path=config_path)
    )

    assert cfg.snapshot_path.name == "ctrader-live-quote.json"
