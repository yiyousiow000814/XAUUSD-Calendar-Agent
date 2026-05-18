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
    model: str = os.getenv("LOCAL_LLM_MODEL", "qwen3:4b")
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
            "market_move": evidence_packet.get("market_move"),
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
            "If evidence is insufficient, return unknown. Output strict JSON only.",
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
