from __future__ import annotations

import json
import sys
from dataclasses import asdict
from typing import Any

from .llm_client import LocalLLMClient, LocalLLMConfig


def _read_payload() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}


def _config_from_payload(payload: dict[str, Any]) -> LocalLLMConfig:
    return LocalLLMConfig(
        enabled=True,
        provider=str(payload.get("provider") or "ollama"),
        endpoint=str(payload.get("endpoint") or "http://127.0.0.1:21434"),
        model=str(payload.get("model") or "qwen3.5:4b"),
        temperature=float(payload.get("temperature") if payload.get("temperature") is not None else 0),
        timeout_seconds=int(payload.get("timeoutSeconds") or payload.get("timeout_seconds") or 30),
        keep_alive=str(payload.get("keepAlive") or payload.get("keep_alive") or "0"),
        max_context=int(payload.get("maxContext") or payload.get("max_context") or 8192),
    )


def _base_response(config: LocalLLMConfig) -> dict[str, Any]:
    return {
        "provider": config.provider,
        "endpoint": config.endpoint,
        "model": config.model,
        "config": asdict(config),
    }


def test_connection(config: LocalLLMConfig) -> dict[str, Any]:
    try:
        import requests

        response = requests.get(
            f"{config.endpoint.rstrip('/')}/api/tags",
            timeout=config.timeout_seconds,
        )
        response.raise_for_status()
        payload = response.json()
        models = payload.get("models") if isinstance(payload, dict) else []
        model_names = {
            str(item.get("name") or item.get("model"))
            for item in models
            if isinstance(item, dict)
        }
        if config.model and config.model not in model_names:
            model_detail = (
                f"Ollama did not list any installed models for {config.endpoint}; model {config.model} is missing."
                if not model_names
                else f"Ollama is reachable, but model {config.model} was not listed."
            )
            return {
                **_base_response(config),
                "ok": False,
                "status": "model_missing",
                "error": model_detail,
            }
        return {
            **_base_response(config),
            "ok": True,
            "status": "available",
            "message": "Ollama is available.",
        }
    except TimeoutError as exc:
        return {**_base_response(config), "ok": False, "status": "timeout", "error": str(exc)}
    except Exception as exc:  # noqa: BLE001 - bridge must return safe errors to the UI.
        return {**_base_response(config), "ok": False, "status": "unavailable", "error": str(exc)}


def test_json_response(config: LocalLLMConfig) -> dict[str, Any]:
    packet = {
        "as_of_myt": "2026-05-19T10:00:00+08:00",
        "data_mode": "live_seen",
        "market_move": {"symbol": "XAUUSD", "change_15m": -0.2},
        "provider_health": {"xauusd": {"source_type": "spot", "data_mode": "live_seen"}},
        "active_driver_states": [],
        "dormant_driver_states": [],
        "driver_attention_summary": {"active": [], "watching": []},
        "allowed_candidate_drivers": ["unknown"],
        "blocked_drivers": {"fed_rates": "No timestamped Fed headline."},
        "cross_asset_confirmation": {},
        "evidence_status": {"overall": "unconfirmed"},
        "timeline": [],
        "previous_state": {},
        "prompt": (
            "Return strict JSON with keys main_driver, cause_status, confidence, and thesis. "
            "Use only the supplied evidence. Do not invent drivers or causes. "
            "Use unknown when evidence is insufficient. Return JSON only."
        ),
    }
    result = LocalLLMClient(config).analyze(packet)
    if not isinstance(result, dict):
        return {
            **_base_response(config),
            "ok": False,
            "status": "invalid_json",
            "error": "Model did not return a JSON object.",
        }
    return {
        **_base_response(config),
        "ok": True,
        "status": "available",
        "message": "Model returned valid JSON.",
    }


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "connection"
    config = _config_from_payload(_read_payload())
    if config.provider.lower() != "ollama":
        payload = {
            **_base_response(config),
            "ok": False,
            "status": "unavailable",
            "error": "Only Ollama is supported for local LLM setup.",
        }
    elif mode == "json":
        payload = test_json_response(config)
    else:
        payload = test_connection(config)
    print(json.dumps(payload, ensure_ascii=True))


if __name__ == "__main__":
    main()
