from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from ..models import ProviderHealth


@dataclass(frozen=True)
class MarketBar:
    timestamp: str
    symbol: str
    open: float
    high: float
    low: float
    close: float
    bid: float | None = None
    ask: float | None = None
    source: str = ""
    source_type: str = ""
    data_mode: str = "live_seen"
    is_stale: bool = False
    stale_reason: str = ""


@dataclass(frozen=True)
class RelatedAssetBar:
    timestamp: str
    symbol: str
    value: float
    change_15m: float
    change_30m: float
    change_60m: float
    source: str = ""
    source_type: str = ""
    data_mode: str = "live_seen"
    is_stale: bool = False
    stale_reason: str = ""


@dataclass(frozen=True)
class NewsItem:
    published_at: str
    first_seen_at: str
    backfilled_at: str | None
    is_backfilled: bool
    source: str
    title: str
    link: str
    relevance_reason: str
    impact_direction_on_gold: str
    data_mode: str
    score: float = 0.0
    matched_keywords: tuple[str, ...] = ()
    categories: tuple[str, ...] = ()


@dataclass(frozen=True)
class CalendarItem:
    scheduled_at: str
    source: str
    title: str
    relevance_reason: str
    impact_direction_on_gold: str
    data_mode: str
    actual: str = ""
    forecast: str = ""
    previous: str = ""
    country: str = ""
    impact: str = ""


@dataclass(frozen=True)
class ProviderBundle:
    provider_health: dict[str, ProviderHealth]
    market_price_bars: list[dict[str, object]]
    related_asset_bars: list[dict[str, object]]
    news_rows: list[dict[str, object]]
    calendar_rows: list[dict[str, object]]


class MarketDataProvider(Protocol):
    def fetch_latest(self, anchor_time: datetime) -> tuple[list[dict[str, object]], ProviderHealth]: ...

    def backfill(self, start: datetime, end: datetime) -> tuple[list[dict[str, object]], ProviderHealth]: ...


class RelatedAssetsProvider(Protocol):
    def fetch_latest(self, anchor_time: datetime) -> tuple[list[dict[str, object]], dict[str, ProviderHealth]]: ...

    def backfill(self, start: datetime, end: datetime) -> tuple[list[dict[str, object]], dict[str, ProviderHealth]]: ...


class NewsProvider(Protocol):
    def fetch_latest(self, anchor_time: datetime) -> tuple[list[dict[str, object]], ProviderHealth]: ...

    def backfill(self, start: datetime, end: datetime) -> tuple[list[dict[str, object]], ProviderHealth]: ...


class CalendarProvider(Protocol):
    def fetch_window(self, anchor_time: datetime) -> tuple[list[dict[str, object]], ProviderHealth]: ...

    def backfill(self, start: datetime, end: datetime) -> tuple[list[dict[str, object]], ProviderHealth]: ...
