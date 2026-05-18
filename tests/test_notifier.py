from src.xauusd_market_agent.notifier import FileNotificationSink


def test_file_notification_sink_appends_alert_record(tmp_path) -> None:
    sink = FileNotificationSink(tmp_path / "alerts.ndjson")
    sink.emit({"message": "test"})

    text = (tmp_path / "alerts.ndjson").read_text(encoding="utf-8")
    assert '"message": "test"' in text
