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
            assert url == "http://localhost:11434/api/tags"
            assert timeout == 20
            return FakeResponse({"models": [{"name": "other:latest"}]})

    monkeypatch.setitem(__import__("sys").modules, "requests", FakeRequests)

    config = llm_bridge._config_from_payload({"model": "qwen3.5:4b"})
    result = llm_bridge.test_connection(config)

    assert result["ok"] is False
    assert result["status"] == "model_missing"


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
