from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Any

from .models import CrossAssetSnapshot, Headline, MarketMove, ProviderHealth, ScenarioFixture


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat()


def build_provider_health(
    *,
    source: str,
    source_type: str,
    data_mode: str,
    is_available: bool = True,
    is_stale: bool = False,
    stale_reason: str = "",
    error: str = "",
    raw_source_id: str = "",
    latency_ms: float | None = None,
    current_value: float | None = None,
    previous_value: float | None = None,
    change_value: float | None = None,
    change_unit: str = "",
    fetched_at: str | None = None,
    data_timestamp: str | None = None,
) -> ProviderHealth:
    timestamp = fetched_at or _now_iso()
    return ProviderHealth(
        source=source,
        source_type=source_type,
        fetched_at=timestamp,
        data_timestamp=data_timestamp or timestamp,
        data_mode=data_mode,
        is_available=is_available,
        is_stale=is_stale,
        stale_reason=stale_reason,
        error=error,
        raw_source_id=raw_source_id,
        latency_ms=latency_ms,
        current_value=current_value,
        previous_value=previous_value,
        change_value=change_value,
        change_unit=change_unit,
    )


def build_fixture_provider_health(
    fixture: ScenarioFixture,
    *,
    data_mode: str = "live_seen",
) -> dict[str, ProviderHealth]:
    health: dict[str, ProviderHealth] = {
        "xauusd": build_provider_health(
            source="XAUUSD",
            source_type="price",
            data_mode=data_mode,
            current_value=fixture.market.to_price,
            previous_value=fixture.market.from_price,
            change_value=fixture.market.move_percent,
            change_unit="percent",
        ),
        "dxy": build_provider_health(
            source="DXY",
            source_type="related_asset",
            data_mode=data_mode,
            current_value=fixture.cross_asset.dxy_percent,
            change_value=fixture.cross_asset.dxy_percent,
            change_unit="percent",
        ),
        "us10y": build_provider_health(
            source="US10Y",
            source_type="related_asset",
            data_mode=data_mode,
            current_value=fixture.cross_asset.us10y_bps,
            change_value=fixture.cross_asset.us10y_bps,
            change_unit="bps",
        ),
        "us2y": build_provider_health(
            source="US2Y",
            source_type="related_asset",
            data_mode=data_mode,
            current_value=fixture.cross_asset.us2y_bps,
            change_value=fixture.cross_asset.us2y_bps,
            change_unit="bps",
        ),
        "wti": build_provider_health(
            source="WTI",
            source_type="related_asset",
            data_mode=data_mode,
            current_value=fixture.cross_asset.wti_percent,
            change_value=fixture.cross_asset.wti_percent,
            change_unit="percent",
        ),
        "brent": build_provider_health(
            source="Brent",
            source_type="related_asset",
            data_mode=data_mode,
            current_value=fixture.cross_asset.brent_percent,
            change_value=fixture.cross_asset.brent_percent,
            change_unit="percent",
        ),
        "vix": build_provider_health(
            source="VIX",
            source_type="related_asset",
            data_mode=data_mode,
            current_value=fixture.cross_asset.vix_percent,
            change_value=fixture.cross_asset.vix_percent,
            change_unit="percent",
        ),
        "spx": build_provider_health(
            source="SPX",
            source_type="related_asset",
            data_mode=data_mode,
            current_value=fixture.cross_asset.spx_percent,
            change_value=fixture.cross_asset.spx_percent,
            change_unit="percent",
        ),
        "nasdaq": build_provider_health(
            source="Nasdaq",
            source_type="related_asset",
            data_mode=data_mode,
            current_value=fixture.cross_asset.nasdaq_percent,
            change_value=fixture.cross_asset.nasdaq_percent,
            change_unit="percent",
        ),
        "news": build_provider_health(
            source="News",
            source_type="news",
            data_mode=data_mode if (fixture.news or fixture.calendar_events) else "unavailable",
            is_available=bool(fixture.news or fixture.calendar_events),
            current_value=float(len(fixture.news)),
        ),
        "calendar": build_provider_health(
            source="Economic Calendar",
            source_type="calendar",
            data_mode=data_mode if fixture.calendar_events else "unavailable",
            is_available=bool(fixture.calendar_events),
            current_value=float(len(fixture.calendar_events)),
        ),
    }
    return health


def health_to_dict(health: dict[str, ProviderHealth]) -> dict[str, dict[str, Any]]:
    return {key: asdict(value) for key, value in health.items()}
