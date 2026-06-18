from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from time import perf_counter
from typing import Any


_REPO_ROOT = Path(__file__).resolve().parents[2]
_DEFAULT_CONFIG_PATH = _REPO_ROOT / "user-data" / "market-agent-llm.json"


def _read_llm_config_file() -> dict[str, Any]:
    raw_path = (
        os.getenv("MARKET_AGENT_LLM_CONFIG_PATH", "").strip()
        or os.getenv("LOCAL_LLM_CONFIG_PATH", "").strip()
    )
    path = Path(raw_path) if raw_path else _DEFAULT_CONFIG_PATH
    if not path.exists():
        return {}
    try:
        raw = path.read_text(encoding="utf-8").lstrip("\ufeff").lstrip("ï»¿")
        payload = json.loads(raw)
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def _env_value(name: str) -> str | None:
    value = os.getenv(name)
    if value is None or not value.strip():
        return None
    return value.strip()


def _config_value(env_name: str, file_key: str, fallback: Any) -> Any:
    env = _env_value(env_name)
    if env is not None:
        return env
    payload = _read_llm_config_file()
    value = payload.get(file_key)
    return fallback if value in (None, "") else value


def _config_bool(env_name: str, file_key: str, fallback: bool) -> bool:
    value = _config_value(env_name, file_key, fallback)
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _config_int(env_name: str, file_key: str, fallback: int) -> int:
    value = _config_value(env_name, file_key, fallback)
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _config_float(env_name: str, file_key: str, fallback: float) -> float:
    value = _config_value(env_name, file_key, fallback)
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


@dataclass(frozen=True)
class LocalLLMConfig:
    enabled: bool = field(default_factory=lambda: _config_bool("LOCAL_LLM_ENABLED", "enabled", False))
    provider: str = field(default_factory=lambda: str(_config_value("LOCAL_LLM_PROVIDER", "provider", "ollama")))
    endpoint: str = field(default_factory=lambda: str(_config_value("LOCAL_LLM_ENDPOINT", "endpoint", "http://127.0.0.1:21434")))
    model: str = field(default_factory=lambda: str(_config_value("LOCAL_LLM_MODEL", "model", "qwen3.5:4b")))
    temperature: float = field(default_factory=lambda: _config_float("LOCAL_LLM_TEMPERATURE", "temperature", 0))
    timeout_seconds: int = field(default_factory=lambda: _config_int("LOCAL_LLM_TIMEOUT_SECONDS", "timeoutSeconds", 60))
    keep_alive: str = field(default_factory=lambda: str(_config_value("LOCAL_LLM_KEEP_ALIVE", "keepAlive", "5m")))
    max_context: int = field(default_factory=lambda: _config_int("LOCAL_LLM_MAX_CONTEXT", "maxContext", 8192))
    cause_review_context: int = field(default_factory=lambda: _config_int("LOCAL_LLM_CAUSE_REVIEW_CONTEXT", "causeReviewContext", _config_int("LOCAL_LLM_MAX_CONTEXT", "maxContext", 8192)))
    display_summary_context: int = field(default_factory=lambda: _config_int("LOCAL_LLM_DISPLAY_SUMMARY_CONTEXT", "displaySummaryContext", 4096))
    alert_review_context: int = field(default_factory=lambda: _config_int("LOCAL_LLM_ALERT_REVIEW_CONTEXT", "alertReviewContext", 4096))
    cause_review_timeout_seconds: int = field(default_factory=lambda: _config_int("LOCAL_LLM_CAUSE_REVIEW_TIMEOUT_SECONDS", "causeReviewTimeoutSeconds", _config_int("LOCAL_LLM_TIMEOUT_SECONDS", "timeoutSeconds", 60)))
    display_summary_timeout_seconds: int = field(default_factory=lambda: _config_int("LOCAL_LLM_DISPLAY_SUMMARY_TIMEOUT_SECONDS", "displaySummaryTimeoutSeconds", 60))
    alert_review_timeout_seconds: int = field(default_factory=lambda: _config_int("LOCAL_LLM_ALERT_REVIEW_TIMEOUT_SECONDS", "alertReviewTimeoutSeconds", 30))
    display_summary_enabled: bool = field(default_factory=lambda: _config_bool("LOCAL_LLM_DISPLAY_SUMMARY_ENABLED", "displaySummaryEnabled", False))


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
        prompt: str = "",
        requested_context: int | None = None,
        timeout_seconds: int | None = None,
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
                "prompt_chars": len(prompt),
                "requested_context": requested_context,
                "timeout_seconds": timeout_seconds,
                "error": error,
            }
        )

    def get_telemetry(self) -> list[dict[str, Any]]:
        return list(self.telemetry)

    def _task_context(self, task: str) -> int:
        if task == "display_summary":
            return max(1024, min(self.config.max_context, self.config.display_summary_context))
        if task == "alert_review":
            return max(1024, min(self.config.max_context, self.config.alert_review_context))
        return max(2048, min(self.config.max_context, self.config.cause_review_context))

    def _task_timeout(self, task: str) -> int:
        if task == "display_summary":
            floor = min(max(45, self.config.display_summary_timeout_seconds), max(45, self.config.timeout_seconds))
            return max(5, min(self.config.timeout_seconds, floor))
        if task == "alert_review":
            return max(5, min(self.config.timeout_seconds, self.config.alert_review_timeout_seconds))
        return max(10, min(self.config.timeout_seconds, self.config.cause_review_timeout_seconds))

    def _analysis_schema_prompt(self) -> str:
        return (
            "Required JSON object keys: bias, main_driver, secondary_driver, cause_status, confidence, "
            "is_new_state, is_continuation, previous_state_invalidated, should_notify, notification_level, "
            "no_news_found, allowed_candidate_drivers_used, rejected_or_blocked_drivers_acknowledged, timeline, "
            "cross_asset_confirmation, evidence_status, causal_chain, invalidation_conditions, user_message, summary. "
            "For insufficient or context-only evidence use bias=neutral, main_driver=unknown, secondary_driver=null, "
            "cause_status=unconfirmed, confidence=low, should_notify=false, notification_level=none. "
            "cross_asset_confirmation must contain dxy, us10y, us2y, oil, vix_equities. "
            "evidence_status must contain dxy, us10y, us2y, oil, vix_equities, news."
        )

    @staticmethod
    def _trim_text(value: Any, limit: int = 180) -> str:
        text = str(value or "").strip()
        return text[:limit].rstrip()

    def _compact_provider_health(self, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        compact: dict[str, Any] = {}
        for key, item in value.items():
            if not isinstance(item, dict):
                continue
            compact[str(key)] = {
                field: item.get(field)
                for field in (
                    "source",
                    "source_type",
                    "data_mode",
                    "is_available",
                    "is_stale",
                    "stale_reason",
                    "current_value",
                    "change_value",
                    "change_unit",
                )
                if item.get(field) not in (None, "", [])
            }
        return compact

    def _compact_driver_rows(self, value: Any, *, limit: int) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            return []
        rows: list[dict[str, Any]] = []
        for item in value[:limit]:
            if not isinstance(item, dict):
                continue
            rows.append(
                {
                    field: (
                        self._trim_text(item.get(field), 160)
                        if field in {"activation_reason", "deactivation_reason", "current_evidence_summary", "note"}
                        else item.get(field)
                    )
                    for field in (
                        "driver_id",
                        "label",
                        "category",
                        "current_state",
                        "priority",
                        "relevance_score",
                        "confidence",
                        "impact_percent",
                        "activation_reason",
                        "current_evidence_summary",
                        "note",
                    )
                    if item.get(field) not in (None, "", [])
                }
            )
        return rows

    def _compact_timeline(self, value: Any, *, limit: int = 12) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            return []
        rows: list[dict[str, Any]] = []
        for item in value[-limit:]:
            if not isinstance(item, dict):
                continue
            rows.append(
                {
                    field: self._trim_text(item.get(field), 160) if field == "event" else item.get(field)
                    for field in ("time_myt", "event", "source_type", "impact_on_gold")
                    if item.get(field) not in (None, "", [])
                }
            )
        return rows

    @staticmethod
    def _is_visible_summary_row(item: dict[str, Any]) -> bool:
        if item.get("included") is False:
            return False
        filter_reason = str(item.get("filter_reason") or item.get("reason") or "").strip().lower()
        review_status = str(item.get("review_status") or item.get("evidence_status") or "").strip().lower()
        if "no_market_agent_keyword" in filter_reason:
            return False
        return review_status not in {"false", "filtered", "excluded", "rejected", "dropped", "unreviewed_context"}

    def _compact_rows_for_summary(self, value: Any, *, fields: tuple[str, ...], limit: int, visible_only: bool = False) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            return []
        rows: list[dict[str, Any]] = []
        for index, item in enumerate(value):
            if not isinstance(item, dict):
                continue
            if visible_only and not self._is_visible_summary_row(item):
                continue
            row = {
                field: self._trim_text(item.get(field), 180)
                for field in fields
                if item.get(field) not in (None, "", [])
            }
            if row:
                row["source_index"] = index
                rows.append(row)
            if len(rows) >= limit:
                break
        return rows

    def _compact_market_read_for_summary(self, value: Any) -> dict[str, Any]:
        if not isinstance(value, dict):
            return {}
        return {
            field: value.get(field)
            for field in ("status", "headline", "bias", "driver", "driver_label", "confidence", "watch_next")
            if value.get(field) not in (None, "", [])
        }

    def _compact_analysis_for_summary(self, value: Any) -> dict[str, Any]:
        if not isinstance(value, dict):
            return {}
        return {
            field: self._trim_text(value.get(field), 220)
            for field in ("bias", "main_driver", "cause_status", "confidence", "summary")
            if value.get(field) not in (None, "", [])
        }

    def _build_prompt(self, evidence_packet: dict[str, Any], *, repair: bool = False) -> str:
        compact_packet = {
            "as_of_myt": evidence_packet.get("as_of_myt"),
            "data_mode": evidence_packet.get("data_mode"),
            "market_move": evidence_packet.get("market_move"),
            "provider_health": self._compact_provider_health(evidence_packet.get("provider_health")),
            "selected_market_provider": evidence_packet.get("selected_market_provider"),
            "provider_chain_status": evidence_packet.get("provider_chain_status"),
            "fallback_reason": self._trim_text(evidence_packet.get("fallback_reason"), 220),
            "active_driver_states": self._compact_driver_rows(evidence_packet.get("active_driver_states"), limit=8),
            "dormant_driver_states": self._compact_driver_rows(evidence_packet.get("dormant_driver_states"), limit=6),
            "driver_attention_summary": evidence_packet.get("driver_attention_summary"),
            "dynamic_themes": self._compact_driver_rows(evidence_packet.get("dynamic_themes"), limit=8),
            "allowed_candidate_drivers": evidence_packet.get("allowed_candidate_drivers"),
            "blocked_drivers": evidence_packet.get("blocked_drivers"),
            "cross_asset_confirmation": evidence_packet.get("cross_asset_confirmation"),
            "evidence_status": evidence_packet.get("evidence_status"),
            "evidence_chain_status": evidence_packet.get("evidence_chain_status"),
            "market_read": evidence_packet.get("market_read"),
            "timeline": self._compact_timeline(evidence_packet.get("timeline")),
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
        repair_instruction = (
            "Your previous response was missing required keys or was not valid JSON. Return one complete JSON object only. "
            if repair
            else ""
        )
        return (
            f"{instructions} {repair_instruction}\n"
            f"{self._analysis_schema_prompt()}\n\n"
            "Evidence packet JSON:\n"
            f"{json.dumps(compact_packet, ensure_ascii=True, indent=2, sort_keys=True)}"
        )

    def _parse_model_json(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        candidates = [
            payload.get("response"),
            payload.get("thinking"),
        ]
        for candidate in candidates:
            if not isinstance(candidate, str) or not candidate.strip():
                continue
            text = candidate.strip()
            for raw in (text, text[text.find("{") : text.rfind("}") + 1] if "{" in text and "}" in text else ""):
                if not raw:
                    continue
                try:
                    result = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if isinstance(result, dict):
                    return result
        return None

    def analyze(self, evidence_packet: dict[str, Any], repair: bool = False) -> dict[str, Any] | None:
        if not self.config.enabled:
            return None
        started_at = perf_counter()
        task = "cause_review"
        prompt = self._build_prompt(evidence_packet, repair=repair)
        requested_context = self._task_context(task)
        timeout_seconds = self._task_timeout(task)
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
                        "temperature": self.config.temperature,
                        "num_ctx": requested_context,
                    },
                    "keep_alive": self.config.keep_alive,
                },
                timeout=timeout_seconds,
            )
            response.raise_for_status()
            payload = response.json()
            result = self._parse_model_json(payload)
            if result is not None:
                self._record_telemetry(
                    task=task,
                    started_at=started_at,
                    payload=payload,
                    prompt=prompt,
                    requested_context=requested_context,
                    timeout_seconds=timeout_seconds,
                )
                return result
            self._record_telemetry(
                task=task,
                started_at=started_at,
                payload=payload,
                status="invalid",
                prompt=prompt,
                requested_context=requested_context,
                timeout_seconds=timeout_seconds,
            )
            return None
        except Exception as exc:
            self._record_telemetry(
                task=task,
                started_at=started_at,
                status="error",
                error=str(exc),
                prompt=prompt,
                requested_context=requested_context,
                timeout_seconds=timeout_seconds,
            )
            return None

    def summarize_display(self, display_packet: dict[str, Any]) -> dict[str, Any] | None:
        if not self.config.enabled:
            return None
        started_at = perf_counter()
        task = "display_summary"
        evidence_packet = display_packet.get("evidence_packet") if isinstance(display_packet.get("evidence_packet"), dict) else {}
        compact_packet = {
            "evidence_packet": {
                "as_of_myt": evidence_packet.get("as_of_myt"),
                "data_mode": evidence_packet.get("data_mode"),
                "market_move": evidence_packet.get("market_move"),
                "market_read": self._compact_market_read_for_summary(evidence_packet.get("market_read")),
                "allowed_candidate_drivers": evidence_packet.get("allowed_candidate_drivers"),
                "cross_asset_confirmation": evidence_packet.get("cross_asset_confirmation"),
                "evidence_status": evidence_packet.get("evidence_status"),
                "evidence_chain_status": evidence_packet.get("evidence_chain_status"),
            },
            "analysis": self._compact_analysis_for_summary(display_packet.get("analysis")),
            "news": self._compact_rows_for_summary(
                display_packet.get("news"),
                fields=("title", "source", "published_at", "timestamp_myt", "summary", "summary_title", "display_summary"),
                limit=6,
                visible_only=True,
            ),
            "calendar": self._compact_rows_for_summary(
                display_packet.get("calendar"),
                fields=("title", "source", "scheduled_at", "timestamp_myt", "impact", "currency", "summary", "summary_title"),
                limit=4,
            ),
            "related_assets": self._compact_rows_for_summary(
                display_packet.get("related_assets"),
                fields=("symbol", "source", "source_type", "data_mode", "current_value", "change_value", "change_15m", "stale_reason", "summary"),
                limit=8,
            ),
        }
        prompt = (
            "Create short UI summaries for the XAUUSD Market Agent dashboard. "
            "Use only supplied facts. Do not invent drivers, prices, headlines, or causes. "
            "Return strict JSON only. The JSON may contain news, calendar, and related_assets. "
            "news and calendar must be arrays of objects with source_index, summary_title, and summary. "
            "related_assets must be an object keyed by lower-case symbol; each value is an array of "
            "objects with source_index and summary. Keep summary_title 5-11 words, natural, and complete; "
            "it must include the market action or event, not a keyword pile like 'Trump peace deal Iran'. "
            "Keep summary under 90 characters. "
            "source_index must point to the supplied input row index.\n\n"
            f"{json.dumps(compact_packet, ensure_ascii=True, indent=2, sort_keys=True)}"
        )
        requested_context = self._task_context(task)
        timeout_seconds = self._task_timeout(task)
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
                        "num_ctx": requested_context,
                    },
                    "keep_alive": self.config.keep_alive,
                },
                timeout=timeout_seconds,
            )
            response.raise_for_status()
            payload = response.json()
            result = self._parse_model_json(payload)
            if result is not None:
                self._record_telemetry(
                    task=task,
                    started_at=started_at,
                    payload=payload,
                    prompt=prompt,
                    requested_context=requested_context,
                    timeout_seconds=timeout_seconds,
                )
                return result
            self._record_telemetry(
                task=task,
                started_at=started_at,
                payload=payload,
                status="invalid",
                prompt=prompt,
                requested_context=requested_context,
                timeout_seconds=timeout_seconds,
            )
            return None
        except Exception as exc:
            self._record_telemetry(
                task=task,
                started_at=started_at,
                status="error",
                error=str(exc),
                prompt=prompt,
                requested_context=requested_context,
                timeout_seconds=timeout_seconds,
            )
            return None

    def review_alert(self, alert_packet: dict[str, Any]) -> dict[str, Any] | None:
        if not self.config.enabled:
            return None
        started_at = perf_counter()
        task = "alert_review"
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
        requested_context = self._task_context(task)
        timeout_seconds = self._task_timeout(task)
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
                        "num_ctx": requested_context,
                    },
                    "keep_alive": self.config.keep_alive,
                },
                timeout=timeout_seconds,
            )
            response.raise_for_status()
            payload = response.json()
            if isinstance(payload.get("response"), str):
                review = json.loads(payload["response"])
                if isinstance(review, dict):
                    self._record_telemetry(
                        task=task,
                        started_at=started_at,
                        payload=payload,
                        prompt=prompt,
                        requested_context=requested_context,
                        timeout_seconds=timeout_seconds,
                    )
                    return review
            self._record_telemetry(
                task=task,
                started_at=started_at,
                payload=payload,
                status="invalid",
                prompt=prompt,
                requested_context=requested_context,
                timeout_seconds=timeout_seconds,
            )
            return None
        except Exception as exc:
            self._record_telemetry(
                task=task,
                started_at=started_at,
                status="error",
                error=str(exc),
                prompt=prompt,
                requested_context=requested_context,
                timeout_seconds=timeout_seconds,
            )
            return None
