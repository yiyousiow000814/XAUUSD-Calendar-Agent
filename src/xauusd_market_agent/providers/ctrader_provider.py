from __future__ import annotations

import json
import os
from pathlib import Path

from ..models import ProviderHealth


class CTraderProvider:
    def __init__(self, *, saved_snapshot_path: Path | None = None) -> None:
        self.saved_snapshot_path = Path(saved_snapshot_path) if saved_snapshot_path is not None else None
        self.client_id = os.getenv("CTRADER_CLIENT_ID", "").strip()
        self.client_secret = os.getenv("CTRADER_CLIENT_SECRET", "").strip()
        self.access_token = os.getenv("CTRADER_ACCESS_TOKEN", "").strip()
        self.account_id = os.getenv("CTRADER_ACCOUNT_ID", "").strip()
        self.symbol = os.getenv("CTRADER_SYMBOL", "XAUUSD").strip() or "XAUUSD"

    def is_configured(self) -> bool:
        return all((self.client_id, self.client_secret, self.access_token, self.account_id))

    def _unavailable_health(self, reason: str) -> ProviderHealth:
        now = __import__("datetime").datetime.now().astimezone().isoformat()
        return ProviderHealth(
            source="cTrader",
            source_type="spot",
            fetched_at=now,
            data_timestamp=now,
            data_mode="unavailable",
            is_available=False,
            is_stale=False,
            stale_reason=reason,
            error=reason,
            raw_source_id=self.symbol,
        )

    def fetch_latest(self, anchor_time) -> tuple[list[dict[str, object]], ProviderHealth]:
        if self.is_configured():
            return [], self._unavailable_health(
                "cTrader credentials detected, but live quote fetching is disabled in this build. Yahoo GC=F proxy remains the default provider."
            )
        if self.saved_snapshot_path is not None and self.saved_snapshot_path.exists():
            payload = json.loads(self.saved_snapshot_path.read_text(encoding="utf-8"))
            row = {
                "timestamp": payload["timestamp"],
                "symbol": payload.get("symbol", self.symbol),
                "open": float(payload["price"]),
                "high": float(payload["price"]),
                "low": float(payload["price"]),
                "close": float(payload["price"]),
                "bid": float(payload.get("bid", payload["price"])),
                "ask": float(payload.get("ask", payload["price"])),
                "source": "cTrader saved snapshot",
                "source_type": "spot_snapshot",
                "data_mode": "stale",
                "is_stale": True,
                "stale_reason": "Loaded saved quote snapshot fallback.",
            }
            health = ProviderHealth(
                source="cTrader",
                source_type="spot_snapshot",
                fetched_at=anchor_time.isoformat(),
                data_timestamp=str(payload["timestamp"]),
                data_mode="stale",
                is_available=True,
                is_stale=True,
                stale_reason="Loaded saved quote snapshot fallback.",
                raw_source_id=self.symbol,
                current_value=float(payload["price"]),
            )
            return [row], health
        return [], self._unavailable_health("cTrader credentials are missing.")

    def backfill(self, start, end) -> tuple[list[dict[str, object]], ProviderHealth]:
        return [], self._unavailable_health(
            "cTrader historical backfill is disabled in this build. Yahoo GC=F proxy remains the default provider."
        )
