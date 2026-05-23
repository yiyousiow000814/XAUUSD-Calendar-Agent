from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class LocalLLMConfig:
    enabled: bool = os.getenv("LOCAL_LLM_ENABLED", "false").lower() == "true"
    provider: str = os.getenv("LOCAL_LLM_PROVIDER", "ollama")
    endpoint: str = os.getenv("LOCAL_LLM_ENDPOINT", "http://localhost:11434")
    model: str = os.getenv("LOCAL_LLM_MODEL", "qwen3.5:4b")
    temperature: float = float(os.getenv("LOCAL_LLM_TEMPERATURE", "0.1"))
    timeout_seconds: int = int(os.getenv("LOCAL_LLM_TIMEOUT_SECONDS", "20"))
    keep_alive: str = os.getenv("LOCAL_LLM_KEEP_ALIVE", "0")
    max_context: int = int(os.getenv("LOCAL_LLM_MAX_CONTEXT", "8192"))


class LocalLLMClient:
    def __init__(self, config: LocalLLMConfig | None = None) -> None:
        self.config = config or LocalLLMConfig()

    def _build_prompt(self, evidence_packet: dict[str, Any]) -> str:
        compact_packet = {
            "as_of_myt": evidence_packet.get("as_of_myt"),
            "data_mode": evidence_packet.get("data_mode"),
            "market_move": evidence_packet.get("market_move"),
            "provider_health": evidence_packet.get("provider_health"),
            "active_driver_states": evidence_packet.get("active_driver_states"),
            "dormant_driver_states": evidence_packet.get("dormant_driver_states"),
            "driver_attention_summary": evidence_packet.get("driver_attention_summary"),
            "allowed_candidate_drivers": evidence_packet.get("allowed_candidate_drivers"),
            "blocked_drivers": evidence_packet.get("blocked_drivers"),
            "cross_asset_confirmation": evidence_packet.get("cross_asset_confirmation"),
            "evidence_status": evidence_packet.get("evidence_status"),
            "timeline": evidence_packet.get("timeline"),
            "previous_state": evidence_packet.get("previous_state"),
        }
        instructions = evidence_packet.get(
            "prompt",
            "Given this evidence packet, use only allowed_candidate_drivers. "
            "The rule-based evidence gate is the source of truth. "
            "Do not add drivers, headlines, or causes that are not already in the packet. "
            "If evidence is insufficient, return unknown / insufficient evidence. "
            "Output strict JSON only.",
        )
        return (
            f"{instructions}\n\n"
            "Evidence packet JSON:\n"
            f"{json.dumps(compact_packet, ensure_ascii=True, indent=2, sort_keys=True)}"
        )

    def analyze(self, evidence_packet: dict[str, Any]) -> dict[str, Any] | None:
        if not self.config.enabled:
            return None
        try:
            import requests

            response = requests.post(
                f"{self.config.endpoint.rstrip('/')}/api/generate",
                json={
                    "model": self.config.model,
                    "prompt": self._build_prompt(evidence_packet),
                    "stream": False,
                    "format": "json",
                    "options": {
                        "temperature": self.config.temperature,
                        "num_ctx": self.config.max_context,
                    },
                    "keep_alive": self.config.keep_alive,
                },
                timeout=self.config.timeout_seconds,
            )
            response.raise_for_status()
            payload = response.json()
            if isinstance(payload.get("response"), str):
                return json.loads(payload["response"])
            return None
        except Exception:
            return None

    def review_alert(self, alert_packet: dict[str, Any]) -> dict[str, Any] | None:
        if not self.config.enabled:
            return None
        compact_packet = {
            "message": alert_packet.get("message"),
            "analysis": alert_packet.get("analysis"),
            "evidence_packet": alert_packet.get("evidence_packet"),
            "rules": alert_packet.get("rules"),
        }
        prompt = (
            "Review this XAUUSD alert before sending. "
            "The deterministic evidence gate is the source of truth. "
            "Return strict JSON with decision approve, rewrite, or block. "
            "Rewrite only for clarity without adding facts. "
            "Block stale, market-closed, unformatted, unsupported, noisy, or trading-advice alerts.\n\n"
            f"{json.dumps(compact_packet, ensure_ascii=True, indent=2, sort_keys=True)}"
        )
        try:
            import requests

            response = requests.post(
                f"{self.config.endpoint.rstrip('/')}/api/generate",
                json={
                    "model": self.config.model,
                    "prompt": prompt,
                    "stream": False,
                    "format": "json",
                    "options": {
                        "temperature": 0,
                        "num_ctx": self.config.max_context,
                    },
                    "keep_alive": self.config.keep_alive,
                },
                timeout=self.config.timeout_seconds,
            )
            response.raise_for_status()
            payload = response.json()
            if isinstance(payload.get("response"), str):
                review = json.loads(payload["response"])
                if isinstance(review, dict):
                    return review
            return None
        except Exception:
            return None
