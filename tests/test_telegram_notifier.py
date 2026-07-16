import json

from src.xauusd_market_agent.config import MarketAgentConfig
from src.xauusd_market_agent.notifier import TelegramNotificationSink


class FakeResponse:
    def raise_for_status(self) -> None:
        return None


class FailingResponse:
    def raise_for_status(self) -> None:
        raise RuntimeError("telegram unavailable")


class FakeSession:
    def __init__(self, response=None) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.response = response or FakeResponse()

    def post(self, url: str, json: dict, timeout: int):
        self.calls.append((url, {"json": json, "timeout": timeout}))
        return self.response


def test_telegram_notifier_skips_when_not_configured() -> None:
    sink = TelegramNotificationSink(bot_token="", chat_id="")

    sent = sink.emit({"message": "test"})

    assert sent is False


def test_telegram_notifier_posts_message_when_configured() -> None:
    session = FakeSession()
    sink = TelegramNotificationSink(
        bot_token="token123",
        chat_id="chat456",
        session=session,
        timeout_seconds=5,
    )

    sent = sink.emit({"message": "Alert body"})

    assert sent is True
    assert session.calls[0][0].endswith("/bottoken123/sendMessage")
    assert session.calls[0][1]["json"]["chat_id"] == "chat456"
    assert session.calls[0][1]["json"]["text"] == "Alert body"


def test_telegram_notifier_returns_failure_result_without_raising() -> None:
    session = FakeSession(response=FailingResponse())
    sink = TelegramNotificationSink(
        bot_token="token123",
        chat_id="chat456",
        session=session,
        timeout_seconds=5,
    )

    result = sink.send({"message": "Alert body", "notification_level": "level_3"})

    assert result["sent"] is False
    assert result["status"] == "failed"
    assert result["error"] == "telegram unavailable"


def test_telegram_notifier_respects_level_filter() -> None:
    session = FakeSession()
    sink = TelegramNotificationSink(
        bot_token="token123",
        chat_id="chat456",
        session=session,
        enabled_levels={"level_3"},
    )

    result = sink.send({"message": "Level two", "notification_level": "level_2"})

    assert result["sent"] is False
    assert result["status"] == "filtered"
    assert session.calls == []


def test_market_agent_config_reads_telegram_json_config(tmp_path, monkeypatch) -> None:
    config_path = tmp_path / "market-agent-telegram.json"
    config_path.write_text(
        json.dumps(
            {
                "enabled": True,
                "botToken": "json-token",
                "chatId": "json-chat",
                "timeoutSeconds": 7,
                "levels": ["level_3"],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("MARKET_AGENT_TELEGRAM_CONFIG_PATH", str(config_path))
    monkeypatch.delenv("MARKET_AGENT_TELEGRAM_ENABLED", raising=False)
    monkeypatch.delenv("MARKET_AGENT_TELEGRAM_BOT_TOKEN", raising=False)
    monkeypatch.delenv("MARKET_AGENT_TELEGRAM_CHAT_ID", raising=False)
    monkeypatch.delenv("MARKET_AGENT_TELEGRAM_TIMEOUT_SECONDS", raising=False)
    monkeypatch.delenv("MARKET_AGENT_TELEGRAM_LEVELS", raising=False)

    cfg = MarketAgentConfig(repo_root=tmp_path)

    assert cfg.telegram_enabled is True
    assert cfg.telegram_bot_token == "json-token"
    assert cfg.telegram_chat_id == "json-chat"
    assert cfg.telegram_timeout_seconds == 7
    assert cfg.telegram_levels == ["level_3"]


def test_market_agent_config_telegram_env_overrides_json(tmp_path, monkeypatch) -> None:
    config_path = tmp_path / "market-agent-telegram.json"
    config_path.write_text(
        json.dumps(
            {
                "enabled": False,
                "botToken": "json-token",
                "chatId": "json-chat",
                "timeoutSeconds": 7,
                "levels": ["level_2"],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("MARKET_AGENT_TELEGRAM_CONFIG_PATH", str(config_path))
    monkeypatch.setenv("MARKET_AGENT_TELEGRAM_ENABLED", "true")
    monkeypatch.setenv("MARKET_AGENT_TELEGRAM_BOT_TOKEN", "env-token")
    monkeypatch.setenv("MARKET_AGENT_TELEGRAM_CHAT_ID", "env-chat")
    monkeypatch.setenv("MARKET_AGENT_TELEGRAM_TIMEOUT_SECONDS", "13")
    monkeypatch.setenv("MARKET_AGENT_TELEGRAM_LEVELS", "all")

    cfg = MarketAgentConfig(repo_root=tmp_path)

    assert cfg.telegram_enabled is True
    assert cfg.telegram_bot_token == "env-token"
    assert cfg.telegram_chat_id == "env-chat"
    assert cfg.telegram_timeout_seconds == 13
    assert cfg.telegram_levels == ["level_1", "level_2", "level_3"]
