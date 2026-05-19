import json
from datetime import datetime
from pathlib import Path

import pytest

from src.xauusd_market_agent.config import CTraderOpenApiConfig, MarketAgentConfig
from src.xauusd_market_agent.providers.ctrader_provider import CTraderProvider


class FakeBridgeRunner:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def __call__(self, command: str, payload: dict[str, object]) -> dict[str, object]:
        self.calls.append((command, payload))
        response = self.responses.get(command)
        if isinstance(response, Exception):
            raise response
        if response is None:
            raise AssertionError(f"unexpected command {command}")
        return response


def _full_config(tmp_path: Path) -> CTraderOpenApiConfig:
    return CTraderOpenApiConfig(
        enabled=True,
        client_id="client-id",
        client_secret="client-secret",
        access_token="access-token",
        refresh_token="refresh-token",
        account_id="123456",
        environment="demo",
        symbol="XAUUSD",
        symbol_id=None,
        app_redirect_uri="http://localhost/callback",
        config_path=tmp_path / "ctrader-openapi.json",
        token_store_path=tmp_path / "ctrader-token.json",
        snapshot_path=tmp_path / "ctrader-last-quote.json",
        allow_saved_snapshot_fallback=True,
        quote_timeout_seconds=8,
        quote_stale_after_seconds=15,
        bridge_python_executable="python",
    )


def test_ctrader_openapi_config_loads_from_env(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("CTRADER_CLIENT_ID", "client-id")
    monkeypatch.setenv("CTRADER_CLIENT_SECRET", "client-secret")
    monkeypatch.setenv("CTRADER_ACCESS_TOKEN", "access-token")
    monkeypatch.setenv("CTRADER_REFRESH_TOKEN", "refresh-token")
    monkeypatch.setenv("CTRADER_ACCOUNT_ID", "123456")
    monkeypatch.setenv("CTRADER_ENVIRONMENT", "live")
    monkeypatch.setenv("CTRADER_SYMBOL", "XAUUSD")
    monkeypatch.setenv("CTRADER_APP_REDIRECT_URI", "http://localhost/callback")
    monkeypatch.setenv("CTRADER_TOKEN_STORE_PATH", str(tmp_path / "tokens.json"))
    monkeypatch.setenv("CTRADER_SNAPSHOT_PATH", str(tmp_path / "snapshot.json"))
    monkeypatch.setenv("CTRADER_CONFIG_PATH", str(tmp_path / "ctrader-openapi.json"))
    monkeypatch.setenv("CTRADER_BRIDGE_PYTHON", "python")

    cfg = CTraderOpenApiConfig.from_sources(MarketAgentConfig(repo_root=tmp_path))

    assert cfg.enabled is True
    assert cfg.client_id == "client-id"
    assert cfg.client_secret == "client-secret"
    assert cfg.access_token == "access-token"
    assert cfg.refresh_token == "refresh-token"
    assert cfg.environment == "live"
    assert cfg.symbol == "XAUUSD"


def test_ctrader_openapi_config_loads_from_json_files(tmp_path) -> None:
    config_path = tmp_path / "ctrader-openapi.json"
    token_store_path = tmp_path / "ctrader-token.json"
    config_path.write_text(
        json.dumps(
            {
                "enabled": True,
                "clientId": "client-id",
                "accountId": "123456",
                "environment": "demo",
                "symbol": "XAU/USD",
                "tokenStorePath": str(token_store_path),
                "snapshotPath": str(tmp_path / "snapshot.json"),
            }
        ),
        encoding="utf-8",
    )
    token_store_path.write_text(
        json.dumps(
            {
                "clientSecret": "client-secret",
                "accessToken": "access-token",
                "refreshToken": "refresh-token",
            }
        ),
        encoding="utf-8",
    )

    cfg = CTraderOpenApiConfig.from_sources(
        MarketAgentConfig(
            repo_root=tmp_path,
            ctrader_config_path=config_path,
            ctrader_token_store_path=token_store_path,
        )
    )

    assert cfg.enabled is True
    assert cfg.client_id == "client-id"
    assert cfg.client_secret == "client-secret"
    assert cfg.access_token == "access-token"
    assert cfg.refresh_token == "refresh-token"
    assert cfg.symbol == "XAU/USD"


def test_ctrader_masked_config_hides_secrets(tmp_path) -> None:
    provider = CTraderProvider(openapi_config=_full_config(tmp_path), bridge_runner=FakeBridgeRunner({}))

    payload = provider.masked_config_payload()

    assert payload["enabled"] is True
    assert payload["clientIdMasked"].startswith("cl")
    assert payload["clientSecretMasked"] != "client-secret"
    assert payload["accessTokenMasked"] != "access-token"
    assert payload["refreshTokenMasked"] != "refresh-token"
    assert payload["hasAccessToken"] is True
    assert payload["hasRefreshToken"] is True


def test_ctrader_missing_config_reports_disabled_without_crash(tmp_path) -> None:
    provider = CTraderProvider(
        openapi_config=CTraderOpenApiConfig.default(tmp_path),
        bridge_runner=FakeBridgeRunner({}),
    )

    rows, health = provider.fetch_latest(datetime.fromisoformat("2026-05-19T07:15:00+08:00"))

    assert rows == []
    assert health.is_available is False
    assert health.data_mode == "unavailable"
    assert "not configured" in health.error.lower()


def test_ctrader_live_quote_uses_bridge_result_and_writes_snapshot(tmp_path) -> None:
    snapshot_path = tmp_path / "ctrader-last-quote.json"
    provider = CTraderProvider(
        openapi_config=_full_config(tmp_path),
        bridge_runner=FakeBridgeRunner(
            {
                "quote": {
                    "ok": True,
                    "quote": {
                        "symbol": "XAUUSD",
                        "symbol_id": 777,
                        "bid": 4512.34,
                        "ask": 4512.72,
                        "mid": 4512.53,
                        "timestamp": "2026-05-19T10:15:23+08:00",
                        "source": "cTrader OpenAPI",
                        "source_type": "spot",
                        "environment": "demo",
                        "account_id": "123456",
                    },
                    "provider_health": {
                        "source": "cTrader",
                        "source_type": "spot",
                        "data_mode": "live_seen",
                        "is_available": True,
                        "is_stale": False,
                        "stale_reason": "",
                        "error": "",
                        "current_value": 4512.53,
                        "data_timestamp": "2026-05-19T10:15:23+08:00",
                        "fetched_at": "2026-05-19T10:15:24+08:00",
                        "raw_source_id": "777",
                    },
                }
            }
        ),
        saved_snapshot_path=snapshot_path,
    )

    rows, health = provider.fetch_latest(datetime.fromisoformat("2026-05-19T10:15:30+08:00"))

    assert rows[-1]["symbol"] == "XAUUSD"
    assert rows[-1]["source_type"] == "spot"
    assert rows[-1]["bid"] == pytest.approx(4512.34)
    assert rows[-1]["ask"] == pytest.approx(4512.72)
    assert rows[-1]["close"] == pytest.approx(4512.53)
    assert health.source_type == "spot"
    assert health.data_mode == "live_seen"
    assert snapshot_path.exists()
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    assert snapshot["symbol_id"] == 777
    assert snapshot["mid"] == pytest.approx(4512.53)


def test_ctrader_saved_snapshot_fallback_is_stale_and_not_fresh(tmp_path) -> None:
    snapshot_path = tmp_path / "snapshot.json"
    snapshot_path.write_text(
        json.dumps(
            {
                "timestamp": "2026-05-19T07:10:00+08:00",
                "symbol": "XAUUSD",
                "symbol_id": 777,
                "bid": 4502.3,
                "ask": 4502.7,
                "mid": 4502.5,
                "source": "cTrader OpenAPI",
                "source_type": "spot",
                "environment": "demo",
                "account_id": "123456",
            }
        ),
        encoding="utf-8",
    )
    provider = CTraderProvider(
        openapi_config=_full_config(tmp_path),
        bridge_runner=FakeBridgeRunner({"quote": RuntimeError("auth failed")}),
        saved_snapshot_path=snapshot_path,
    )

    rows, health = provider.fetch_latest(datetime.fromisoformat("2026-05-19T07:15:20+08:00"))

    assert rows[-1]["source_type"] == "spot_snapshot"
    assert rows[-1]["data_mode"] == "stale"
    assert rows[-1]["is_stale"] is True
    assert health.is_available is True
    assert health.is_stale is True
    assert health.data_mode == "stale"


def test_ctrader_symbol_resolution_exact_normalized_and_override(tmp_path) -> None:
    bridge = FakeBridgeRunner(
        {
            "resolve-symbol": {
                "ok": True,
                "symbol": {"symbolId": 777, "symbolName": "XAUUSD", "digits": 2, "pipPosition": 1},
            }
        }
    )
    provider = CTraderProvider(openapi_config=_full_config(tmp_path), bridge_runner=bridge)

    symbol = provider.resolve_symbol()

    assert symbol["symbolId"] == 777
    assert bridge.calls[0][0] == "resolve-symbol"
    assert bridge.calls[0][1]["symbol"] == "XAUUSD"

    override_provider = CTraderProvider(
        openapi_config=CTraderOpenApiConfig(**{**_full_config(tmp_path).__dict__, "symbol_id": 999}),
        bridge_runner=bridge,
    )
    override_symbol = override_provider.resolve_symbol()
    assert override_symbol["symbolId"] == 999


def test_ctrader_backfill_returns_spot_rows(tmp_path) -> None:
    provider = CTraderProvider(
        openapi_config=_full_config(tmp_path),
        bridge_runner=FakeBridgeRunner(
            {
                "backfill": {
                    "ok": True,
                    "bars": [
                        {
                            "symbol": "XAUUSD",
                            "data_timestamp": "2026-05-19T06:00:00+08:00",
                            "open": 4500.0,
                            "high": 4502.0,
                            "low": 4499.0,
                            "close": 4501.0,
                            "bid": None,
                            "ask": None,
                            "source": "cTrader OpenAPI",
                            "source_type": "spot",
                            "data_mode": "backfilled",
                            "is_stale": False,
                            "stale_reason": "",
                        },
                        {
                            "symbol": "XAUUSD",
                            "data_timestamp": "2026-05-19T06:01:00+08:00",
                            "open": 4501.0,
                            "high": 4504.0,
                            "low": 4498.0,
                            "close": 4503.0,
                            "bid": None,
                            "ask": None,
                            "source": "cTrader OpenAPI",
                            "source_type": "spot",
                            "data_mode": "backfilled",
                            "is_stale": False,
                            "stale_reason": "",
                        },
                    ],
                    "provider_health": {
                        "source": "cTrader",
                        "source_type": "spot",
                        "data_mode": "backfilled",
                        "is_available": True,
                        "is_stale": False,
                        "stale_reason": "",
                        "error": "",
                        "current_value": 4503.0,
                        "previous_value": 4501.0,
                        "change_value": 0.04,
                        "change_unit": "percent",
                        "data_timestamp": "2026-05-19T06:01:00+08:00",
                        "fetched_at": "2026-05-19T06:02:00+08:00",
                        "raw_source_id": "777",
                    },
                }
            }
        ),
    )

    rows, health = provider.backfill(
        datetime.fromisoformat("2026-05-19T06:00:00+08:00"),
        datetime.fromisoformat("2026-05-19T06:02:00+08:00"),
    )

    assert len(rows) == 2
    assert rows[0]["source_type"] == "spot"
    assert rows[0]["data_mode"] == "backfilled"
    assert health.source_type == "spot"
    assert health.data_mode == "backfilled"
