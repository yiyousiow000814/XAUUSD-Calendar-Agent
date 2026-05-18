import json

from src.xauusd_market_agent.history import load_alert_history


def test_load_alert_history_returns_latest_first(tmp_path) -> None:
    path = tmp_path / "alerts.ndjson"
    path.write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "time": "2026-05-19T00:00:00+08:00",
                        "notification_level": "level_2",
                        "message": "older",
                    }
                ),
                json.dumps(
                    {
                        "time": "2026-05-19T00:05:00+08:00",
                        "notification_level": "level_3",
                        "message": "newer",
                    }
                ),
            ]
        ),
        encoding="utf-8",
    )

    rows = load_alert_history(path)

    assert rows[0]["message"] == "newer"
    assert rows[1]["message"] == "older"
