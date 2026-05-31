from __future__ import annotations

from typing import Any

from .models import AnalysisResult, ValidationResult

BIAS_VALUES = {"bearish_gold", "bullish_gold", "neutral", "unknown"}
DRIVER_VALUES = {
    "fed_rates",
    "inflation",
    "usd",
    "yields",
    "real_yields",
    "oil_inflation",
    "geopolitics",
    "risk_sentiment",
    "china_demand",
    "central_bank_gold",
    "positioning",
    "technical_liquidation",
    "economic_calendar",
    "unknown",
}
CAUSE_VALUES = {
    "confirmed",
    "likely",
    "possible",
    "unconfirmed",
    "no_meaningful_change",
    "no_news_found",
}
CONFIDENCE_VALUES = {"high", "medium", "low"}
NOTIFICATION_VALUES = {"level_1", "level_2", "level_3", "none"}
CONFIRMATION_KEYS = {"dxy", "us10y", "us2y", "oil", "vix_equities"}
EVIDENCE_KEYS = {"dxy", "us10y", "us2y", "oil", "vix_equities", "news"}


def _ensure(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def _build_result(payload: dict[str, Any], rejected_driver: str | None = None, rejection_reason: str | None = None) -> ValidationResult:
    return ValidationResult(
        bias=payload["bias"],
        main_driver=payload["main_driver"],
        secondary_driver=payload["secondary_driver"],
        cause_status=payload["cause_status"],
        confidence=payload["confidence"],
        is_new_state=bool(payload["is_new_state"]),
        is_continuation=bool(payload["is_continuation"]),
        previous_state_invalidated=bool(payload["previous_state_invalidated"]),
        should_notify=bool(payload["should_notify"]),
        notification_level=payload["notification_level"],
        no_news_found=bool(payload["no_news_found"]),
        allowed_candidate_drivers_used=list(payload["allowed_candidate_drivers_used"]),
        rejected_or_blocked_drivers_acknowledged=bool(payload["rejected_or_blocked_drivers_acknowledged"]),
        timeline=list(payload["timeline"]),
        cross_asset_confirmation=dict(payload["cross_asset_confirmation"]),
        evidence_status=dict(payload["evidence_status"]),
        causal_chain=payload["causal_chain"],
        invalidation_conditions=list(payload["invalidation_conditions"]),
        user_message=payload["user_message"],
        summary=payload.get("summary", ""),
        rejected_driver=rejected_driver,
        rejection_reason=rejection_reason,
    )


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes"}
    return bool(value)


def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    return [value]


def _as_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return " ".join(str(item) for item in value if str(item).strip())
    if value is None:
        return ""
    return str(value)


def _normalize_llm_payload(payload: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(payload)
    if normalized.get("secondary_driver") == "":
        normalized["secondary_driver"] = None
    for key in (
        "is_new_state",
        "is_continuation",
        "previous_state_invalidated",
        "should_notify",
        "no_news_found",
        "rejected_or_blocked_drivers_acknowledged",
    ):
        if key in normalized:
            normalized[key] = _as_bool(normalized[key])
    for key in ("timeline", "allowed_candidate_drivers_used", "invalidation_conditions"):
        if key in normalized:
            normalized[key] = _as_list(normalized[key])
    for key in ("causal_chain", "user_message", "summary"):
        if key in normalized:
            normalized[key] = _as_text(normalized[key])
    if not normalized.get("user_message") and normalized.get("summary"):
        normalized["user_message"] = normalized["summary"]
    if not normalized.get("causal_chain") and normalized.get("summary"):
        normalized["causal_chain"] = normalized["summary"]
    return normalized


def _validate_schema(payload: dict[str, Any]) -> None:
    required = {
        "bias",
        "main_driver",
        "secondary_driver",
        "cause_status",
        "confidence",
        "is_new_state",
        "is_continuation",
        "previous_state_invalidated",
        "should_notify",
        "notification_level",
        "no_news_found",
        "allowed_candidate_drivers_used",
        "rejected_or_blocked_drivers_acknowledged",
        "timeline",
        "cross_asset_confirmation",
        "evidence_status",
        "causal_chain",
        "invalidation_conditions",
        "user_message",
    }
    missing = required - set(payload)
    _ensure(not missing, f"Missing keys: {sorted(missing)}")
    _ensure(payload["bias"] in BIAS_VALUES, "Invalid bias")
    _ensure(payload["main_driver"] in DRIVER_VALUES, "Invalid main_driver")
    _ensure(payload["secondary_driver"] in DRIVER_VALUES or payload["secondary_driver"] is None, "Invalid secondary_driver")
    _ensure(payload["cause_status"] in CAUSE_VALUES, "Invalid cause_status")
    _ensure(payload["confidence"] in CONFIDENCE_VALUES, "Invalid confidence")
    _ensure(payload["notification_level"] in NOTIFICATION_VALUES, "Invalid notification_level")
    _ensure(set(payload["cross_asset_confirmation"]) == CONFIRMATION_KEYS, "Invalid cross_asset_confirmation keys")
    _ensure(set(payload["evidence_status"]) == EVIDENCE_KEYS, "Invalid evidence_status keys")
    _ensure(isinstance(payload["timeline"], list), "Timeline must be a list")
    _ensure(isinstance(payload["allowed_candidate_drivers_used"], list), "allowed_candidate_drivers_used must be a list")
    _ensure(isinstance(payload["invalidation_conditions"], list), "invalidation_conditions must be a list")
    _ensure(isinstance(payload["user_message"], str) and payload["user_message"].strip(), "user_message must be non-empty")


def validate_llm_output(
    llm_payload: dict[str, Any],
    allowed_candidate_drivers: list[str],
    blocked_drivers: dict[str, str],
    fallback_result: AnalysisResult | None = None,
) -> ValidationResult:
    payload = _normalize_llm_payload(llm_payload)
    _validate_schema(payload)
    driver = payload["main_driver"]
    if driver != "unknown" and driver not in allowed_candidate_drivers:
        if fallback_result is not None:
            fallback_payload = fallback_result.to_dict()
            fallback_payload["main_driver"] = "unknown"
            fallback_payload["secondary_driver"] = None
            fallback_payload["allowed_candidate_drivers_used"] = [
                item for item in fallback_payload["allowed_candidate_drivers_used"] if item in allowed_candidate_drivers
            ]
            return _build_result(
                fallback_payload,
                rejected_driver=driver,
                rejection_reason=blocked_drivers.get(driver, "Driver not allowed."),
            )
        payload["main_driver"] = "unknown"
        payload["secondary_driver"] = None
        payload["cause_status"] = "unconfirmed"
        payload["confidence"] = "low"
        payload["should_notify"] = False
        payload["notification_level"] = "none"
        payload["allowed_candidate_drivers_used"] = [item for item in payload["allowed_candidate_drivers_used"] if item in allowed_candidate_drivers]
        payload["rejected_or_blocked_drivers_acknowledged"] = True
        payload["user_message"] = "No confirmed macro/news driver found. XAUUSD movement is currently unconfirmed."
        payload["summary"] = "Blocked driver claim rejected."
        return _build_result(
            payload,
            rejected_driver=driver,
            rejection_reason=blocked_drivers.get(driver, "Driver not allowed."),
        )
    return _build_result(payload)
