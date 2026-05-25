from __future__ import annotations

import json
import os
from dataclasses import dataclass
from time import perf_counter
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
        self.telemetry: list[dict[str, Any]] = []

    def _record_telemetry(
        self,
        *,
        task: str,
        started_at: float,
        payload: dict[str, Any] | None = None,
        status: str = "ok",
        error: str = "",
    ) -> None:
        payload = payload or {}
        elapsed_ms = round((perf_counter() - started_at) * 1000, 2)
        total_duration = payload.get("total_duration")
        eval_duration = payload.get("eval_duration")
        prompt_eval_count = payload.get("prompt_eval_count")
        eval_count = payload.get("eval_count")
        output_tokens = int(eval_count) if isinstance(eval_count, int) else None
        input_tokens = int(prompt_eval_count) if isinstance(prompt_eval_count, int) else None
        eval_seconds = float(eval_duration) / 1_000_000_000 if isinstance(eval_duration, int) and eval_duration > 0 else None
        tokens_per_second = round(output_tokens / eval_seconds, 2) if output_tokens and eval_seconds else None
        self.telemetry.append(
            {
                "task": task,
                "status": status,
                "model": self.config.model,
                "elapsed_ms": elapsed_ms,
                "total_duration_ms": round(float(total_duration) / 1_000_000, 2) if isinstance(total_duration, int) else elapsed_ms,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "tokens_per_second": tokens_per_second,
                "error": error,
            }
        )

    def get_telemetry(self) -> list[dict[str, Any]]:
        return list(self.telemetry)

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
        started_at = perf_counter()
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
                result = json.loads(payload["response"])
                self._record_telemetry(task="cause_review", started_at=started_at, payload=payload)
                return result
            self._record_telemetry(task="cause_review", started_at=started_at, payload=payload, status="invalid")
            return None
        except Exception as exc:
            self._record_telemetry(task="cause_review", started_at=started_at, status="error", error=str(exc))
            return None

    def summarize_display(self, display_packet: dict[str, Any]) -> dict[str, Any] | None:
        if not self.config.enabled:
            return None
        started_at = perf_counter()
        compact_packet = {
            "evidence_packet": display_packet.get("evidence_packet"),
            "analysis": display_packet.get("analysis"),
            "news": display_packet.get("news", [])[:5],
            "calendar": display_packet.get("calendar", [])[:5],
            "related_assets": display_packet.get("related_assets", [])[:16],
        }
        prompt = (
            "Create short UI summaries for the XAUUSD Market Agent dashboard. "
            "Use only supplied facts. Do not invent drivers, prices, headlines, or causes. "
            "Return strict JSON only. The JSON may contain news, calendar, and related_assets. "
            "news and calendar must be arrays of objects with source_index, summary_title, and summary. "
            "related_assets must be an object keyed by lower-case symbol; each value is an array of "
            "objects with source_index and summary. Keep summary_title under 6 words and summary under 90 characters. "
            "source_index must point to the supplied input row index.\n\n"
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
                result = json.loads(payload["response"])
                if isinstance(result, dict):
                    self._record_telemetry(task="display_summary", started_at=started_at, payload=payload)
                    return result
            self._record_telemetry(task="display_summary", started_at=started_at, payload=payload, status="invalid")
            return None
        except Exception as exc:
            self._record_telemetry(task="display_summary", started_at=started_at, status="error", error=str(exc))
            return None

    def review_alert(self, alert_packet: dict[str, Any]) -> dict[str, Any] | None:
        if not self.config.enabled:
            return None
        started_at = perf_counter()
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
                    self._record_telemetry(task="alert_review", started_at=started_at, payload=payload)
                    return review
            self._record_telemetry(task="alert_review", started_at=started_at, payload=payload, status="invalid")
            return None
        except Exception as exc:
            self._record_telemetry(task="alert_review", started_at=started_at, status="error", error=str(exc))
            return None
