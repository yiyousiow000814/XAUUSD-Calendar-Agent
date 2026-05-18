from __future__ import annotations

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

    def analyze(self, evidence_packet: dict[str, Any]) -> dict[str, Any] | None:
        if not self.config.enabled:
            return None
        try:
            import requests

            response = requests.post(
                f"{self.config.endpoint.rstrip('/')}/api/generate",
                json={
                    "model": self.config.model,
                    "prompt": evidence_packet["prompt"],
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
                import json

                return json.loads(payload["response"])
            return None
        except Exception:
            return None
