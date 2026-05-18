from src.xauusd_market_agent.notifier import TelegramNotificationSink


class FakeResponse:
    def raise_for_status(self) -> None:
        return None


class FakeSession:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    def post(self, url: str, json: dict, timeout: int):
        self.calls.append((url, {"json": json, "timeout": timeout}))
        return FakeResponse()


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
