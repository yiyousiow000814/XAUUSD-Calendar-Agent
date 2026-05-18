from __future__ import annotations

import json
from pathlib import Path

from .models import MarketState
from .state import empty_market_state


class JsonStateStore:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    def load(self) -> MarketState:
        if not self.path.exists():
            return empty_market_state()
        payload = json.loads(self.path.read_text(encoding="utf-8"))
        return MarketState(
            current_bias=payload.get("current_bias", "unknown"),
            main_driver=payload.get("main_driver", "unknown"),
            secondary_driver=payload.get("secondary_driver"),
            risk_driver=payload.get("risk_driver"),
            confidence=payload.get("confidence", "low"),
            last_alert_time=payload.get("last_alert_time", ""),
            last_alert_summary=payload.get("last_alert_summary", ""),
            cause_status=payload.get("cause_status", "unconfirmed"),
            last_analysis_time=payload.get("last_analysis_time", ""),
            last_notification_level=payload.get("last_notification_level", "none"),
            state_change_reason=payload.get("state_change_reason", ""),
            invalidation_triggered=bool(payload.get("invalidation_triggered", False)),
            invalidation_triggered_by=list(payload.get("invalidation_triggered_by", [])),
            invalidation_conditions=list(payload.get("invalidation_conditions", [])),
        )

    def save(self, state: MarketState) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps(
                {
                    "current_bias": state.current_bias,
                    "main_driver": state.main_driver,
                    "secondary_driver": state.secondary_driver,
                    "risk_driver": state.risk_driver,
                    "confidence": state.confidence,
                    "last_alert_time": state.last_alert_time,
                    "last_alert_summary": state.last_alert_summary,
                    "cause_status": state.cause_status,
                    "last_analysis_time": state.last_analysis_time,
                    "last_notification_level": state.last_notification_level,
                    "state_change_reason": state.state_change_reason,
                    "invalidation_triggered": state.invalidation_triggered,
                    "invalidation_triggered_by": list(state.invalidation_triggered_by),
                    "invalidation_conditions": list(state.invalidation_conditions),
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
