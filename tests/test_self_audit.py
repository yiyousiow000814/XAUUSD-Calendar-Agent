from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime

from src.xauusd_market_agent.config import MarketAgentConfig
from src.xauusd_market_agent.self_audit import audit_market_agent, read_current_status, read_provider_health_status


def _create_self_audit_tables(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE monitor_runs (
            id INTEGER PRIMARY KEY,
            run_started_at TEXT,
            data_mode TEXT,
            backfill_required INTEGER,
            no_news_found INTEGER
        );
        CREATE TABLE provider_health (id INTEGER PRIMARY KEY, monitor_run_id INTEGER, provider_key TEXT, payload_json TEXT);
        CREATE TABLE evidence_packets (id INTEGER PRIMARY KEY, monitor_run_id INTEGER, payload_json TEXT);
        CREATE TABLE analysis_results (id INTEGER PRIMARY KEY, monitor_run_id INTEGER, payload_json TEXT);
        CREATE TABLE market_price_bars (id INTEGER PRIMARY KEY, monitor_run_id INTEGER);
        CREATE TABLE news_items (id INTEGER PRIMARY KEY, monitor_run_id INTEGER);
        CREATE TABLE calendar_events (id INTEGER PRIMARY KEY, monitor_run_id INTEGER);
        CREATE TABLE state_transitions (id INTEGER PRIMARY KEY, monitor_run_id INTEGER, payload_json TEXT);
        CREATE TABLE timeline_events (id INTEGER PRIMARY KEY, monitor_run_id INTEGER, event_time TEXT);
        """
    )


def _insert_required_run_artifacts(
    connection: sqlite3.Connection,
    *,
    monitor_run_id: int = 1,
    news_rows: int = 1,
    calendar_rows: int = 0,
    timeline_rows: int = 1,
) -> None:
    connection.execute(
        "INSERT INTO provider_health (monitor_run_id, provider_key, payload_json) VALUES (?, 'xauusd', ?)",
        (monitor_run_id, json.dumps({"source": "cTrader"})),
    )
    connection.execute("INSERT INTO market_price_bars (monitor_run_id) VALUES (?)", (monitor_run_id,))
    for _ in range(news_rows):
        connection.execute("INSERT INTO news_items (monitor_run_id) VALUES (?)", (monitor_run_id,))
    for _ in range(calendar_rows):
        connection.execute("INSERT INTO calendar_events (monitor_run_id) VALUES (?)", (monitor_run_id,))
    connection.execute(
        "INSERT INTO state_transitions (monitor_run_id, payload_json) VALUES (?, ?)",
        (monitor_run_id, json.dumps({"stored": True})),
    )
    for _ in range(timeline_rows):
        connection.execute(
            "INSERT INTO timeline_events (monitor_run_id, event_time) VALUES (?, ?)",
            (monitor_run_id, "2026-06-13T12:00:00+08:00"),
        )


def test_current_status_reads_latest_run_evidence_analysis_and_storage(tmp_path):
    timeline_path = tmp_path / "timeline.sqlite"
    connection = sqlite3.connect(timeline_path)
    try:
        _create_self_audit_tables(connection)
        connection.execute(
            "INSERT INTO monitor_runs VALUES (10, ?, 'stale', 0, 0)",
            ("2026-06-14T14:00:00+08:00",),
        )
        connection.execute(
            "INSERT INTO evidence_packets VALUES (1, 10, ?)",
            (
                json.dumps(
                    {
                        "evidence_chain_status": {
                            "status": "context_only",
                            "can_show_current_conclusion": False,
                            "missing_required": ["live_xauusd_spot"],
                        },
                        "evidence_status": {
                            "dxy": "market_closed_context",
                            "us10y": "market_closed_context",
                            "us2y": "market_closed_context",
                            "oil": "market_closed_context",
                            "vix_equities": "market_closed_context",
                            "news": "relevant_news_found",
                        },
                    }
                ),
            ),
        )
        connection.execute(
            "INSERT INTO analysis_results VALUES (1, 10, ?)",
            (
                json.dumps(
                    {
                        "analysis_engine": "llm_validated",
                        "llm_status": "validated",
                        "main_driver": "unknown",
                        "cause_status": "unconfirmed",
                        "summary": "Context updated while market is closed.",
                        "should_notify": False,
                        "market_read": {
                            "status": "context_only",
                            "headline": "Market closed; news watch continues",
                            "coverage": {"sensors": "0 of 8 usable"},
                        },
                    }
                ),
            ),
        )
        _insert_required_run_artifacts(connection, monitor_run_id=10, news_rows=2, calendar_rows=1)
        connection.commit()
    finally:
        connection.close()
    monitor_status_path = tmp_path / "monitor_status.json"
    monitor_status_path.write_text(json.dumps({"running": True, "phase": "idle_between_runs"}), encoding="utf-8")
    cfg = MarketAgentConfig(timeline_store_path=timeline_path, monitor_status_path=monitor_status_path)

    payload = read_current_status(cfg)

    assert payload["ok"] is True
    assert payload["run"]["id"] == 10
    assert payload["evidence_chain_status"]["status"] == "context_only"
    assert payload["analysis"]["llm_status"] == "validated"
    assert payload["analysis"]["market_read"]["coverage"]["sensors"] == "0 fresh / 8 context"
    assert payload["storage_counts"]["news"] == 2
    assert payload["monitor_status"]["running"] is True


def test_current_status_normalizes_feed_paused_ctrader_activity(tmp_path):
    timeline_path = tmp_path / "timeline.sqlite"
    connection = sqlite3.connect(timeline_path)
    try:
        _create_self_audit_tables(connection)
        connection.execute(
            "INSERT INTO monitor_runs VALUES (11, ?, 'stale', 0, 0)",
            ("2026-06-17T13:00:00+08:00",),
        )
        connection.execute(
            "INSERT INTO evidence_packets VALUES (1, 11, ?)",
            (json.dumps({"evidence_chain_status": {"status": "context_only"}}),),
        )
        connection.execute(
            "INSERT INTO analysis_results VALUES (1, 11, ?)",
            (json.dumps({"llm_status": "validated"}),),
        )
        _insert_required_run_artifacts(connection, monitor_run_id=11)
        connection.commit()
    finally:
        connection.close()
    monitor_status_path = tmp_path / "monitor_status.json"
    monitor_status_path.write_text(
        json.dumps(
            {
                "running": True,
                "activity": {
                    "ctrader": {
                        "status": "market_closed",
                        "label": "Market closed",
                        "detail": "Last XAUUSD price 4,332.59 is fixed until the market reopens.",
                        "providerHealth": {
                            "current_value": 4332.59,
                            "metadata": {
                                "market_closed": False,
                                "stale_classification": "feed_paused",
                            },
                        },
                    }
                },
            }
        ),
        encoding="utf-8",
    )
    cfg = MarketAgentConfig(timeline_store_path=timeline_path, monitor_status_path=monitor_status_path)

    payload = read_current_status(cfg)

    ctrader = payload["monitor_status"]["activity"]["ctrader"]
    assert ctrader["status"] == "stale"
    assert ctrader["label"] == "cTrader not refreshing"
    assert "market reopens" not in ctrader["detail"]


def test_current_status_normalizes_history_rows_from_activity_summary(tmp_path):
    timeline_path = tmp_path / "timeline.sqlite"
    connection = sqlite3.connect(timeline_path)
    try:
        _create_self_audit_tables(connection)
        connection.execute(
            "INSERT INTO monitor_runs VALUES (12, ?, 'stale', 0, 0)",
            ("2026-06-17T13:00:00+08:00",),
        )
        connection.execute(
            "INSERT INTO evidence_packets VALUES (1, 12, ?)",
            (json.dumps({"evidence_chain_status": {"status": "context_only"}}),),
        )
        connection.execute(
            "INSERT INTO analysis_results VALUES (1, 12, ?)",
            (json.dumps({"llm_status": "validated"}),),
        )
        _insert_required_run_artifacts(connection, monitor_run_id=12)
        connection.commit()
    finally:
        connection.close()
    monitor_status_path = tmp_path / "monitor_status.json"
    monitor_status_path.write_text(
        json.dumps(
            {
                "running": True,
                "activity": {
                    "history": {
                        "status": "idle",
                        "detail": "No backfill gap detected for this run.",
                        "storedRows": 579,
                        "jobs": [{"title": "History fetch", "output": "579 stored row(s) across XAUUSD, DXY"}],
                    },
                    "summary": {
                        "symbolRows": {
                            "XAUUSD": 1,
                            "DXY": 300,
                            "US10Y": 278,
                        }
                    },
                },
            }
        ),
        encoding="utf-8",
    )
    cfg = MarketAgentConfig(timeline_store_path=timeline_path, monitor_status_path=monitor_status_path)

    payload = read_current_status(cfg)

    history = payload["monitor_status"]["activity"]["history"]
    assert history["xauusdRows"] == 1
    assert history["sensorRows"] == 578
    assert history["jobs"][0]["output"] == "1 XAUUSD row(s), 578 sensor row(s)"
    assert "needs another fresh bar" in history["detail"]


def test_provider_health_status_reads_latest_provider_rows(tmp_path):
    timeline_path = tmp_path / "timeline.sqlite"
    connection = sqlite3.connect(timeline_path)
    try:
        _create_self_audit_tables(connection)
        connection.execute(
            "INSERT INTO monitor_runs VALUES (3, ?, 'live_seen', 0, 0)",
            ("2026-06-14T14:00:00+08:00",),
        )
        connection.execute(
            "INSERT INTO provider_health VALUES (1, 3, 'xauusd', ?)",
            (
                json.dumps(
                    {
                        "source": "cTrader",
                        "source_type": "spot",
                        "data_mode": "live_seen",
                        "is_available": True,
                        "is_stale": False,
                    }
                ),
            ),
        )
        connection.execute(
            "INSERT INTO evidence_packets VALUES (1, 3, ?)",
            (json.dumps({"evidence_status": {"news": "relevant_news_found"}}),),
        )
        connection.commit()
    finally:
        connection.close()
    cfg = MarketAgentConfig(timeline_store_path=timeline_path)

    payload = read_provider_health_status(cfg)

    assert payload["ok"] is True
    assert payload["run"]["id"] == 3
    assert payload["providers"] == [
        {
            "provider_key": "xauusd",
            "source": "cTrader",
            "source_type": "spot",
            "data_mode": "live_seen",
            "is_available": True,
            "is_stale": False,
            "effective_status": "fresh",
            "usable_as_context": True,
        }
    ]


def test_provider_health_status_marks_market_closed_context_as_usable(tmp_path):
    timeline_path = tmp_path / "timeline.sqlite"
    connection = sqlite3.connect(timeline_path)
    try:
        _create_self_audit_tables(connection)
        connection.execute(
            "INSERT INTO monitor_runs VALUES (4, ?, 'stale', 0, 0)",
            ("2026-06-14T14:00:00+08:00",),
        )
        connection.execute(
            "INSERT INTO provider_health VALUES (1, 4, 'dxy', ?)",
            (
                json.dumps(
                    {
                        "source": "DX-Y.NYB",
                        "data_mode": "live_seen",
                        "is_available": True,
                        "is_stale": True,
                    }
                ),
            ),
        )
        connection.execute(
            "INSERT INTO evidence_packets VALUES (1, 4, ?)",
            (json.dumps({"evidence_status": {"dxy": "market_closed_context"}}),),
        )
        connection.commit()
    finally:
        connection.close()
    cfg = MarketAgentConfig(timeline_store_path=timeline_path)

    payload = read_provider_health_status(cfg)

    assert payload["providers"][0]["effective_status"] == "market_closed_context"
    assert payload["providers"][0]["usable_as_context"] is True


def test_provider_health_status_marks_weekend_xauusd_stale_as_context(tmp_path):
    timeline_path = tmp_path / "timeline.sqlite"
    connection = sqlite3.connect(timeline_path)
    try:
        _create_self_audit_tables(connection)
        connection.execute(
            "INSERT INTO monitor_runs VALUES (5, ?, 'stale', 0, 0)",
            ("2026-06-14T14:00:00+08:00",),
        )
        connection.execute(
            "INSERT INTO provider_health VALUES (1, 5, 'xauusd', ?)",
            (
                json.dumps(
                    {
                        "source": "cTrader",
                        "data_mode": "stale",
                        "is_available": True,
                        "is_stale": True,
                        "stale_reason": "XAUUSD is inside the weekend closed window.",
                    }
                ),
            ),
        )
        connection.commit()
    finally:
        connection.close()
    cfg = MarketAgentConfig(timeline_store_path=timeline_path)

    payload = read_provider_health_status(cfg)

    assert payload["providers"][0]["effective_status"] == "market_closed_context"
    assert payload["providers"][0]["usable_as_context"] is True


def test_self_audit_reports_partial_live_gate_with_healthy_context(tmp_path):
    timeline_path = tmp_path / "timeline.sqlite"
    calendar_dir = tmp_path / "Economic_Calendar"
    year_dir = calendar_dir / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text(
        json.dumps([{"Date": "2026-06-20", "Time": "15:00", "Event": "PMI"}]),
        encoding="utf-8",
    )

    connection = sqlite3.connect(timeline_path)
    try:
        _create_self_audit_tables(connection)
        connection.execute(
            "INSERT INTO monitor_runs VALUES (1, ?, 'stale', 0, 0)",
            ("2026-06-11T12:00:00+08:00",),
        )
        packet = {
            "evidence_chain_status": {
                "can_show_current_conclusion": False,
                "missing_required": ["live_xauusd_spot"],
            },
            "provider_health": {"calendar": {"metadata": {"calendar_dir": str(calendar_dir)}}},
            "calendar_events": [{"event": "PMI"}],
            "news": [{"title": "Oil headline"}],
        }
        connection.execute("INSERT INTO evidence_packets VALUES (1, 1, ?)", (json.dumps(packet),))
        connection.execute(
            "INSERT INTO analysis_results VALUES (1, 1, ?)",
            (json.dumps({"analysis_engine": "rule_based", "llm_status": "unavailable"}),),
        )
        _insert_required_run_artifacts(connection, calendar_rows=1)
        connection.commit()
    finally:
        connection.close()

    cfg = MarketAgentConfig(
        calendar_dir=calendar_dir,
        timeline_store_path=timeline_path,
        state_store_path=tmp_path / "state.json",
        alerts_output_path=tmp_path / "alerts.ndjson",
        monitor_lock_path=tmp_path / "monitor.lock",
        monitor_status_path=tmp_path / "monitor_status.json",
    )

    audit = audit_market_agent(cfg, now=datetime.fromisoformat("2026-06-11T12:02:00+08:00"))
    checks = {check["name"]: check for check in audit["checks"]}

    assert audit["status"] == "degraded"
    assert checks["latest_run"]["status"] == "pass"
    assert checks["evidence_gate"]["status"] == "warn"
    assert checks["calendar_source"]["status"] == "pass"
    assert checks["calendar_context"]["status"] == "pass"
    assert checks["news_context"]["status"] == "pass"
    assert checks["ai_or_rule_analysis"]["status"] == "pass"
    assert checks["replay_storage"]["status"] == "pass"


def test_self_audit_treats_empty_current_calendar_window_as_healthy_when_dataset_covers_today(tmp_path):
    timeline_path = tmp_path / "timeline.sqlite"
    calendar_dir = tmp_path / "Economic_Calendar"
    year_dir = calendar_dir / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text(
        json.dumps(
            [
                {"Date": "2026-06-12", "Time": "22:00", "Event": "Prior Event"},
                {"Date": "2026-06-13", "Time": "03:00", "Event": "Early Event"},
                {"Date": "2026-06-14", "Time": "09:00", "Event": "Future Event"},
            ]
        ),
        encoding="utf-8",
    )

    connection = sqlite3.connect(timeline_path)
    try:
        _create_self_audit_tables(connection)
        connection.execute(
            "INSERT INTO monitor_runs VALUES (1, ?, 'live_seen', 0, 0)",
            ("2026-06-13T12:00:00+08:00",),
        )
        packet = {
            "evidence_chain_status": {
                "can_show_current_conclusion": True,
                "missing_required": [],
            },
            "provider_health": {"calendar": {"metadata": {"calendar_dir": str(calendar_dir)}}},
            "calendar_events": [],
            "news": [{"title": "Oil headline"}],
        }
        connection.execute("INSERT INTO evidence_packets VALUES (1, 1, ?)", (json.dumps(packet),))
        connection.execute(
            "INSERT INTO analysis_results VALUES (1, 1, ?)",
            (json.dumps({"analysis_engine": "llm_validated", "llm_status": "validated"}),),
        )
        _insert_required_run_artifacts(connection)
        connection.commit()
    finally:
        connection.close()

    cfg = MarketAgentConfig(
        calendar_dir=calendar_dir,
        timeline_store_path=timeline_path,
        state_store_path=tmp_path / "state.json",
        alerts_output_path=tmp_path / "alerts.ndjson",
        monitor_lock_path=tmp_path / "monitor.lock",
        monitor_status_path=tmp_path / "monitor_status.json",
    )

    audit = audit_market_agent(cfg, now=datetime.fromisoformat("2026-06-13T12:02:00+08:00"))
    checks = {check["name"]: check for check in audit["checks"]}

    assert checks["calendar_source"]["status"] == "pass"
    assert checks["calendar_context"]["status"] == "pass"
    assert "no event is scheduled" in checks["calendar_context"]["detail"]


def test_self_audit_treats_market_closed_context_as_healthy_context(tmp_path):
    timeline_path = tmp_path / "timeline.sqlite"
    calendar_dir = tmp_path / "Economic_Calendar"
    year_dir = calendar_dir / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text(
        json.dumps([{"Date": "2026-06-13", "Time": "03:00", "Event": "Early Event"}]),
        encoding="utf-8",
    )

    connection = sqlite3.connect(timeline_path)
    try:
        _create_self_audit_tables(connection)
        connection.execute(
            "INSERT INTO monitor_runs VALUES (1, ?, 'stale', 0, 0)",
            ("2026-06-13T12:00:00+08:00",),
        )
        packet = {
            "evidence_chain_status": {
                "can_show_current_conclusion": False,
                "missing_required": ["live_xauusd_spot", "xauusd_recent_history"],
            },
            "provider_health": {
                "xauusd": {
                    "is_available": True,
                    "is_stale": True,
                    "stale_reason": "XAUUSD is inside the weekend closed window; last cTrader quote is context only until the market reopens.",
                    "metadata": {"market_closed": True, "stale_classification": "market_closed"},
                },
                "calendar": {"metadata": {"calendar_dir": str(calendar_dir)}},
            },
            "calendar_events": [],
            "news": [{"title": "Oil headline"}],
        }
        connection.execute("INSERT INTO evidence_packets VALUES (1, 1, ?)", (json.dumps(packet),))
        connection.execute(
            "INSERT INTO analysis_results VALUES (1, 1, ?)",
            (json.dumps({"analysis_engine": "llm_validated", "llm_status": "validated"}),),
        )
        _insert_required_run_artifacts(connection)
        connection.commit()
    finally:
        connection.close()

    cfg = MarketAgentConfig(
        calendar_dir=calendar_dir,
        timeline_store_path=timeline_path,
        state_store_path=tmp_path / "state.json",
        alerts_output_path=tmp_path / "alerts.ndjson",
        monitor_lock_path=tmp_path / "monitor.lock",
        monitor_status_path=tmp_path / "monitor_status.json",
    )

    audit = audit_market_agent(cfg, now=datetime.fromisoformat("2026-06-13T12:02:00+08:00"))
    checks = {check["name"]: check for check in audit["checks"]}

    assert audit["status"] == "healthy"
    assert checks["evidence_gate"]["status"] == "pass"
    assert "market is closed" in checks["evidence_gate"]["detail"]


def test_self_audit_reports_stopped_monitor_loop_when_status_file_exists(tmp_path):
    timeline_path = tmp_path / "timeline.sqlite"
    calendar_dir = tmp_path / "Economic_Calendar"
    year_dir = calendar_dir / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text(
        json.dumps([{"Date": "2026-06-13", "Time": "03:00", "Event": "Early Event"}]),
        encoding="utf-8",
    )
    monitor_status_path = tmp_path / "monitor_status.json"
    monitor_status_path.write_text(
        json.dumps(
            {
                "running": False,
                "phase": "stopped",
                "autoStart": False,
                "lastRunAt": "2026-06-13T12:00:00+08:00",
            }
        ),
        encoding="utf-8",
    )

    connection = sqlite3.connect(timeline_path)
    try:
        _create_self_audit_tables(connection)
        connection.execute(
            "INSERT INTO monitor_runs VALUES (1, ?, 'stale', 0, 0)",
            ("2026-06-13T12:00:00+08:00",),
        )
        packet = {
            "evidence_chain_status": {
                "can_show_current_conclusion": False,
                "missing_required": ["live_xauusd_spot", "xauusd_recent_history"],
            },
            "provider_health": {
                "xauusd": {
                    "is_available": True,
                    "is_stale": True,
                    "stale_reason": "XAUUSD is inside the weekend closed window; last cTrader quote is context only until the market reopens.",
                    "metadata": {"market_closed": True, "stale_classification": "market_closed"},
                },
                "calendar": {"metadata": {"calendar_dir": str(calendar_dir)}},
            },
            "calendar_events": [],
            "news": [{"title": "Oil headline"}],
        }
        connection.execute("INSERT INTO evidence_packets VALUES (1, 1, ?)", (json.dumps(packet),))
        connection.execute(
            "INSERT INTO analysis_results VALUES (1, 1, ?)",
            (json.dumps({"analysis_engine": "llm_validated", "llm_status": "validated"}),),
        )
        _insert_required_run_artifacts(connection)
        connection.commit()
    finally:
        connection.close()

    cfg = MarketAgentConfig(
        calendar_dir=calendar_dir,
        timeline_store_path=timeline_path,
        state_store_path=tmp_path / "state.json",
        alerts_output_path=tmp_path / "alerts.ndjson",
        monitor_lock_path=tmp_path / "monitor.lock",
        monitor_status_path=monitor_status_path,
    )

    audit = audit_market_agent(cfg, now=datetime.fromisoformat("2026-06-13T12:02:00+08:00"))
    checks = {check["name"]: check for check in audit["checks"]}

    assert audit["status"] == "degraded"
    assert "monitor loop is stopped" in audit["summary"]
    assert checks["monitor_loop"]["status"] == "warn"
    assert "stopped" in checks["monitor_loop"]["detail"]


def test_self_audit_warns_when_running_monitor_status_is_overdue(tmp_path):
    timeline_path = tmp_path / "timeline.sqlite"
    calendar_dir = tmp_path / "Economic_Calendar"
    year_dir = calendar_dir / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text(
        json.dumps([{"Date": "2026-06-13", "Time": "03:00", "Event": "Early Event"}]),
        encoding="utf-8",
    )
    monitor_status_path = tmp_path / "monitor_status.json"
    monitor_status_path.write_text(
        json.dumps(
            {
                "running": True,
                "phase": "idle_between_runs",
                "autoStart": True,
                "pid": os.getpid(),
                "intervalSeconds": 60,
                "nextRunAt": "2026-06-13T12:01:00+08:00",
                "lastRunAt": "2026-06-13T12:00:00+08:00",
            }
        ),
        encoding="utf-8",
    )

    connection = sqlite3.connect(timeline_path)
    try:
        _create_self_audit_tables(connection)
        connection.execute(
            "INSERT INTO monitor_runs VALUES (1, ?, 'stale', 0, 0)",
            ("2026-06-13T12:00:00+08:00",),
        )
        packet = {
            "evidence_chain_status": {
                "can_show_current_conclusion": False,
                "missing_required": ["live_xauusd_spot", "xauusd_recent_history"],
            },
            "provider_health": {
                "xauusd": {
                    "is_available": True,
                    "is_stale": True,
                    "stale_reason": "XAUUSD is inside the weekend closed window; last cTrader quote is context only until the market reopens.",
                    "metadata": {"market_closed": True, "stale_classification": "market_closed"},
                },
                "calendar": {"metadata": {"calendar_dir": str(calendar_dir)}},
            },
            "calendar_events": [],
            "news": [{"title": "Oil headline"}],
        }
        connection.execute("INSERT INTO evidence_packets VALUES (1, 1, ?)", (json.dumps(packet),))
        connection.execute(
            "INSERT INTO analysis_results VALUES (1, 1, ?)",
            (json.dumps({"analysis_engine": "llm_validated", "llm_status": "validated"}),),
        )
        _insert_required_run_artifacts(connection)
        connection.commit()
    finally:
        connection.close()

    cfg = MarketAgentConfig(
        calendar_dir=calendar_dir,
        timeline_store_path=timeline_path,
        state_store_path=tmp_path / "state.json",
        alerts_output_path=tmp_path / "alerts.ndjson",
        monitor_lock_path=tmp_path / "monitor.lock",
        monitor_status_path=monitor_status_path,
    )

    audit = audit_market_agent(cfg, now=datetime.fromisoformat("2026-06-13T12:05:00+08:00"))
    checks = {check["name"]: check for check in audit["checks"]}

    assert audit["status"] == "degraded"
    assert checks["monitor_loop"]["status"] == "warn"
    assert "overdue" in checks["monitor_loop"]["detail"]


def test_self_audit_active_monitor_does_not_report_stale_next_run(tmp_path):
    timeline_path = tmp_path / "timeline.sqlite"
    calendar_dir = tmp_path / "Economic_Calendar"
    year_dir = calendar_dir / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text(
        json.dumps([{"Date": "2026-06-13", "Time": "03:00", "Event": "Early Event"}]),
        encoding="utf-8",
    )
    monitor_status_path = tmp_path / "monitor_status.json"
    monitor_status_path.write_text(
        json.dumps(
            {
                "running": True,
                "phase": "collecting_inputs",
                "autoStart": True,
                "pid": os.getpid(),
                "intervalSeconds": 60,
                "nextRunAt": "2026-06-13T12:01:00+08:00",
                "lastRunAt": "2026-06-13T12:00:00+08:00",
            }
        ),
        encoding="utf-8",
    )

    connection = sqlite3.connect(timeline_path)
    try:
        _create_self_audit_tables(connection)
        connection.execute(
            "INSERT INTO monitor_runs VALUES (1, ?, 'stale', 0, 0)",
            ("2026-06-13T12:00:00+08:00",),
        )
        packet = {
            "evidence_chain_status": {
                "can_show_current_conclusion": False,
                "missing_required": ["live_xauusd_spot", "xauusd_recent_history"],
            },
            "provider_health": {
                "xauusd": {
                    "is_available": True,
                    "is_stale": True,
                    "stale_reason": "XAUUSD is inside the weekend closed window; last cTrader quote is context only until the market reopens.",
                    "metadata": {"market_closed": True, "stale_classification": "market_closed"},
                },
                "calendar": {"metadata": {"calendar_dir": str(calendar_dir)}},
            },
            "calendar_events": [],
            "news": [{"title": "Oil headline"}],
        }
        connection.execute("INSERT INTO evidence_packets VALUES (1, 1, ?)", (json.dumps(packet),))
        connection.execute(
            "INSERT INTO analysis_results VALUES (1, 1, ?)",
            (json.dumps({"analysis_engine": "llm_validated", "llm_status": "validated"}),),
        )
        _insert_required_run_artifacts(connection)
        connection.commit()
    finally:
        connection.close()

    cfg = MarketAgentConfig(
        calendar_dir=calendar_dir,
        timeline_store_path=timeline_path,
        state_store_path=tmp_path / "state.json",
        alerts_output_path=tmp_path / "alerts.ndjson",
        monitor_lock_path=tmp_path / "monitor.lock",
        monitor_status_path=monitor_status_path,
    )

    audit = audit_market_agent(cfg, now=datetime.fromisoformat("2026-06-13T12:04:00+08:00"))
    checks = {check["name"]: check for check in audit["checks"]}

    assert checks["monitor_loop"]["status"] == "pass"
    assert "current pass is active" in checks["monitor_loop"]["detail"]
    assert "next_run" not in checks["monitor_loop"]["detail"]


def test_self_audit_warns_when_running_monitor_pid_is_dead(tmp_path):
    timeline_path = tmp_path / "timeline.sqlite"
    calendar_dir = tmp_path / "Economic_Calendar"
    year_dir = calendar_dir / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text(
        json.dumps([{"Date": "2026-06-13", "Time": "03:00", "Event": "Early Event"}]),
        encoding="utf-8",
    )
    monitor_status_path = tmp_path / "monitor_status.json"
    monitor_status_path.write_text(
        json.dumps(
            {
                "running": True,
                "phase": "idle_between_runs",
                "autoStart": True,
                "pid": 999999999,
                "intervalSeconds": 60,
                "nextRunAt": "2026-06-13T12:02:00+08:00",
                "lastRunAt": "2026-06-13T12:00:00+08:00",
            }
        ),
        encoding="utf-8",
    )

    connection = sqlite3.connect(timeline_path)
    try:
        _create_self_audit_tables(connection)
        connection.execute(
            "INSERT INTO monitor_runs VALUES (1, ?, 'stale', 0, 0)",
            ("2026-06-13T12:00:00+08:00",),
        )
        packet = {
            "evidence_chain_status": {
                "can_show_current_conclusion": False,
                "missing_required": ["live_xauusd_spot", "xauusd_recent_history"],
            },
            "provider_health": {
                "xauusd": {
                    "is_available": True,
                    "is_stale": True,
                    "stale_reason": "XAUUSD is inside the weekend closed window; last cTrader quote is context only until the market reopens.",
                    "metadata": {"market_closed": True, "stale_classification": "market_closed"},
                },
                "calendar": {"metadata": {"calendar_dir": str(calendar_dir)}},
            },
            "calendar_events": [],
            "news": [{"title": "Oil headline"}],
        }
        connection.execute("INSERT INTO evidence_packets VALUES (1, 1, ?)", (json.dumps(packet),))
        connection.execute(
            "INSERT INTO analysis_results VALUES (1, 1, ?)",
            (json.dumps({"analysis_engine": "llm_validated", "llm_status": "validated"}),),
        )
        _insert_required_run_artifacts(connection)
        connection.commit()
    finally:
        connection.close()

    cfg = MarketAgentConfig(
        calendar_dir=calendar_dir,
        timeline_store_path=timeline_path,
        state_store_path=tmp_path / "state.json",
        alerts_output_path=tmp_path / "alerts.ndjson",
        monitor_lock_path=tmp_path / "monitor.lock",
        monitor_status_path=monitor_status_path,
    )

    audit = audit_market_agent(cfg, now=datetime.fromisoformat("2026-06-13T12:02:30+08:00"))
    checks = {check["name"]: check for check in audit["checks"]}

    assert audit["status"] == "degraded"
    assert checks["monitor_loop"]["status"] == "warn"
    assert "not alive" in checks["monitor_loop"]["detail"]


def test_self_audit_warns_when_enabled_local_ai_falls_back_to_rules(tmp_path, monkeypatch):
    llm_config_path = tmp_path / "market-agent-llm.json"
    llm_config_path.write_text(json.dumps({"enabled": True, "model": "qwen3.5:4b"}), encoding="utf-8")
    monkeypatch.setenv("MARKET_AGENT_LLM_CONFIG_PATH", str(llm_config_path))
    timeline_path = tmp_path / "timeline.sqlite"
    calendar_dir = tmp_path / "Economic_Calendar"
    year_dir = calendar_dir / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text(
        json.dumps([{"Date": "2026-06-13", "Time": "03:00", "Event": "Early Event"}]),
        encoding="utf-8",
    )

    connection = sqlite3.connect(timeline_path)
    try:
        _create_self_audit_tables(connection)
        connection.execute(
            "INSERT INTO monitor_runs VALUES (1, ?, 'live_seen', 0, 0)",
            ("2026-06-13T12:00:00+08:00",),
        )
        packet = {
            "evidence_chain_status": {
                "can_show_current_conclusion": True,
                "missing_required": [],
            },
            "provider_health": {"calendar": {"metadata": {"calendar_dir": str(calendar_dir)}}},
            "calendar_events": [],
            "news": [{"title": "Oil headline"}],
        }
        connection.execute("INSERT INTO evidence_packets VALUES (1, 1, ?)", (json.dumps(packet),))
        connection.execute(
            "INSERT INTO analysis_results VALUES (1, 1, ?)",
            (json.dumps({"analysis_engine": "rule_based", "llm_status": "invalid_or_unavailable"}),),
        )
        _insert_required_run_artifacts(connection)
        connection.commit()
    finally:
        connection.close()

    cfg = MarketAgentConfig(
        calendar_dir=calendar_dir,
        timeline_store_path=timeline_path,
        state_store_path=tmp_path / "state.json",
        alerts_output_path=tmp_path / "alerts.ndjson",
        monitor_lock_path=tmp_path / "monitor.lock",
        monitor_status_path=tmp_path / "monitor_status.json",
    )

    audit = audit_market_agent(cfg, now=datetime.fromisoformat("2026-06-13T12:02:00+08:00"))
    checks = {check["name"]: check for check in audit["checks"]}

    assert checks["ai_or_rule_analysis"]["status"] == "warn"


def test_self_audit_warns_when_visible_news_lacks_local_ai_summary(tmp_path, monkeypatch):
    timeline_path = tmp_path / "timeline.sqlite"
    calendar_dir = tmp_path / "Economic_Calendar"
    year_dir = calendar_dir / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text(
        json.dumps([{"Date": "2026-06-13", "Time": "03:00", "Event": "Early Event"}]),
        encoding="utf-8",
    )
    config_path = tmp_path / "market-agent-llm.json"
    config_path.write_text(
        json.dumps({"enabled": True, "model": "qwen3.5:4b", "displaySummaryEnabled": True}),
        encoding="utf-8",
    )
    monkeypatch.setenv("MARKET_AGENT_LLM_CONFIG_PATH", str(config_path))

    connection = sqlite3.connect(timeline_path)
    try:
        _create_self_audit_tables(connection)
        connection.execute("DROP TABLE news_items")
        connection.execute(
            """
            CREATE TABLE news_items (
                id INTEGER PRIMARY KEY,
                monitor_run_id INTEGER,
                payload_json TEXT
            )
            """
        )
        connection.execute(
            "INSERT INTO monitor_runs VALUES (1, ?, 'live_seen', 0, 0)",
            ("2026-06-13T12:00:00+08:00",),
        )
        packet = {
            "evidence_chain_status": {"can_show_current_conclusion": True, "missing_required": []},
            "provider_health": {"calendar": {"metadata": {"calendar_dir": str(calendar_dir)}}},
            "calendar_events": [],
            "news": [{"title": "Long raw headline", "included": True}],
        }
        connection.execute("INSERT INTO evidence_packets VALUES (1, 1, ?)", (json.dumps(packet),))
        connection.execute(
            "INSERT INTO analysis_results VALUES (1, 1, ?)",
            (json.dumps({"analysis_engine": "llm_validated", "llm_status": "validated"}),),
        )
        _insert_required_run_artifacts(connection, news_rows=0)
        connection.execute(
            "INSERT INTO news_items (monitor_run_id, payload_json) VALUES (1, ?)",
            (json.dumps({"title": "Long raw headline", "included": True}),),
        )
        connection.commit()
    finally:
        connection.close()

    cfg = MarketAgentConfig(
        calendar_dir=calendar_dir,
        timeline_store_path=timeline_path,
        state_store_path=tmp_path / "state.json",
        alerts_output_path=tmp_path / "alerts.ndjson",
        monitor_lock_path=tmp_path / "monitor.lock",
        monitor_status_path=tmp_path / "monitor_status.json",
    )

    audit = audit_market_agent(cfg, now=datetime.fromisoformat("2026-06-13T12:02:00+08:00"))
    checks = {check["name"]: check for check in audit["checks"]}

    assert checks["display_summaries"]["status"] == "warn"
    assert "0/1" in checks["display_summaries"]["detail"]


def test_self_audit_passes_when_visible_news_has_local_ai_summary(tmp_path, monkeypatch):
    timeline_path = tmp_path / "timeline.sqlite"
    calendar_dir = tmp_path / "Economic_Calendar"
    year_dir = calendar_dir / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text(
        json.dumps([{"Date": "2026-06-13", "Time": "03:00", "Event": "Early Event"}]),
        encoding="utf-8",
    )
    config_path = tmp_path / "market-agent-llm.json"
    config_path.write_text(
        json.dumps({"enabled": True, "model": "qwen3.5:4b", "displaySummaryEnabled": True}),
        encoding="utf-8",
    )
    monkeypatch.setenv("MARKET_AGENT_LLM_CONFIG_PATH", str(config_path))

    connection = sqlite3.connect(timeline_path)
    try:
        _create_self_audit_tables(connection)
        connection.execute("DROP TABLE news_items")
        connection.execute(
            """
            CREATE TABLE news_items (
                id INTEGER PRIMARY KEY,
                monitor_run_id INTEGER,
                payload_json TEXT
            )
            """
        )
        connection.execute(
            "INSERT INTO monitor_runs VALUES (1, ?, 'live_seen', 0, 0)",
            ("2026-06-13T12:00:00+08:00",),
        )
        packet = {
            "evidence_chain_status": {"can_show_current_conclusion": True, "missing_required": []},
            "provider_health": {"calendar": {"metadata": {"calendar_dir": str(calendar_dir)}}},
            "calendar_events": [],
            "news": [{"title": "Long raw headline", "included": True}],
        }
        connection.execute("INSERT INTO evidence_packets VALUES (1, 1, ?)", (json.dumps(packet),))
        connection.execute(
            "INSERT INTO analysis_results VALUES (1, 1, ?)",
            (json.dumps({"analysis_engine": "llm_validated", "llm_status": "validated"}),),
        )
        _insert_required_run_artifacts(connection, news_rows=0)
        connection.execute(
            "INSERT INTO news_items (monitor_run_id, payload_json) VALUES (1, ?)",
            (
                json.dumps(
                    {
                        "title": "Long raw headline",
                        "included": True,
                        "summary_title": "Rates pressure gold",
                        "summary_source": "local_ai",
                    }
                ),
            ),
        )
        connection.commit()
    finally:
        connection.close()

    cfg = MarketAgentConfig(
        calendar_dir=calendar_dir,
        timeline_store_path=timeline_path,
        state_store_path=tmp_path / "state.json",
        alerts_output_path=tmp_path / "alerts.ndjson",
        monitor_lock_path=tmp_path / "monitor.lock",
        monitor_status_path=tmp_path / "monitor_status.json",
    )

    audit = audit_market_agent(cfg, now=datetime.fromisoformat("2026-06-13T12:02:00+08:00"))
    checks = {check["name"]: check for check in audit["checks"]}

    assert checks["display_summaries"]["status"] == "pass"
    assert "1/1" in checks["display_summaries"]["detail"]


def test_self_audit_passes_when_latest_run_has_no_alert_reason(tmp_path):
    timeline_path = tmp_path / "timeline.sqlite"
    calendar_dir = tmp_path / "Economic_Calendar"
    year_dir = calendar_dir / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text(
        json.dumps([{"Date": "2026-06-13", "Time": "03:00", "Event": "Early Event"}]),
        encoding="utf-8",
    )

    connection = sqlite3.connect(timeline_path)
    try:
        _create_self_audit_tables(connection)
        connection.execute("DROP TABLE monitor_runs")
        connection.execute(
            """
            CREATE TABLE monitor_runs (
                id INTEGER PRIMARY KEY,
                run_started_at TEXT,
                data_mode TEXT,
                backfill_required INTEGER,
                no_news_found INTEGER,
                alert_suppressed_reason TEXT
            )
            """
        )
        connection.execute(
            "INSERT INTO monitor_runs VALUES (1, ?, 'live_seen', 0, 0, ?)",
            ("2026-06-13T12:00:00+08:00", "Analysis result does not require notification."),
        )
        packet = {
            "evidence_chain_status": {"can_show_current_conclusion": True, "missing_required": []},
            "provider_health": {"calendar": {"metadata": {"calendar_dir": str(calendar_dir)}}},
            "calendar_events": [],
            "news": [{"title": "Oil headline"}],
        }
        connection.execute("INSERT INTO evidence_packets VALUES (1, 1, ?)", (json.dumps(packet),))
        connection.execute(
            "INSERT INTO analysis_results VALUES (1, 1, ?)",
            (json.dumps({"analysis_engine": "llm_validated", "llm_status": "validated"}),),
        )
        _insert_required_run_artifacts(connection)
        connection.commit()
    finally:
        connection.close()

    cfg = MarketAgentConfig(
        calendar_dir=calendar_dir,
        timeline_store_path=timeline_path,
        state_store_path=tmp_path / "state.json",
        alerts_output_path=tmp_path / "alerts.ndjson",
        monitor_lock_path=tmp_path / "monitor.lock",
        monitor_status_path=tmp_path / "monitor_status.json",
    )

    audit = audit_market_agent(cfg, now=datetime.fromisoformat("2026-06-13T12:02:00+08:00"))
    checks = {check["name"]: check for check in audit["checks"]}

    assert checks["notification_decision"]["status"] == "pass"
    assert "No alert sent" in checks["notification_decision"]["detail"]
    assert "alert_decision=suppressed_reason" in checks["current_run_storage"]["detail"]


def test_self_audit_warns_when_latest_run_lacks_notification_trace(tmp_path):
    timeline_path = tmp_path / "timeline.sqlite"
    calendar_dir = tmp_path / "Economic_Calendar"
    year_dir = calendar_dir / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text(
        json.dumps([{"Date": "2026-06-13", "Time": "03:00", "Event": "Early Event"}]),
        encoding="utf-8",
    )

    connection = sqlite3.connect(timeline_path)
    try:
        _create_self_audit_tables(connection)
        connection.execute("DROP TABLE monitor_runs")
        connection.execute(
            """
            CREATE TABLE monitor_runs (
                id INTEGER PRIMARY KEY,
                run_started_at TEXT,
                data_mode TEXT,
                backfill_required INTEGER,
                no_news_found INTEGER,
                alert_suppressed_reason TEXT
            )
            """
        )
        connection.execute(
            "INSERT INTO monitor_runs VALUES (1, ?, 'live_seen', 0, 0, '')",
            ("2026-06-13T12:00:00+08:00",),
        )
        packet = {
            "evidence_chain_status": {"can_show_current_conclusion": True, "missing_required": []},
            "provider_health": {"calendar": {"metadata": {"calendar_dir": str(calendar_dir)}}},
            "calendar_events": [],
            "news": [{"title": "Oil headline"}],
        }
        connection.execute("INSERT INTO evidence_packets VALUES (1, 1, ?)", (json.dumps(packet),))
        connection.execute(
            "INSERT INTO analysis_results VALUES (1, 1, ?)",
            (json.dumps({"analysis_engine": "llm_validated", "llm_status": "validated"}),),
        )
        _insert_required_run_artifacts(connection)
        connection.commit()
    finally:
        connection.close()

    cfg = MarketAgentConfig(
        calendar_dir=calendar_dir,
        timeline_store_path=timeline_path,
        state_store_path=tmp_path / "state.json",
        alerts_output_path=tmp_path / "alerts.ndjson",
        monitor_lock_path=tmp_path / "monitor.lock",
        monitor_status_path=tmp_path / "monitor_status.json",
    )

    audit = audit_market_agent(cfg, now=datetime.fromisoformat("2026-06-13T12:02:00+08:00"))
    checks = {check["name"]: check for check in audit["checks"]}

    assert checks["notification_decision"]["status"] == "warn"
    assert "no alert audit" in checks["notification_decision"]["detail"]


def test_self_audit_uses_latest_complete_run_when_newer_run_is_incomplete(tmp_path):
    timeline_path = tmp_path / "timeline.sqlite"
    calendar_dir = tmp_path / "Economic_Calendar"
    year_dir = calendar_dir / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text(
        json.dumps([{"Date": "2026-06-13", "Time": "03:00", "Event": "Early Event"}]),
        encoding="utf-8",
    )

    connection = sqlite3.connect(timeline_path)
    try:
        _create_self_audit_tables(connection)
        connection.execute(
            "INSERT INTO monitor_runs VALUES (1, ?, 'live_seen', 0, 0)",
            ("2026-06-13T12:00:00+08:00",),
        )
        connection.execute(
            "INSERT INTO monitor_runs VALUES (2, ?, 'unavailable', 0, 0)",
            ("2026-06-13T12:01:00+08:00",),
        )
        complete_packet = {
            "evidence_chain_status": {
                "can_show_current_conclusion": True,
                "missing_required": [],
            },
            "provider_health": {"calendar": {"metadata": {"calendar_dir": str(calendar_dir)}}},
            "calendar_events": [],
            "news": [{"title": "Fed pressure keeps gold in focus"}],
        }
        incomplete_packet = {
            "evidence_chain_status": {
                "can_show_current_conclusion": False,
                "missing_required": ["live_xauusd_spot"],
            },
            "provider_health": {"calendar": {"metadata": {"calendar_dir": str(calendar_dir)}}},
            "calendar_events": [],
            "news": [{"title": "Incomplete run should not drive audit"}],
        }
        connection.execute("INSERT INTO evidence_packets VALUES (1, 1, ?)", (json.dumps(complete_packet),))
        connection.execute("INSERT INTO evidence_packets VALUES (2, 2, ?)", (json.dumps(incomplete_packet),))
        connection.execute(
            "INSERT INTO analysis_results VALUES (1, 1, ?)",
            (json.dumps({"analysis_engine": "llm_validated", "llm_status": "validated", "summary": "Complete run"}),),
        )
        connection.execute(
            "INSERT INTO analysis_results VALUES (2, 2, ?)",
            (json.dumps({"analysis_engine": "llm_validated", "llm_status": "validated", "summary": "Incomplete run"}),),
        )
        _insert_required_run_artifacts(connection, monitor_run_id=1, news_rows=1)
        connection.execute(
            "INSERT INTO provider_health (monitor_run_id, provider_key, payload_json) VALUES (2, 'xauusd', ?)",
            (json.dumps({"source": "cTrader", "is_available": False}),),
        )
        connection.execute("INSERT INTO news_items (monitor_run_id) VALUES (2)")
        connection.execute(
            "INSERT INTO state_transitions (monitor_run_id, payload_json) VALUES (2, ?)",
            (json.dumps({"stored": True}),),
        )
        connection.execute(
            "INSERT INTO timeline_events (monitor_run_id, event_time) VALUES (2, ?)",
            ("2026-06-13T12:01:00+08:00",),
        )
        connection.commit()
    finally:
        connection.close()

    cfg = MarketAgentConfig(
        calendar_dir=calendar_dir,
        timeline_store_path=timeline_path,
        state_store_path=tmp_path / "state.json",
        alerts_output_path=tmp_path / "alerts.ndjson",
        monitor_lock_path=tmp_path / "monitor.lock",
        monitor_status_path=tmp_path / "monitor_status.json",
    )

    audit = audit_market_agent(cfg, now=datetime.fromisoformat("2026-06-13T12:02:00+08:00"))
    checks = {check["name"]: check for check in audit["checks"]}

    assert audit["status"] == "healthy"
    assert audit["latest_evidence_run_id"] == 1
    assert "Run 1" in checks["latest_run"]["detail"]
    assert "skipped newer incomplete run 2" in checks["latest_run"]["detail"]
    assert "Complete run" in checks["ai_or_rule_analysis"]["detail"] or checks["ai_or_rule_analysis"]["status"] == "pass"
    assert "Run 1 stored" in checks["current_run_storage"]["detail"]


def test_self_audit_fails_when_latest_run_is_missing_required_artifacts(tmp_path):
    timeline_path = tmp_path / "timeline.sqlite"
    calendar_dir = tmp_path / "Economic_Calendar"
    year_dir = calendar_dir / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text(
        json.dumps([{"Date": "2026-06-13", "Time": "03:00", "Event": "Early Event"}]),
        encoding="utf-8",
    )

    connection = sqlite3.connect(timeline_path)
    try:
        _create_self_audit_tables(connection)
        connection.execute(
            "INSERT INTO monitor_runs VALUES (1, ?, 'live_seen', 0, 0)",
            ("2026-06-13T12:00:00+08:00",),
        )
        packet = {
            "evidence_chain_status": {
                "can_show_current_conclusion": True,
                "missing_required": [],
            },
            "provider_health": {"calendar": {"metadata": {"calendar_dir": str(calendar_dir)}}},
            "calendar_events": [],
            "news": [],
        }
        connection.execute("INSERT INTO evidence_packets VALUES (1, 1, ?)", (json.dumps(packet),))
        connection.execute("INSERT INTO market_price_bars (monitor_run_id) VALUES (1)")
        connection.commit()
    finally:
        connection.close()

    cfg = MarketAgentConfig(
        calendar_dir=calendar_dir,
        timeline_store_path=timeline_path,
        state_store_path=tmp_path / "state.json",
        alerts_output_path=tmp_path / "alerts.ndjson",
        monitor_lock_path=tmp_path / "monitor.lock",
        monitor_status_path=tmp_path / "monitor_status.json",
    )

    audit = audit_market_agent(cfg, now=datetime.fromisoformat("2026-06-13T12:02:00+08:00"))
    checks = {check["name"]: check for check in audit["checks"]}

    assert checks["current_run_storage"]["status"] == "fail"
    assert "analysis_results" in checks["current_run_storage"]["detail"]
    assert audit["status"] == "action_required"
