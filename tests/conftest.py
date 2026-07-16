import os

import pytest


@pytest.fixture(autouse=True)
def isolate_local_llm_config(monkeypatch, tmp_path):
    if "MARKET_AGENT_LLM_CONFIG_PATH" not in os.environ:
        monkeypatch.setenv("MARKET_AGENT_LLM_CONFIG_PATH", str(tmp_path / "missing-llm-config.json"))
    if "MARKET_AGENT_STATE_STORE_PATH" not in os.environ:
        monkeypatch.setenv("MARKET_AGENT_STATE_STORE_PATH", str(tmp_path / "market_agent_state.json"))
    if "MARKET_AGENT_TIMELINE_STORE_PATH" not in os.environ:
        monkeypatch.setenv("MARKET_AGENT_TIMELINE_STORE_PATH", str(tmp_path / "market_agent_timeline.sqlite"))
    if "MARKET_AGENT_ALERTS_OUTPUT_PATH" not in os.environ:
        monkeypatch.setenv("MARKET_AGENT_ALERTS_OUTPUT_PATH", str(tmp_path / "market_agent_alerts.ndjson"))
    if "MARKET_AGENT_MONITOR_LOCK_PATH" not in os.environ:
        monkeypatch.setenv("MARKET_AGENT_MONITOR_LOCK_PATH", str(tmp_path / "market_agent_monitor.lock"))
    if "MARKET_AGENT_MONITOR_STATUS_PATH" not in os.environ:
        monkeypatch.setenv("MARKET_AGENT_MONITOR_STATUS_PATH", str(tmp_path / "market_agent_monitor_status.json"))
