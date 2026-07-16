import json
import sqlite3

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


def test_load_alert_history_reads_sent_alerts_from_timeline_store(tmp_path) -> None:
    alerts_path = tmp_path / "alerts.ndjson"
    timeline_path = tmp_path / "timeline.sqlite"
    with sqlite3.connect(timeline_path) as connection:
        connection.executescript(
            """
            CREATE TABLE monitor_runs (id INTEGER PRIMARY KEY, run_started_at TEXT);
            CREATE TABLE alerts (
                id INTEGER PRIMARY KEY,
                monitor_run_id INTEGER,
                should_notify INTEGER,
                notification_level TEXT,
                reason TEXT,
                payload_json TEXT
            );
            CREATE TABLE analysis_results (
                id INTEGER PRIMARY KEY,
                monitor_run_id INTEGER,
                payload_json TEXT
            );
            """
        )
        connection.execute("INSERT INTO monitor_runs VALUES (1, '2026-05-19T00:05:00+08:00')")
        connection.execute("INSERT INTO monitor_runs VALUES (2, '2026-05-19T00:10:00+08:00')")
        connection.execute(
            "INSERT INTO alerts VALUES (1, 1, 0, 'none', 'suppressed', ?)",
            (json.dumps({"should_notify": False, "reason": "suppressed"}),),
        )
        connection.execute(
            "INSERT INTO alerts VALUES (2, 2, 1, 'attention', 'sent', ?)",
            (
                json.dumps(
                    {
                        "should_notify": True,
                        "notification_level": "attention",
                        "message": "XAUUSD move confirmed.",
                    }
                ),
            ),
        )
        connection.commit()

    rows = load_alert_history(alerts_path, timeline_path)

    assert len(rows) == 1
    assert rows[0]["message"] == "XAUUSD move confirmed."
    assert rows[0]["monitor_run_id"] == 2
    assert rows[0]["time"] == "2026-05-19T00:10:00+08:00"


def test_load_alert_history_enriches_legacy_sqlite_alert_from_ai_analysis(tmp_path) -> None:
    alerts_path = tmp_path / "alerts.ndjson"
    timeline_path = tmp_path / "timeline.sqlite"
    with sqlite3.connect(timeline_path) as connection:
        connection.executescript(
            """
            CREATE TABLE monitor_runs (id INTEGER PRIMARY KEY, run_started_at TEXT);
            CREATE TABLE alerts (
                id INTEGER PRIMARY KEY,
                monitor_run_id INTEGER,
                should_notify INTEGER,
                notification_level TEXT,
                reason TEXT,
                payload_json TEXT
            );
            CREATE TABLE analysis_results (
                id INTEGER PRIMARY KEY,
                monitor_run_id INTEGER,
                payload_json TEXT
            );
            """
        )
        connection.execute("INSERT INTO monitor_runs VALUES (7, '2026-05-19T00:15:00+08:00')")
        connection.execute(
            "INSERT INTO alerts VALUES (1, 7, 1, 'level_2', 'State changed or cooldown elapsed.', ?)",
            (json.dumps({"should_notify": True, "reason": "State changed or cooldown elapsed."}),),
        )
        connection.execute(
            "INSERT INTO analysis_results VALUES (1, 7, ?)",
            (
                json.dumps(
                    {
                        "user_message": "Gold pressure confirmed by DXY and yields.",
                        "summary": "Gold remains under pressure.",
                        "bias": "bearish_gold",
                        "main_driver": "yields",
                        "cause_status": "confirmed",
                        "confidence": "high",
                        "analysis_engine": "llm_validated",
                        "llm_status": "validated",
                    }
                ),
            ),
        )
        connection.commit()

    rows = load_alert_history(alerts_path, timeline_path)

    assert rows[0]["message"] == "Gold pressure confirmed by DXY and yields."
    assert rows[0]["main_driver"] == "yields"
    assert rows[0]["cause_status"] == "confirmed"
    assert rows[0]["confidence"] == "high"
    assert rows[0]["analysis"]["llm_status"] == "validated"


def test_load_alert_history_folds_repeated_sent_alerts(tmp_path) -> None:
    alerts_path = tmp_path / "alerts.ndjson"
    timeline_path = tmp_path / "timeline.sqlite"
    with sqlite3.connect(timeline_path) as connection:
        connection.executescript(
            """
            CREATE TABLE monitor_runs (id INTEGER PRIMARY KEY, run_started_at TEXT);
            CREATE TABLE alerts (
                id INTEGER PRIMARY KEY,
                monitor_run_id INTEGER,
                should_notify INTEGER,
                notification_level TEXT,
                reason TEXT,
                payload_json TEXT
            );
            CREATE TABLE analysis_results (
                id INTEGER PRIMARY KEY,
                monitor_run_id INTEGER,
                payload_json TEXT
            );
            """
        )
        for run_id, run_time in (
            (1, "2026-05-19T00:05:00+08:00"),
            (2, "2026-05-19T00:10:00+08:00"),
            (3, "2026-05-19T00:15:00+08:00"),
        ):
            connection.execute("INSERT INTO monitor_runs VALUES (?, ?)", (run_id, run_time))
            connection.execute(
                "INSERT INTO alerts VALUES (?, ?, 1, 'level_2', 'State changed or cooldown elapsed.', ?)",
                (
                    run_id,
                    run_id,
                    json.dumps(
                        {
                            "should_notify": True,
                            "notification_level": "level_2",
                            "message": "Gold remains under pressure.",
                            "main_driver": "yields",
                            "cause_status": "likely",
                            "telegram": {"status": "sent"},
                        }
                    ),
                ),
            )
        connection.commit()

    rows = load_alert_history(alerts_path, timeline_path)

    assert len(rows) == 1
    assert rows[0]["monitor_run_id"] == 3
    assert rows[0]["repeat_count"] == 3
    assert rows[0]["quiet_repeat_count"] == 2
    assert rows[0]["first_seen_at"] == "2026-05-19T00:05:00+08:00"
    assert rows[0]["last_seen_at"] == "2026-05-19T00:15:00+08:00"
