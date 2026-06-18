from __future__ import annotations

import json

from src.xauusd_market_agent import llm_bridge


class FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self):
        return self._payload


def test_llm_bridge_connection_reports_model_missing(monkeypatch) -> None:
    class FakeRequests:
        @staticmethod
        def get(url, timeout):
            assert url == "http://127.0.0.1:21434/api/tags"
            assert timeout == 60
            return FakeResponse({"models": [{"name": "other:latest"}]})

    monkeypatch.setitem(__import__("sys").modules, "requests", FakeRequests)

    config = llm_bridge._config_from_payload({"model": "qwen3.5:4b"})
    result = llm_bridge.test_connection(config)

    assert result["ok"] is False
    assert result["status"] == "model_missing"


def test_llm_bridge_empty_model_list_reports_model_missing(monkeypatch) -> None:
    class FakeRequests:
        @staticmethod
        def get(url, timeout):
            assert url == "http://127.0.0.1:21434/api/tags"
            assert timeout == 60
            return FakeResponse({"models": []})

    monkeypatch.setitem(__import__("sys").modules, "requests", FakeRequests)

    config = llm_bridge._config_from_payload({})
    result = llm_bridge.test_connection(config)

    assert config.endpoint == "http://127.0.0.1:21434"
    assert result["ok"] is False
    assert result["status"] == "model_missing"
    assert "qwen3.5:4b" in result["error"]


def test_llm_bridge_json_response_reports_invalid_json(monkeypatch) -> None:
    class FakeClient:
        def __init__(self, config):
            self.config = config

        def analyze(self, packet):
            assert "provider_health" in packet
            assert "allowed_candidate_drivers" in packet
            return None

    monkeypatch.setattr(llm_bridge, "LocalLLMClient", FakeClient)

    config = llm_bridge._config_from_payload({"model": "qwen3.5:4b"})
    result = llm_bridge.test_json_response(config)

    assert result["ok"] is False
    assert result["status"] == "invalid_json"


def test_llm_bridge_reads_utf8_bom_json_payload(monkeypatch) -> None:
    monkeypatch.setattr(
        llm_bridge.sys,
        "stdin",
        type("FakeStdin", (), {"read": lambda self: '\ufeff{"model":"qwen3.6:latest","timeoutSeconds":10}'})(),
    )

    payload = llm_bridge._read_payload()
    config = llm_bridge._config_from_payload(payload)

    assert config.model == "qwen3.6:latest"
    assert config.timeout_seconds == 10


def test_llm_bridge_reads_mojibake_bom_json_payload(monkeypatch) -> None:
    monkeypatch.setattr(
        llm_bridge.sys,
        "stdin",
        type("FakeStdin", (), {"read": lambda self: 'ï»¿{"model":"qwen3.6:latest","timeoutSeconds":10}'})(),
    )

    payload = llm_bridge._read_payload()
    config = llm_bridge._config_from_payload(payload)

    assert config.model == "qwen3.6:latest"
    assert config.timeout_seconds == 10


def test_llm_bridge_main_prints_safe_json(monkeypatch, capsys) -> None:
    monkeypatch.setattr(llm_bridge.sys, "argv", ["llm_bridge.py", "connection"])
    monkeypatch.setattr(llm_bridge.sys, "stdin", type("FakeStdin", (), {"read": lambda self: "{}"})())
    monkeypatch.setattr(
        llm_bridge,
        "test_connection",
        lambda config: {"ok": True, "status": "available", "message": "ok"},
    )

    llm_bridge.main()

    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert payload["status"] == "available"
