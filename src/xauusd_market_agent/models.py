from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(frozen=True)
class Headline:
    timestamp_myt: str
    source: str
    title: str
    relevance_reason: str
    impact_direction_on_gold: str
    tags: tuple[str, ...] = ()

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "Headline":
        return cls(
            timestamp_myt=payload["timestamp_myt"],
            source=payload["source"],
            title=payload["title"],
            relevance_reason=payload["relevance_reason"],
            impact_direction_on_gold=payload["impact_direction_on_gold"],
            tags=tuple(payload.get("tags", [])),
        )


@dataclass(frozen=True)
class MarketMove:
    symbol: str
    from_price: float
    to_price: float
    move_percent: float
    move_percent_15m: float
    move_percent_1h: float
    window_minutes: int
    breaks: tuple[str, ...] = ()

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "MarketMove":
        return cls(
            symbol=payload["symbol"],
            from_price=float(payload["from_price"]),
            to_price=float(payload["to_price"]),
            move_percent=float(payload["move_percent"]),
            move_percent_15m=float(payload["move_percent_15m"]),
            move_percent_1h=float(payload["move_percent_1h"]),
            window_minutes=int(payload["window_minutes"]),
            breaks=tuple(payload.get("breaks", [])),
        )


@dataclass(frozen=True)
class CrossAssetSnapshot:
    dxy_percent: float
    us10y_bps: float
    us2y_bps: float
    wti_percent: float
    brent_percent: float
    vix_percent: float
    spx_percent: float
    nasdaq_percent: float

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "CrossAssetSnapshot":
        return cls(
            dxy_percent=float(payload.get("dxy_percent", 0.0)),
            us10y_bps=float(payload.get("us10y_bps", 0.0)),
            us2y_bps=float(payload.get("us2y_bps", 0.0)),
            wti_percent=float(payload.get("wti_percent", 0.0)),
            brent_percent=float(payload.get("brent_percent", 0.0)),
            vix_percent=float(payload.get("vix_percent", 0.0)),
            spx_percent=float(payload.get("spx_percent", 0.0)),
            nasdaq_percent=float(payload.get("nasdaq_percent", 0.0)),
        )


@dataclass(frozen=True)
class ScenarioFixture:
    scenario_id: str
    as_of_myt: str
    market: MarketMove
    cross_asset: CrossAssetSnapshot
    calendar_events: tuple[Headline, ...] = ()
    news: tuple[Headline, ...] = ()
    expected_llm_claim: dict[str, Any] | None = None

    @property
    def expected_rule_based_result(self) -> "AnalysisResult":
        from .pipeline import build_rule_based_analysis

        return build_rule_based_analysis(self)


@dataclass(frozen=True)
class TriggerDecision:
    triggered: bool
    trigger_types: list[str]


@dataclass(frozen=True)
class EvidenceGateResult:
    allowed_candidate_drivers: list[str]
    blocked_drivers: dict[str, str]
    cross_asset_confirmation: dict[str, str]
    evidence_status: dict[str, str]


@dataclass(frozen=True)
class ProviderHealth:
    source: str
    source_type: str
    fetched_at: str
    data_timestamp: str
    data_mode: str
    is_available: bool
    is_stale: bool
    stale_reason: str = ""
    error: str = ""
    raw_source_id: str = ""
    current_value: float | None = None
    previous_value: float | None = None
    change_value: float | None = None
    change_unit: str = ""


@dataclass(frozen=True)
class DriverDefinition:
    driver_id: str
    label: str
    category: str
    priority: str
    linked_assets: tuple[str, ...] = ()
    required_evidence_gates: tuple[str, ...] = ()
    optional_evidence_gates: tuple[str, ...] = ()


@dataclass(frozen=True)
class DriverAttentionState:
    driver_id: str
    label: str
    category: str
    current_state: str
    priority: str
    relevance_score: float
    activation_reason: str
    deactivation_reason: str
    first_activated_at: str
    last_confirmed_at: str
    last_evidence_at: str
    decay_deadline: str
    linked_assets: tuple[str, ...]
    required_evidence_gates: tuple[str, ...]
    optional_evidence_gates: tuple[str, ...]
    current_evidence_summary: str
    current_counter_evidence: str
    confidence: str
    source_count: int
    related_news_count: int
    related_calendar_events: int
    notes: str
    data_mode: str


@dataclass(frozen=True)
class DriverAttentionSnapshot:
    states: dict[str, DriverAttentionState]
    active_driver_states: list[dict[str, str]]
    dormant_driver_states: list[dict[str, str]]
    driver_attention_summary: dict[str, object]


@dataclass(frozen=True)
class AnalysisResult:
    bias: str
    main_driver: str
    secondary_driver: str | None
    cause_status: str
    confidence: str
    is_new_state: bool
    is_continuation: bool
    previous_state_invalidated: bool
    should_notify: bool
    notification_level: str
    no_news_found: bool
    allowed_candidate_drivers_used: list[str]
    rejected_or_blocked_drivers_acknowledged: bool
    timeline: list[dict[str, str]]
    cross_asset_confirmation: dict[str, str]
    evidence_status: dict[str, str]
    causal_chain: str
    invalidation_conditions: list[str]
    user_message: str
    summary: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class ValidationResult(AnalysisResult):
    rejected_driver: str | None = None
    rejection_reason: str | None = None


@dataclass(frozen=True)
class MarketState:
    current_bias: str
    main_driver: str
    secondary_driver: str | None
    risk_driver: str | None
    confidence: str
    last_alert_time: str
    last_alert_summary: str
    cause_status: str = "unconfirmed"
    last_analysis_time: str = ""
    last_notification_level: str = "none"
    state_change_reason: str = ""
    invalidation_triggered: bool = False
    invalidation_triggered_by: list[str] = field(default_factory=list)
    invalidation_conditions: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class TransitionResult:
    next_state: MarketState
    should_notify: bool
    is_new_state: bool
    is_continuation: bool
    previous_state_invalidated: bool
    state_change_reason: str
    confidence_changed: bool
    confidence_delta: str
    invalidation_triggered_by: list[str]


@dataclass(frozen=True)
class NotificationDecision:
    should_notify: bool
    notification_level: str
    reason: str
    next_state: MarketState
    is_new_state: bool
    is_continuation: bool
    previous_state_invalidated: bool
    state_change_reason: str
    confidence_changed: bool
    confidence_delta: str
    invalidation_triggered_by: list[str]
