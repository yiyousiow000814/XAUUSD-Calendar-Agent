import json
from datetime import datetime

from src.xauusd_market_agent.providers.ctrader_provider import CTraderProvider


def test_ctrader_missing_config_does_not_crash() -> None:
    provider = CTraderProvider()

    rows, health = provider.fetch_latest(datetime.fromisoformat("2026-05-19T07:15:00+08:00"))

    assert rows == []
    assert health.is_available is False
    assert health.data_mode == "unavailable"


def test_ctrader_saved_snapshot_fallback_works(tmp_path) -> None:
    snapshot_path = tmp_path / "snapshot.json"
    snapshot_path.write_text(
        json.dumps(
            {
                "timestamp": "2026-05-19T07:10:00+08:00",
                "symbol": "XAUUSD",
                "price": 4502.5,
                "bid": 4502.3,
                "ask": 4502.7,
            }
        ),
        encoding="utf-8",
    )
    provider = CTraderProvider(saved_snapshot_path=snapshot_path)

    rows, health = provider.fetch_latest(datetime.fromisoformat("2026-05-19T07:15:00+08:00"))

    assert rows[0]["source_type"] == "spot_snapshot"
    assert rows[0]["is_stale"] is True
    assert health.is_available is True
    assert health.data_mode == "stale"


def test_ctrader_with_credentials_is_explicitly_disabled_not_implemented(monkeypatch) -> None:
    monkeypatch.setenv("CTRADER_CLIENT_ID", "id")
    monkeypatch.setenv("CTRADER_CLIENT_SECRET", "secret")
    monkeypatch.setenv("CTRADER_ACCESS_TOKEN", "token")
    monkeypatch.setenv("CTRADER_ACCOUNT_ID", "acct")

    provider = CTraderProvider()
    rows, health = provider.fetch_latest(datetime.fromisoformat("2026-05-19T07:15:00+08:00"))

    assert rows == []
    assert health.is_available is False
    assert "disabled in this build" in health.error
