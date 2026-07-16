import json
from datetime import datetime
from pathlib import Path

import pytest

from src.xauusd_market_agent.config import CTraderCliConfig, MarketAgentConfig
from src.xauusd_market_agent.providers.ctrader_bridge import BridgeError, BridgeRequest, CTraderCliBridge
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


def _full_config(tmp_path: Path) -> CTraderCliConfig:
    return CTraderCliConfig(
        enabled=True,
        account_id="123456",
        ctid="trader@example.com",
        password="super-secret-password",
        environment="demo",
        symbol="XAUUSD",
        symbol_id=None,
        config_path=tmp_path / "ctrader-cli.json",
        snapshot_path=tmp_path / "ctrader-last-quote.json",
        allow_saved_snapshot_fallback=True,
        quote_timeout_seconds=8,
        quote_stale_after_seconds=15,
        cli_executable="ctrader-cli",
    )


def _bridge_enabled_config(tmp_path: Path, **overrides: object) -> CTraderCliConfig:
    return CTraderCliConfig(
        **{**_full_config(tmp_path).__dict__, "quote_bridge_enabled": True, **overrides}
    )


def test_ctrader_cli_config_loads_from_env(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("CTRADER_ACCOUNT_ID", "123456")
    monkeypatch.setenv("CTRADER_CTID", "trader@example.com")
    monkeypatch.setenv("CTRADER_PASSWORD", "super-secret-password")
    monkeypatch.setenv("CTRADER_ENVIRONMENT", "live")
    monkeypatch.setenv("CTRADER_SYMBOL", "XAUUSD")
    monkeypatch.setenv("CTRADER_SNAPSHOT_PATH", str(tmp_path / "snapshot.json"))
    monkeypatch.setenv("CTRADER_CONFIG_PATH", str(tmp_path / "ctrader-cli.json"))
    monkeypatch.setenv("CTRADER_CLI_EXECUTABLE", "ctrader-cli-test")

    cfg = CTraderCliConfig.from_sources(MarketAgentConfig(repo_root=tmp_path))

    assert cfg.enabled is True
    assert cfg.account_id == "123456"
    assert cfg.ctid == "trader@example.com"
    assert cfg.password == "super-secret-password"
    assert cfg.environment == "live"
    assert cfg.symbol == "XAUUSD"
    assert cfg.cli_executable == "ctrader-cli-test"


def test_ctrader_cli_config_loads_from_json_file(tmp_path) -> None:
    config_path = tmp_path / "ctrader-cli.json"
    config_path.write_text(
        json.dumps(
            {
                "enabled": True,
                "accountId": "123456",
                "ctid": "trader@example.com",
                "password": "super-secret-password",
                "environment": "demo",
                "symbol": "XAU/USD",
                "snapshotPath": str(tmp_path / "snapshot.json"),
            }
        ),
        encoding="utf-8",
    )

    cfg = CTraderCliConfig.from_sources(
        MarketAgentConfig(
            repo_root=tmp_path,
            ctrader_config_path=config_path,
        )
    )

    assert cfg.enabled is True
    assert cfg.account_id == "123456"
    assert cfg.ctid == "trader@example.com"
    assert cfg.password == "super-secret-password"
    assert cfg.symbol == "XAU/USD"


def test_ctrader_cli_config_disables_shell_adapter_quote_bridge_by_default(tmp_path, monkeypatch) -> None:
    config_path = tmp_path / "ctrader-cli.json"
    adapter_path = tmp_path / "ctrader-cli-adapter.cmd"
    adapter_path.write_text("@echo off\n", encoding="utf-8")
    config_path.write_text(
        json.dumps(
            {
                "enabled": True,
                "accountId": "123456",
                "ctid": "trader@example.com",
                "password": "super-secret-password",
                "symbol": "XAUUSD",
                "cliExecutable": str(adapter_path),
                "quoteBridgeEnabled": True,
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.delenv("CTRADER_ALLOW_CBOT_BRIDGE", raising=False)
    cfg = CTraderCliConfig.from_sources(
        MarketAgentConfig(repo_root=tmp_path, ctrader_config_path=config_path)
    )

    assert cfg.cli_executable == str(adapter_path)
    assert cfg.quote_bridge_enabled is False


def test_ctrader_cli_config_allows_shell_adapter_quote_bridge_with_explicit_opt_in(tmp_path, monkeypatch) -> None:
    config_path = tmp_path / "ctrader-cli.json"
    adapter_path = tmp_path / "ctrader-cli-adapter.cmd"
    adapter_path.write_text("@echo off\n", encoding="utf-8")
    config_path.write_text(
        json.dumps(
            {
                "enabled": True,
                "accountId": "123456",
                "ctid": "trader@example.com",
                "password": "super-secret-password",
                "symbol": "XAUUSD",
                "cliExecutable": str(adapter_path),
                "quoteBridgeEnabled": True,
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setenv("CTRADER_ALLOW_CBOT_BRIDGE", "true")
    cfg = CTraderCliConfig.from_sources(
        MarketAgentConfig(repo_root=tmp_path, ctrader_config_path=config_path)
    )

    assert cfg.quote_bridge_enabled is True


def test_ctrader_masked_config_hides_secrets(tmp_path) -> None:
    provider = CTraderProvider(cli_config=_full_config(tmp_path), bridge_runner=FakeBridgeRunner({}))

    payload = provider.masked_config_payload()

    assert payload["enabled"] is True
    assert payload["ctidMasked"].startswith("tr")
    assert payload["passwordMasked"] != "super-secret-password"
    assert payload["hasPassword"] is True


def test_ctrader_cli_adapter_redacts_password_from_cli_errors(tmp_path, monkeypatch) -> None:
    class FailedProcess:
        returncode = 1
        stdout = "login failed for super-secret-password"
        stderr = "bad password super-secret-password"

    def fake_run(*args, **kwargs):
        return FailedProcess()

    monkeypatch.setattr("src.xauusd_market_agent.providers.ctrader_bridge.subprocess.run", fake_run)
    request = BridgeRequest.from_payload(
        {
            "accountId": "123456",
            "ctid": "trader@example.com",
            "password": "super-secret-password",
            "symbol": "XAUUSD",
            "snapshotPath": str(tmp_path / "snapshot.json"),
        }
    )

    with pytest.raises(BridgeError) as exc_info:
        CTraderCliBridge(request).quote()

    assert "super-secret-password" not in str(exc_info.value)
    assert "***" in str(exc_info.value)


def test_ctrader_cli_adapter_cmd_is_disabled_without_opt_in(tmp_path, monkeypatch) -> None:
    cmd_path = tmp_path / "ctrader-cli-adapter.cmd"
    ps1_path = tmp_path / "ctrader-cli-adapter.ps1"
    cmd_path.write_text("@echo off\n", encoding="utf-8")
    ps1_path.write_text("Write-Output '{}'\n", encoding="utf-8")
    request = BridgeRequest.from_payload(
        {
            "accountId": "123456",
            "ctid": "trader@example.com",
            "password": "super-secret-password",
            "symbol": "XAUUSD",
            "snapshotPath": str(tmp_path / "snapshot.json"),
            "cliExecutable": str(cmd_path),
        }
    )

    monkeypatch.delenv("CTRADER_ALLOW_CLI_ADAPTER_SHELL", raising=False)
    with pytest.raises(BridgeError) as exc_info:
        CTraderCliBridge(request)._build_cli_command("quote")

    assert "disabled" in str(exc_info.value).lower()


def test_ctrader_cli_adapter_cmd_uses_hidden_powershell_script_with_opt_in(tmp_path, monkeypatch) -> None:
    cmd_path = tmp_path / "ctrader-cli-adapter.cmd"
    ps1_path = tmp_path / "ctrader-cli-adapter.ps1"
    cmd_path.write_text("@echo off\n", encoding="utf-8")
    ps1_path.write_text("Write-Output '{}'\n", encoding="utf-8")
    request = BridgeRequest.from_payload(
        {
            "accountId": "123456",
            "ctid": "trader@example.com",
            "password": "super-secret-password",
            "symbol": "XAUUSD",
            "snapshotPath": str(tmp_path / "snapshot.json"),
            "cliExecutable": str(cmd_path),
        }
    )

    monkeypatch.setenv("CTRADER_ALLOW_CLI_ADAPTER_SHELL", "true")
    command = CTraderCliBridge(request)._build_cli_command("quote")

    assert command[:9] == [
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
    ]
    assert command[9] == str(ps1_path)
    assert command[10] == "quote"


def test_ctrader_quote_uses_direct_dotnet_bridge_when_local_adapter_exists(tmp_path) -> None:
    adapter_dir = tmp_path
    cmd_path = adapter_dir / "ctrader-cli-adapter.cmd"
    ps1_path = adapter_dir / "ctrader-cli-adapter.ps1"
    project_path = adapter_dir / "ctrader-quote-bridge" / "ctrader-quote-bridge.csproj"
    bridge_dir = adapter_dir / "ctrader-quote-bridge" / "bin" / "Release" / "net6.0"
    bridge_dir.mkdir(parents=True)
    project_path.write_text("<Project />", encoding="utf-8")
    algo_path = bridge_dir / "XauusdQuoteBridge.algo"
    algo_path.write_text("algo", encoding="utf-8")
    dll_path = adapter_dir / "ctrader-cli.dll"
    dll_path.write_text("dll", encoding="utf-8")
    cmd_path.write_text("@echo off\n", encoding="utf-8")
    ps1_path.write_text(f'$dll = "{dll_path}"\n', encoding="utf-8")
    request = BridgeRequest.from_payload(
        {
            "accountId": "123456",
            "ctid": "trader@example.com",
            "password": "super-secret-password",
            "symbol": "XAUUSD",
            "snapshotPath": str(tmp_path / "snapshot.json"),
            "cliExecutable": str(cmd_path),
        }
    )

    command = CTraderCliBridge(request)._local_quote_bridge_command()

    assert command is not None
    assert command[:3] == ["dotnet", str(dll_path), "run"]
    assert Path(command[3]).name.lower() == algo_path.name.lower()


def test_ctrader_quote_does_not_launch_cbot_bridge_without_opt_in(tmp_path, monkeypatch) -> None:
    adapter_dir = tmp_path
    cmd_path = adapter_dir / "ctrader-cli-adapter.cmd"
    ps1_path = adapter_dir / "ctrader-cli-adapter.ps1"
    project_path = adapter_dir / "ctrader-quote-bridge" / "ctrader-quote-bridge.csproj"
    bridge_dir = adapter_dir / "ctrader-quote-bridge" / "bin" / "Release" / "net6.0"
    bridge_dir.mkdir(parents=True)
    project_path.write_text("<Project />", encoding="utf-8")
    (bridge_dir / "XAUUSDQuoteBridge.algo").write_text("algo", encoding="utf-8")
    dll_path = adapter_dir / "ctrader-cli.dll"
    dll_path.write_text("dll", encoding="utf-8")
    cmd_path.write_text("@echo off\n", encoding="utf-8")
    ps1_path.write_text(f'$dll = "{dll_path}"\n', encoding="utf-8")
    calls: list[object] = []

    def fake_run(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError("cTrader cBot bridge should not be spawned by default")

    monkeypatch.delenv("CTRADER_ALLOW_CBOT_BRIDGE", raising=False)
    monkeypatch.setattr("src.xauusd_market_agent.providers.ctrader_bridge.subprocess.run", fake_run)
    request = BridgeRequest.from_payload(
        {
            "accountId": "123456",
            "ctid": "trader@example.com",
            "password": "super-secret-password",
            "symbol": "XAUUSD",
            "snapshotPath": str(tmp_path / "snapshot.json"),
            "cliExecutable": str(cmd_path),
        }
    )

    with pytest.raises(BridgeError) as exc_info:
        CTraderCliBridge(request).quote()

    assert calls == []
    assert "disabled" in str(exc_info.value).lower()


def test_ctrader_cli_adapter_marks_old_quote_stale(tmp_path, monkeypatch) -> None:
    class QuoteProcess:
        returncode = 0
        stdout = json.dumps(
            {
                "quote": {
                    "symbol": "XAUUSD",
                    "symbol_id": 777,
                    "bid": 4512.3,
                    "ask": 4512.7,
                    "timestamp": "2026-05-19T10:15:23+08:00",
                },
                "provider_health": {
                    "data_mode": "live_seen",
                    "is_available": True,
                    "is_stale": False,
                    "stale_reason": "",
                },
            }
        )
        stderr = ""

    def fake_run(*args, **kwargs):
        return QuoteProcess()

    monkeypatch.setattr("src.xauusd_market_agent.providers.ctrader_bridge.subprocess.run", fake_run)
    request = BridgeRequest.from_payload(
        {
            "accountId": "123456",
            "ctid": "trader@example.com",
            "password": "super-secret-password",
            "symbol": "XAUUSD",
            "snapshotPath": str(tmp_path / "snapshot.json"),
            "quoteStaleAfterSeconds": 15,
        }
    )

    result = CTraderCliBridge(request).quote()

    assert result["provider_health"]["data_mode"] == "stale"
    assert result["provider_health"]["is_stale"] is True
    assert "market may be closed" in result["provider_health"]["stale_reason"]


def test_ctrader_missing_config_reports_disabled_without_crash(tmp_path) -> None:
    provider = CTraderProvider(
        cli_config=CTraderCliConfig.default(tmp_path),
        bridge_runner=FakeBridgeRunner({}),
    )

    rows, health = provider.fetch_latest(datetime.fromisoformat("2026-05-19T07:15:00+08:00"))

    assert rows == []
    assert health.is_available is False
    assert health.data_mode == "unavailable"
    assert "cli credentials" in health.error.lower()


def test_ctrader_provider_prefers_fresh_saved_live_snapshot_without_bridge(tmp_path) -> None:
    snapshot_path = tmp_path / "ctrader-live-quote.json"
    snapshot_path.write_text(
        json.dumps(
            {
                "symbol": "XAUUSD",
                "symbol_id": 777,
                "bid": 4508.0,
                "ask": 4508.4,
                "mid": 4508.2,
                "timestamp": "2026-05-25T16:00:05+08:00",
            }
        ),
        encoding="utf-8",
    )
    provider = CTraderProvider(
        cli_config=CTraderCliConfig(
            enabled=True,
            account_id="123456",
            ctid="trader@example.com",
            password="super-secret-password",
            environment="demo",
            symbol="XAUUSD",
            symbol_id=777,
            config_path=tmp_path / "ctrader-cli.json",
            snapshot_path=snapshot_path,
            allow_saved_snapshot_fallback=True,
            quote_timeout_seconds=8,
            quote_stale_after_seconds=15,
            cli_executable="ctrader-cli",
        ),
        bridge_runner=FakeBridgeRunner({}),
        saved_snapshot_path=snapshot_path,
    )

    rows, health = provider.fetch_latest(datetime.fromisoformat("2026-05-25T16:00:10+08:00"))

    assert len(rows) == 1
    assert rows[0]["source"] == "cTrader live snapshot"
    assert health.data_mode == "live_seen"
    assert health.is_available is True
    assert health.is_stale is False
    assert health.current_value == pytest.approx(4508.2)


def test_ctrader_provider_uses_m1_bar_from_fresh_live_snapshot(tmp_path) -> None:
    snapshot_path = tmp_path / "ctrader-live-quote.json"
    snapshot_path.write_text(
        json.dumps(
            {
                "symbol": "XAUUSD",
                "symbol_id": 777,
                "bid": 4523.22,
                "ask": 4523.27,
                "mid": 4523.245,
                "timestamp": "2026-05-26T09:12:07.2610000Z",
                "m1_bar": {
                    "symbol": "XAUUSD",
                    "data_timestamp": "2026-05-26T09:12:00.0000000Z",
                    "open": 4523.16,
                    "high": 4523.26,
                    "low": 4523.11,
                    "close": 4523.22,
                    "source": "cTrader CLI live stream",
                    "source_type": "spot_m1",
                    "data_mode": "live_seen",
                },
            }
        ),
        encoding="utf-8",
    )
    provider = CTraderProvider(
        cli_config=CTraderCliConfig(
            enabled=True,
            account_id="123456",
            ctid="trader@example.com",
            password="super-secret-password",
            environment="demo",
            symbol="XAUUSD",
            symbol_id=777,
            config_path=tmp_path / "ctrader-cli.json",
            snapshot_path=snapshot_path,
            allow_saved_snapshot_fallback=False,
            quote_timeout_seconds=8,
            quote_stale_after_seconds=45,
            cli_executable="ctrader-cli",
        ),
        bridge_runner=FakeBridgeRunner({}),
        saved_snapshot_path=snapshot_path,
    )

    rows, health = provider.fetch_latest(datetime.fromisoformat("2026-05-26T17:12:10+08:00"))

    assert len(rows) == 1
    assert rows[0]["source_type"] == "spot_m1"
    assert rows[0]["data_timestamp"] == "2026-05-26T09:12:00.0000000Z"
    assert rows[0]["close"] == pytest.approx(4523.22)
    assert health.data_mode == "live_seen"


def test_ctrader_provider_does_not_return_stale_snapshot_as_current_when_stream_is_starting(tmp_path) -> None:
    snapshot_path = tmp_path / "ctrader-live-quote.json"
    snapshot_path.write_text(
        json.dumps(
            {
                "symbol": "XAUUSD",
                "symbol_id": 777,
                "bid": 4508.0,
                "ask": 4508.4,
                "mid": 4508.2,
                "timestamp": "2026-05-25T16:00:00+08:00",
            }
        ),
        encoding="utf-8",
    )
    bridge = FakeBridgeRunner({"quote": {"ok": True}})
    provider = CTraderProvider(
        cli_config=CTraderCliConfig(
            **{
                **_full_config(tmp_path).__dict__,
                "snapshot_path": snapshot_path,
                "quote_bridge_enabled": False,
                "quote_timeout_seconds": 0,
            }
        ),
        bridge_runner=bridge,
        saved_snapshot_path=snapshot_path,
        live_stream_starter=lambda _payload: None,
    )

    rows, health = provider.fetch_latest(datetime.fromisoformat("2026-05-25T16:01:00+08:00"))

    assert bridge.calls == []
    assert rows == []
    assert health.data_mode == "unavailable"
    assert health.is_available is False
    assert "fresh cTrader live stream snapshot" in health.error


def test_ctrader_provider_starts_live_stream_when_snapshot_missing_and_stream_dead(tmp_path) -> None:
    started_payloads = []
    status_path = tmp_path / "ctrader_live_stream_status.json"
    status_path.write_text(json.dumps({"running": True, "pid": 999999}), encoding="utf-8")
    snapshot_path = tmp_path / "ctrader-live-quote.json"
    provider = CTraderProvider(
        cli_config=CTraderCliConfig(
            **{
                **_full_config(tmp_path).__dict__,
                "snapshot_path": snapshot_path,
                "allow_saved_snapshot_fallback": False,
                "quote_bridge_enabled": False,
                "quote_timeout_seconds": 0,
            }
        ),
        saved_snapshot_path=snapshot_path,
        live_stream_status_path=status_path,
        live_stream_starter=lambda payload: started_payloads.append(payload),
        process_checker=lambda _pid: False,
    )

    rows, health = provider.fetch_latest(datetime.fromisoformat("2026-06-17T13:00:00+08:00"))

    assert rows == []
    assert "supervisor process is not running" in health.error
    assert len(started_payloads) == 1
    assert started_payloads[0]["snapshotPath"] == str(snapshot_path)
    assert started_payloads[0]["statusPath"] == str(status_path)
    stopped_status = json.loads(status_path.read_text(encoding="utf-8"))
    assert stopped_status["running"] is False
    assert stopped_status["phase"] == "stopped"


def test_ctrader_provider_does_not_restart_alive_live_stream(tmp_path) -> None:
    started_payloads = []
    status_path = tmp_path / "ctrader_live_stream_status.json"
    status_path.write_text(json.dumps({"running": True, "pid": 1234}), encoding="utf-8")
    snapshot_path = tmp_path / "ctrader-live-quote.json"
    provider = CTraderProvider(
        cli_config=CTraderCliConfig(
            **{
                **_full_config(tmp_path).__dict__,
                "snapshot_path": snapshot_path,
                "allow_saved_snapshot_fallback": False,
                "quote_bridge_enabled": False,
                "quote_timeout_seconds": 0,
            }
        ),
        saved_snapshot_path=snapshot_path,
        live_stream_status_path=status_path,
        live_stream_starter=lambda payload: started_payloads.append(payload),
        process_checker=lambda _pid: True,
    )

    provider.fetch_latest(datetime.fromisoformat("2026-06-17T13:00:00+08:00"))

    assert started_payloads == []


def test_ctrader_provider_restarts_live_stream_when_bridge_process_is_dead(tmp_path) -> None:
    started_payloads = []
    status_path = tmp_path / "ctrader_live_stream_status.json"
    status_path.write_text(json.dumps({"running": True, "pid": 1234, "bridgePid": 9999}), encoding="utf-8")
    snapshot_path = tmp_path / "ctrader-live-quote.json"
    provider = CTraderProvider(
        cli_config=CTraderCliConfig(
            **{
                **_full_config(tmp_path).__dict__,
                "snapshot_path": snapshot_path,
                "allow_saved_snapshot_fallback": False,
                "quote_bridge_enabled": False,
                "quote_timeout_seconds": 0,
            }
        ),
        saved_snapshot_path=snapshot_path,
        live_stream_status_path=status_path,
        live_stream_starter=lambda payload: started_payloads.append(payload),
        process_checker=lambda pid: pid == 1234,
    )

    rows, health = provider.fetch_latest(datetime.fromisoformat("2026-06-17T13:00:00+08:00"))

    assert rows == []
    assert "bridge process is not running" in health.error
    assert len(started_payloads) == 1
    stopped_status = json.loads(status_path.read_text(encoding="utf-8"))
    assert stopped_status["running"] is False
    assert stopped_status["phase"] == "stopped"
    assert "bridge process" in stopped_status["lastError"]


def test_ctrader_provider_keeps_alive_stream_with_stale_snapshot_as_context(tmp_path) -> None:
    started_payloads = []
    status_path = tmp_path / "ctrader_live_stream_status.json"
    status_path.write_text(json.dumps({"running": True, "pid": 1234}), encoding="utf-8")
    snapshot_path = tmp_path / "ctrader-live-quote.json"
    snapshot_path.write_text(
        json.dumps(
            {
                "symbol": "XAUUSD",
                "bid": 4320.1,
                "ask": 4320.2,
                "mid": 4320.15,
                "timestamp": "2026-06-17T01:00:00+00:00",
            }
        ),
        encoding="utf-8",
    )
    provider = CTraderProvider(
        cli_config=CTraderCliConfig(
            **{
                **_full_config(tmp_path).__dict__,
                "snapshot_path": snapshot_path,
                "allow_saved_snapshot_fallback": False,
                "quote_bridge_enabled": False,
                "quote_timeout_seconds": 0,
                "quote_stale_after_seconds": 30,
            }
        ),
        saved_snapshot_path=snapshot_path,
        live_stream_status_path=status_path,
        live_stream_starter=lambda payload: started_payloads.append(payload),
        process_checker=lambda _pid: True,
    )

    rows, health = provider.fetch_latest(datetime.fromisoformat("2026-06-17T13:00:00+08:00"))

    assert len(rows) == 1
    assert rows[0]["data_mode"] == "stale"
    assert rows[0]["close"] == pytest.approx(4320.15)
    assert health.data_mode == "stale"
    assert health.is_available is True
    assert health.is_stale is True
    assert "stale" in health.stale_reason.lower()
    assert started_payloads == []
    current_status = json.loads(status_path.read_text(encoding="utf-8"))
    assert current_status["running"] is True


def test_ctrader_provider_uses_fresh_snapshot_written_after_dead_stream_restart(tmp_path) -> None:
    started_payloads = []
    status_path = tmp_path / "ctrader_live_stream_status.json"
    status_path.write_text(json.dumps({"running": True, "pid": 1234}), encoding="utf-8")
    snapshot_path = tmp_path / "ctrader-live-quote.json"
    snapshot_path.write_text(
        json.dumps(
            {
                "symbol": "XAUUSD",
                "bid": 4320.1,
                "ask": 4320.2,
                "mid": 4320.15,
                "timestamp": "2026-06-17T01:00:00+00:00",
            }
        ),
        encoding="utf-8",
    )

    def start_stream(payload: dict[str, object]) -> None:
        started_payloads.append(payload)
        snapshot_path.write_text(
            json.dumps(
                {
                    "symbol": "XAUUSD",
                    "bid": 4330.1,
                    "ask": 4330.2,
                    "mid": 4330.15,
                    "timestamp": "2026-06-17T05:00:02+00:00",
                }
            ),
            encoding="utf-8",
        )

    provider = CTraderProvider(
        cli_config=CTraderCliConfig(
            **{
                **_full_config(tmp_path).__dict__,
                "snapshot_path": snapshot_path,
                "allow_saved_snapshot_fallback": False,
                "quote_bridge_enabled": False,
                "quote_timeout_seconds": 1,
                "quote_stale_after_seconds": 30,
            }
        ),
        saved_snapshot_path=snapshot_path,
        live_stream_status_path=status_path,
        live_stream_starter=start_stream,
        process_checker=lambda _pid: False,
    )

    rows, health = provider.fetch_latest(datetime.fromisoformat("2026-06-17T13:00:05+08:00"))

    assert len(started_payloads) == 1
    assert rows
    assert rows[0]["data_mode"] == "live_seen"
    assert rows[0]["close"] == pytest.approx(4330.15)
    assert health.data_mode == "live_seen"
    assert health.is_stale is False


def test_ctrader_provider_accepts_existing_fresh_snapshot_after_stream_restart(tmp_path) -> None:
    started_payloads = []
    status_path = tmp_path / "ctrader_live_stream_status.json"
    status_path.write_text(json.dumps({"running": True, "pid": 1234}), encoding="utf-8")
    snapshot_path = tmp_path / "ctrader-live-quote.json"
    snapshot_path.write_text(
        json.dumps(
            {
                "symbol": "XAUUSD",
                "bid": 4330.1,
                "ask": 4330.2,
                "mid": 4330.15,
                "timestamp": "2026-06-17T05:00:02+00:00",
            }
        ),
        encoding="utf-8",
    )
    provider = CTraderProvider(
        cli_config=CTraderCliConfig(
            **{
                **_full_config(tmp_path).__dict__,
                "snapshot_path": snapshot_path,
                "allow_saved_snapshot_fallback": False,
                "quote_bridge_enabled": False,
                "quote_timeout_seconds": 1,
                "quote_stale_after_seconds": 30,
            }
        ),
        saved_snapshot_path=snapshot_path,
        live_stream_status_path=status_path,
        live_stream_starter=lambda payload: started_payloads.append(payload),
        process_checker=lambda _pid: False,
    )

    rows, health = provider.fetch_latest(datetime.fromisoformat("2026-06-17T13:00:05+08:00"))

    assert len(started_payloads) == 0
    assert rows
    assert rows[0]["data_mode"] == "live_seen"
    assert health.data_mode == "live_seen"
    assert health.is_stale is False


def test_ctrader_provider_treats_weekend_stale_live_snapshot_as_market_closed_context(tmp_path) -> None:
    snapshot_path = tmp_path / "ctrader-live-quote.json"
    snapshot_path.write_text(
        json.dumps(
            {
                "symbol": "XAUUSD",
                "symbol_id": 777,
                "bid": 4541.13,
                "ask": 4541.53,
                "mid": 4541.33,
                "timestamp": "2026-05-29T20:56:59.947000+00:00",
                "m1_bar": {
                    "symbol": "XAUUSD",
                    "data_timestamp": "2026-05-29T20:56:00+00:00",
                    "open": 4541.0,
                    "high": 4541.53,
                    "low": 4540.9,
                    "close": 4541.33,
                    "source": "cTrader CLI live stream",
                    "source_type": "spot_m1",
                    "data_mode": "live_seen",
                },
            }
        ),
        encoding="utf-8",
    )
    bridge = FakeBridgeRunner({"quote": {"ok": True}})
    provider = CTraderProvider(
        cli_config=CTraderCliConfig(
            **{
                **_full_config(tmp_path).__dict__,
                "snapshot_path": snapshot_path,
                "allow_saved_snapshot_fallback": False,
                "quote_bridge_enabled": False,
                "quote_stale_after_seconds": 45,
            }
        ),
        bridge_runner=bridge,
        saved_snapshot_path=snapshot_path,
    )

    rows, health = provider.fetch_latest(datetime.fromisoformat("2026-05-31T16:28:00+08:00"))

    assert bridge.calls == []
    assert rows
    assert rows[-1]["data_mode"] == "stale"
    assert rows[-1]["is_stale"] is True
    assert rows[-1]["stale_reason"]
    assert health.is_available is True
    assert health.is_stale is True
    assert health.data_mode == "stale"
    assert health.current_value == pytest.approx(4541.33)
    assert health.metadata["stale_classification"] == "market_closed"
    assert "closed" in health.stale_reason.lower()


def test_ctrader_cli_adapter_preserves_m1_bar_payload(tmp_path, monkeypatch) -> None:
    class QuoteProcess:
        returncode = 0
        stdout = json.dumps(
            {
                "quote": {
                    "symbol": "XAUUSD",
                    "symbol_id": 777,
                    "bid": 4512.3,
                    "ask": 4512.7,
                    "timestamp": "2026-05-19T10:15:24+08:00",
                },
                "bars": [
                    {
                        "symbol": "XAUUSD",
                        "data_timestamp": "2026-05-19T10:15:00+08:00",
                        "open": 4510.0,
                        "high": 4513.2,
                        "low": 4509.5,
                        "close": 4512.5,
                        "bid": 4512.3,
                        "ask": 4512.7,
                        "source": "cTrader CLI cBot bridge",
                        "source_type": "spot_m1",
                        "data_mode": "live_seen",
                    }
                ],
                "provider_health": {
                    "data_mode": "live_seen",
                    "is_available": True,
                    "is_stale": False,
                    "stale_reason": "",
                },
            }
        )
        stderr = ""

    def fake_run(*args, **kwargs):
        return QuoteProcess()

    monkeypatch.setattr("src.xauusd_market_agent.providers.ctrader_bridge.subprocess.run", fake_run)
    request = BridgeRequest.from_payload(
        {
            "accountId": "123456",
            "ctid": "trader@example.com",
            "password": "super-secret-password",
            "symbol": "XAUUSD",
            "snapshotPath": str(tmp_path / "snapshot.json"),
        }
    )

    result = CTraderCliBridge(request).quote()

    assert result["quote"]["timestamp"] == "2026-05-19T10:15:24+08:00"
    assert result["bars"][0]["source_type"] == "spot_m1"
    assert result["bars"][0]["data_timestamp"] == "2026-05-19T10:15:00+08:00"


def test_ctrader_live_quote_uses_bridge_result_and_writes_snapshot(tmp_path) -> None:
    snapshot_path = tmp_path / "ctrader-last-quote.json"
    provider = CTraderProvider(
        cli_config=_bridge_enabled_config(tmp_path),
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
                        "source": "cTrader CLI",
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


def test_ctrader_live_quote_prefers_m1_bar_rows_when_available(tmp_path) -> None:
    snapshot_path = tmp_path / "ctrader-last-quote.json"
    provider = CTraderProvider(
        cli_config=_bridge_enabled_config(tmp_path),
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
                        "timestamp": "2026-05-19T10:15:24+08:00",
                        "source": "cTrader CLI",
                        "source_type": "spot",
                        "environment": "demo",
                        "account_id": "123456",
                    },
                    "bars": [
                        {
                            "symbol": "XAUUSD",
                            "data_timestamp": "2026-05-19T10:15:00+08:00",
                            "open": 4511.0,
                            "high": 4513.2,
                            "low": 4510.5,
                            "close": 4512.6,
                            "bid": 4512.34,
                            "ask": 4512.72,
                            "source": "cTrader CLI cBot bridge",
                            "source_type": "spot_m1",
                            "data_mode": "live_seen",
                            "is_stale": False,
                            "stale_reason": "",
                        }
                    ],
                    "provider_health": {
                        "source": "cTrader",
                        "source_type": "spot",
                        "data_mode": "live_seen",
                        "is_available": True,
                        "is_stale": False,
                        "stale_reason": "",
                        "error": "",
                        "current_value": 4512.53,
                        "data_timestamp": "2026-05-19T10:15:24+08:00",
                        "fetched_at": "2026-05-19T10:15:24+08:00",
                        "raw_source_id": "777",
                    },
                }
            }
        ),
        saved_snapshot_path=snapshot_path,
    )

    rows, health = provider.fetch_latest(datetime.fromisoformat("2026-05-19T10:15:30+08:00"))

    assert rows[-1]["source_type"] == "spot_m1"
    assert rows[-1]["data_timestamp"] == "2026-05-19T10:15:00+08:00"
    assert rows[-1]["close"] == pytest.approx(4512.6)
    assert health.source_type == "spot"
    assert health.data_mode == "live_seen"
    assert snapshot_path.exists()


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
                "source": "cTrader CLI",
                "source_type": "spot",
                "environment": "demo",
                "account_id": "123456",
            }
        ),
        encoding="utf-8",
    )
    provider = CTraderProvider(
        cli_config=_bridge_enabled_config(tmp_path),
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


def test_ctrader_stale_quote_uses_latest_history_close(tmp_path) -> None:
    bridge = FakeBridgeRunner(
        {
            "quote": {
                "ok": True,
                "quote": {
                    "symbol": "XAUUSD",
                    "symbol_id": 777,
                    "bid": 4488.0,
                    "ask": 4488.4,
                    "mid": 4488.2,
                    "timestamp": "2026-05-16T04:55:00+08:00",
                    "source": "cTrader CLI",
                    "source_type": "spot",
                    "environment": "demo",
                    "account_id": "123456",
                },
                "provider_health": {
                    "source": "cTrader",
                    "source_type": "spot",
                    "data_mode": "stale",
                    "is_available": True,
                    "is_stale": True,
                    "stale_reason": "cTrader quote is old; market may be closed.",
                    "error": "",
                    "current_value": 4488.2,
                    "data_timestamp": "2026-05-16T04:55:00+08:00",
                    "fetched_at": "2026-05-17T08:00:00+08:00",
                    "raw_source_id": "777",
                },
            },
            "backfill": {
                "ok": True,
                "bars": [
                    {
                        "symbol": "XAUUSD",
                        "data_timestamp": "2026-05-16T04:55:00+08:00",
                        "open": 4490.0,
                        "high": 4491.0,
                        "low": 4487.0,
                        "close": 4488.0,
                    },
                    {
                        "symbol": "XAUUSD",
                        "data_timestamp": "2026-05-16T04:59:00+08:00",
                        "open": 4488.0,
                        "high": 4492.0,
                        "low": 4487.5,
                        "close": 4491.4,
                    },
                ],
                "provider_health": {
                    "source": "cTrader",
                    "source_type": "spot",
                    "data_mode": "backfilled",
                    "is_available": True,
                    "is_stale": False,
                    "data_timestamp": "2026-05-16T04:59:00+08:00",
                    "fetched_at": "2026-05-17T08:00:00+08:00",
                },
            },
        }
    )
    provider = CTraderProvider(
        cli_config=_bridge_enabled_config(tmp_path),
        bridge_runner=bridge,
        saved_snapshot_path=tmp_path / "snapshot.json",
    )

    rows, health = provider.fetch_latest(datetime.fromisoformat("2026-05-17T08:00:00+08:00"))

    assert [call[0] for call in bridge.calls] == ["quote", "backfill"]
    assert rows[-1]["source"] == "cTrader history"
    assert rows[-1]["data_mode"] == "stale"
    assert rows[-1]["close"] == pytest.approx(4491.4)
    assert health.current_value == pytest.approx(4491.4)
    assert health.previous_value == pytest.approx(4488.0)
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
    provider = CTraderProvider(cli_config=_full_config(tmp_path), bridge_runner=bridge)

    symbol = provider.resolve_symbol()

    assert symbol["symbolId"] == 777
    assert bridge.calls[0][0] == "resolve-symbol"
    assert bridge.calls[0][1]["symbol"] == "XAUUSD"

    override_provider = CTraderProvider(
        cli_config=CTraderCliConfig(**{**_full_config(tmp_path).__dict__, "symbol_id": 999}),
        bridge_runner=bridge,
    )
    override_symbol = override_provider.resolve_symbol()
    assert override_symbol["symbolId"] == 999


def test_ctrader_backfill_returns_spot_rows(tmp_path) -> None:
    provider = CTraderProvider(
        cli_config=_bridge_enabled_config(tmp_path),
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
                            "source": "cTrader CLI",
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
                            "source": "cTrader CLI",
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
