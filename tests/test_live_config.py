from src.xauusd_market_agent.config import MarketAgentConfig


def test_market_agent_config_uses_windows_friendly_defaults() -> None:
    cfg = MarketAgentConfig()

    assert "data" in str(cfg.price_data_path)
    assert cfg.news_lookback_minutes == 30
    assert cfg.post_move_news_minutes == 120
