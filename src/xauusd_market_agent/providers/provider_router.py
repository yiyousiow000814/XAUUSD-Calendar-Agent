from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from ..config import CTraderCliConfig, MarketAgentConfig
from ..models import ProviderHealth
from ..provider_health import build_provider_health
from .base import CalendarProvider, MarketDataProvider, NewsProvider, RelatedAssetsProvider
from .ctrader_provider import CTraderProvider
from .forex_factory_provider import ForexFactoryProvider
from .rss_provider import RSSNewsProvider
from .yahoo_chart import YahooChartProvider


_RELATED_SYMBOLS = {
    "dxy": "DX-Y.NYB",
    "us10y": "^TNX",
    "wti": "CL=F",
    "brent": "BZ=F",
    "vix": "^VIX",
    "spx": "^GSPC",
    "nasdaq": "^IXIC",
}


@dataclass(frozen=True)
class ProviderRouterResult:
    provider_health: dict[str, ProviderHealth]
    market_price_bars: list[dict[str, Any]]
    related_asset_bars: list[dict[str, Any]]
    news_rows: list[dict[str, Any]]
    calendar_rows: list[dict[str, Any]]


class ProviderRouter:
    def __init__(
        self,
        *,
        market_provider: MarketDataProvider | None = None,
        related_assets_provider: RelatedAssetsProvider | None = None,
        news_provider: NewsProvider | None = None,
        calendar_provider: CalendarProvider | None = None,
        csv_price_path: Path | None = None,
        csv_related_assets_path: Path | None = None,
        csv_related_assets_dir: Path | None = None,
        csv_calendar_dir: Path | None = None,
        yahoo_fixture_dir: Path | None = None,
        rss_feeds: list[str] | None = None,
        yahoo_enabled: bool = True,
        csv_fallback_enabled: bool = True,
        ctrader_saved_snapshot_path: Path | None = None,
        ctrader_provider: CTraderProvider | None = None,
    ) -> None:
        self.market_provider = market_provider
        self.related_assets_provider = related_assets_provider
        self.news_provider = news_provider
        self.calendar_provider = calendar_provider
        self.csv_price_path = csv_price_path
        self.csv_related_assets_path = csv_related_assets_path
        self.csv_related_assets_dir = csv_related_assets_dir
        self.csv_calendar_dir = csv_calendar_dir
        self.yahoo_fixture_dir = yahoo_fixture_dir
        self.rss_feeds = rss_feeds or []
        self.yahoo_enabled = yahoo_enabled
        self.csv_fallback_enabled = csv_fallback_enabled
        self.ctrader_saved_snapshot_path = ctrader_saved_snapshot_path
        if ctrader_provider is None:
            default_root = (
                Path(ctrader_saved_snapshot_path).resolve().parent.parent
                if ctrader_saved_snapshot_path is not None
                else Path.cwd()
            )
            ctrader_provider = CTraderProvider(
                cli_config=CTraderCliConfig.default(default_root),
                saved_snapshot_path=ctrader_saved_snapshot_path,
            )
        self.ctrader_provider = ctrader_provider
        self.last_market_provider_meta: dict[str, Any] = {
            "selected_market_provider": "unavailable",
            "provider_chain_status": [],
            "fallback_reason": "",
        }

    @classmethod
    def from_config(cls, config: MarketAgentConfig) -> "ProviderRouter":
        return cls(
            market_provider=None,
            related_assets_provider=None,
            news_provider=RSSNewsProvider(config.rss_feeds) if config.rss_feeds else None,
            calendar_provider=ForexFactoryProvider(
                fixture_path=config.forex_factory_fixture_path,
                source_url=config.forex_factory_source_url or None,
            )
            if config.forex_factory_fixture_path is not None or config.forex_factory_source_url
            else None,
            csv_price_path=config.price_data_path,
            csv_related_assets_path=config.related_assets_path,
            csv_related_assets_dir=config.related_assets_dir,
            csv_calendar_dir=config.calendar_dir,
            yahoo_fixture_dir=config.yahoo_fixture_dir,
            rss_feeds=config.rss_feeds,
            yahoo_enabled=config.yahoo_enabled,
            csv_fallback_enabled=config.csv_fallback_enabled,
            ctrader_saved_snapshot_path=config.ctrader_saved_snapshot_path,
            ctrader_provider=CTraderProvider.from_market_agent_config(config),
        )

    def _yahoo(self) -> YahooChartProvider:
        return YahooChartProvider(fixture_dir=self.yahoo_fixture_dir, enabled=self.yahoo_enabled)

    def _market_chain(self) -> list[Any]:
        chain: list[Any] = []
        chain.append(self.ctrader_provider)
        if self.yahoo_enabled:
            chain.append(self._yahoo())
        if self.csv_fallback_enabled and self.csv_price_path is not None:
            chain.append(self.csv_price_path)
        return chain

    def fetch_market_context(self, anchor_time: datetime) -> tuple[list[dict[str, Any]], ProviderHealth]:
        if self.market_provider is not None:
            return self.market_provider.fetch_latest(anchor_time)
        chain_status: list[dict[str, Any]] = []
        stale_ctrader_rows: list[dict[str, Any]] = []
        stale_ctrader_health: ProviderHealth | None = None
        for candidate in self._market_chain():
            if isinstance(candidate, Path):
                rows, health = self._load_market_csv_fallback(candidate, anchor_time, data_mode="stale")
                chain_status.append(self._build_chain_entry("csv_fallback", health))
                self.last_market_provider_meta = {
                    "selected_market_provider": "unavailable",
                    "provider_chain_status": chain_status,
                    "fallback_reason": "CSV fallback is debug/import only and is not used for live market conclusions.",
                }
                return [], build_provider_health(
                    source="XAUUSD",
                    source_type="provider_interface",
                    data_mode="unavailable",
                    is_available=False,
                    stale_reason="Live cTrader spot is unavailable. CSV fallback is debug/import only.",
                    data_timestamp=anchor_time.isoformat(),
                )
            if candidate is self.ctrader_provider:
                rows, health = candidate.fetch_latest(anchor_time)
                chain_status.append(self._build_chain_entry("ctrader_spot", health))
                if health.is_available and not health.is_stale and health.data_mode == "live_seen":
                    self.last_market_provider_meta = {
                        "selected_market_provider": "ctrader_spot",
                        "provider_chain_status": chain_status,
                        "fallback_reason": "",
                    }
                    return self._normalize_market_rows(rows), health
                if health.is_available and health.is_stale and health.source_type in {"spot", "spot_snapshot"}:
                    stale_ctrader_rows = rows
                    stale_ctrader_health = health
            else:
                rows, health = candidate.fetch_market_price(anchor_time)
                chain_status.append(self._build_chain_entry("yahoo_gc_f_proxy", health))
            if candidate is not self.ctrader_provider and health.is_available:
                continue
        if stale_ctrader_health is not None:
            self.last_market_provider_meta = {
                "selected_market_provider": "ctrader_spot_stale",
                "provider_chain_status": chain_status,
                "fallback_reason": "Last cTrader spot quote is stale; current driver conclusions require a fresh quote.",
            }
            return self._normalize_market_rows(stale_ctrader_rows), stale_ctrader_health
        self.last_market_provider_meta = {
            "selected_market_provider": "unavailable",
            "provider_chain_status": chain_status,
            "fallback_reason": self._fallback_reason(chain_status),
        }
        return [], build_provider_health(
            source="XAUUSD",
            source_type="provider_interface",
            data_mode="unavailable",
            is_available=False,
            stale_reason="No market provider configured.",
            data_timestamp=anchor_time.isoformat(),
        )

    def fetch_related_assets_context(
        self, anchor_time: datetime
    ) -> tuple[list[dict[str, Any]], dict[str, ProviderHealth]]:
        if self.related_assets_provider is not None:
            return self.related_assets_provider.fetch_latest(anchor_time)
        if self.yahoo_enabled:
            yahoo = self._yahoo()
            rows: list[dict[str, Any]] = []
            health_map: dict[str, ProviderHealth] = {}
            for key, symbol in _RELATED_SYMBOLS.items():
                series, health = yahoo.fetch_related_asset(symbol, anchor_time)
                health_map[key] = health
                rows.extend(self._normalize_related_rows(key, series, health))
            health_map["us2y"] = build_provider_health(
                source="US2Y",
                source_type="provider_interface",
                data_mode="unavailable",
                is_available=False,
                stale_reason="No reliable free US2Y Yahoo proxy is configured.",
                data_timestamp=anchor_time.isoformat(),
                raw_source_id="unavailable",
            )
            if health_map:
                return rows, health_map
        if self.csv_fallback_enabled and self.csv_related_assets_path is not None:
            return self._load_related_assets_csv_fallback(anchor_time)
        return [], {
            "related": build_provider_health(
                source="RelatedAssets",
                source_type="provider_interface",
                data_mode="unavailable",
                is_available=False,
                stale_reason="No related-asset provider configured.",
                data_timestamp=anchor_time.isoformat(),
            )
        }

    def fetch_news_context(self, anchor_time: datetime) -> tuple[list[dict[str, Any]], ProviderHealth]:
        if self.news_provider is not None:
            return self.news_provider.fetch_latest(anchor_time)
        if self.rss_feeds:
            return RSSNewsProvider(self.rss_feeds).fetch_latest(anchor_time)
        return [], build_provider_health(
            source="News",
            source_type="provider_interface",
            data_mode="unavailable",
            is_available=False,
            stale_reason="No news provider configured.",
            data_timestamp=anchor_time.isoformat(),
        )

    def fetch_calendar_context(self, anchor_time: datetime) -> tuple[list[dict[str, Any]], ProviderHealth]:
        if self.calendar_provider is not None:
            return self.calendar_provider.fetch_window(anchor_time)
        if self.csv_calendar_dir is not None and self.csv_calendar_dir.exists():
            return self._load_calendar_csv_fallback(anchor_time, data_mode="live_seen")
        return [], build_provider_health(
            source="Calendar",
            source_type="provider_interface",
            data_mode="unavailable",
            is_available=False,
            stale_reason="No calendar provider configured.",
            data_timestamp=anchor_time.isoformat(),
        )

    def backfill_market_context(self, start: datetime, end: datetime) -> tuple[list[dict[str, Any]], ProviderHealth]:
        if self.market_provider is not None:
            return self.market_provider.backfill(start, end)
        chain_status: list[dict[str, Any]] = []
        for candidate in self._market_chain():
            if isinstance(candidate, Path):
                rows, health = self._load_market_csv_fallback(candidate, end, data_mode="backfilled")
                self.last_market_provider_meta = {
                    "selected_market_provider": "csv_fallback",
                    "provider_chain_status": chain_status + [self._build_chain_entry("csv_fallback", health)],
                    "fallback_reason": "",
                }
                return rows, health
            if candidate is self.ctrader_provider:
                rows, health = candidate.backfill(start, end)
                chain_status.append(self._build_chain_entry("ctrader_spot", health))
                if health.is_available and rows:
                    self.last_market_provider_meta = {
                        "selected_market_provider": "ctrader_spot",
                        "provider_chain_status": chain_status,
                        "fallback_reason": "",
                    }
                    return self._normalize_market_rows(rows, data_mode_override="backfilled"), health
            else:
                rows, health = candidate.backfill("GC=F", start, end)
                chain_status.append(self._build_chain_entry("yahoo_gc_f_proxy", health))
            if candidate is not self.ctrader_provider and (health.is_available or health.data_mode in {"proxy", "stale"}):
                self.last_market_provider_meta = {
                    "selected_market_provider": "yahoo_gc_f_proxy",
                    "provider_chain_status": chain_status,
                    "fallback_reason": self._fallback_reason(chain_status),
                }
                return self._normalize_market_rows(rows, data_mode_override="backfilled"), health
        self.last_market_provider_meta = {
            "selected_market_provider": "unavailable",
            "provider_chain_status": chain_status,
            "fallback_reason": self._fallback_reason(chain_status),
        }
        return [], build_provider_health(
            source="XAUUSD",
            source_type="provider_interface",
            data_mode="unavailable",
            is_available=False,
            stale_reason="No market backfill provider configured.",
            data_timestamp=end.isoformat(),
        )

    def _build_chain_entry(self, provider: str, health: ProviderHealth) -> dict[str, Any]:
        return {
            "provider": provider,
            "source": health.source,
            "source_type": health.source_type,
            "data_mode": health.data_mode,
            "is_available": health.is_available,
            "is_stale": health.is_stale,
            "error": health.error,
            "stale_reason": health.stale_reason,
            "data_timestamp": health.data_timestamp,
        }

    def _fallback_reason(self, chain_status: list[dict[str, Any]]) -> str:
        failures = [
            item
            for item in chain_status
            if item["provider"] == "ctrader_spot"
            and (not item["is_available"] or item["is_stale"] or item["data_mode"] == "unavailable")
        ]
        if not failures:
            return ""
        latest = failures[-1]
        return latest["error"] or latest["stale_reason"] or "cTrader spot unavailable."

    def backfill_related_assets(
        self, start: datetime, end: datetime
    ) -> tuple[list[dict[str, Any]], dict[str, ProviderHealth]]:
        if self.related_assets_provider is not None:
            return self.related_assets_provider.backfill(start, end)
        if self.yahoo_enabled:
            yahoo = self._yahoo()
            rows: list[dict[str, Any]] = []
            health_map: dict[str, ProviderHealth] = {}
            for key, symbol in _RELATED_SYMBOLS.items():
                series, health = yahoo.backfill(symbol, start, end)
                health_map[key] = health
                rows.extend(self._normalize_related_rows(key, series, health, data_mode_override="backfilled"))
            health_map["us2y"] = build_provider_health(
                source="US2Y",
                source_type="provider_interface",
                data_mode="unavailable",
                is_available=False,
                stale_reason="No reliable free US2Y Yahoo proxy is configured.",
                data_timestamp=end.isoformat(),
                raw_source_id="unavailable",
            )
            return rows, health_map
        if self.csv_fallback_enabled and self.csv_related_assets_path is not None:
            return self._load_related_assets_csv_fallback(end, data_mode="backfilled")
        return [], {
            "related": build_provider_health(
                source="RelatedAssets",
                source_type="provider_interface",
                data_mode="unavailable",
                is_available=False,
                stale_reason="No related-asset backfill provider configured.",
                data_timestamp=end.isoformat(),
            )
        }

    def backfill_news(self, start: datetime, end: datetime) -> tuple[list[dict[str, Any]], ProviderHealth]:
        if self.news_provider is not None:
            return self.news_provider.backfill(start, end)
        if self.rss_feeds:
            return RSSNewsProvider(self.rss_feeds).backfill(start, end)
        return [], build_provider_health(
            source="News",
            source_type="provider_interface",
            data_mode="unavailable",
            is_available=False,
            stale_reason="No news backfill provider configured.",
            data_timestamp=end.isoformat(),
        )

    def backfill_calendar(self, start: datetime, end: datetime) -> tuple[list[dict[str, Any]], ProviderHealth]:
        if self.calendar_provider is not None:
            return self.calendar_provider.backfill(start, end)
        if self.csv_calendar_dir is not None and self.csv_calendar_dir.exists():
            return self._load_calendar_csv_fallback(end, data_mode="backfilled")
        return [], build_provider_health(
            source="Calendar",
            source_type="provider_interface",
            data_mode="unavailable",
            is_available=False,
            stale_reason="No calendar backfill provider configured.",
            data_timestamp=end.isoformat(),
        )

    def _load_market_csv_fallback(
        self, path: Path, anchor_time: datetime, *, data_mode: str
    ) -> tuple[list[dict[str, Any]], ProviderHealth]:
        try:
            from .market_prices import load_recent_market_snapshot

            fixture = load_recent_market_snapshot(path, anchor_time)
            rows = [
                {
                    "symbol": fixture.market.symbol,
                    "data_timestamp": anchor_time.isoformat(),
                    "open_price": fixture.market.from_price,
                    "high_price": max(fixture.market.from_price, fixture.market.to_price),
                    "low_price": min(fixture.market.from_price, fixture.market.to_price),
                    "close_price": fixture.market.to_price,
                    "bid_price": None,
                    "ask_price": None,
                    "move_percent": fixture.market.move_percent,
                    "source": str(path),
                    "source_type": "local_csv_fallback",
                    "data_mode": data_mode,
                    "is_stale": data_mode != "live_seen",
                    "stale_reason": "CSV fallback is debug/import only." if data_mode != "live_seen" else "",
                }
            ]
            return rows, build_provider_health(
                source="XAUUSD",
                source_type="local_csv_fallback",
                data_mode=data_mode,
                is_available=True,
                is_stale=data_mode != "live_seen",
                stale_reason="CSV fallback is debug/import only." if data_mode != "live_seen" else "",
                current_value=fixture.market.to_price,
                previous_value=fixture.market.from_price,
                change_value=fixture.market.move_percent,
                change_unit="percent",
                data_timestamp=anchor_time.isoformat(),
            )
        except Exception as exc:
            return [], build_provider_health(
                source="XAUUSD",
                source_type="local_csv_fallback",
                data_mode="unavailable",
                is_available=False,
                stale_reason="CSV fallback failed.",
                error=str(exc),
                data_timestamp=anchor_time.isoformat(),
            )

    def _load_related_assets_csv_fallback(
        self, anchor_time: datetime, *, data_mode: str = "live_seen"
    ) -> tuple[list[dict[str, Any]], dict[str, ProviderHealth]]:
        from .related_assets import load_related_assets_snapshot, load_related_assets_timeseries_snapshot

        if self.csv_related_assets_dir is not None and self.csv_related_assets_dir.exists():
            snapshot = load_related_assets_timeseries_snapshot(self.csv_related_assets_dir, anchor_time, 15)
        else:
            snapshot = load_related_assets_snapshot(self.csv_related_assets_path)
        source_type = "local_csv_fallback"
        data = {
            "dxy": (snapshot.dxy_percent, "percent"),
            "us10y": (snapshot.us10y_bps, "bps"),
            "us2y": (snapshot.us2y_bps, "bps"),
            "wti": (snapshot.wti_percent, "percent"),
            "brent": (snapshot.brent_percent, "percent"),
            "vix": (snapshot.vix_percent, "percent"),
            "spx": (snapshot.spx_percent, "percent"),
            "nasdaq": (snapshot.nasdaq_percent, "percent"),
        }
        rows = [
            {
                "symbol": symbol,
                "data_timestamp": anchor_time.isoformat(),
                "value": None,
                "change_15m": value,
                "change_30m": value,
                "change_60m": value,
                "change_value": value,
                "change_unit": unit,
                "source": str(self.csv_related_assets_dir or self.csv_related_assets_path),
                "source_type": source_type,
                "data_mode": data_mode,
                "is_stale": data_mode != "live_seen",
                "stale_reason": "CSV fallback is debug/import only." if data_mode != "live_seen" else "",
            }
            for symbol, (value, unit) in data.items()
        ]
        health = {
            symbol: build_provider_health(
                source=symbol.upper(),
                source_type=source_type,
                data_mode=data_mode,
                is_available=True,
                is_stale=data_mode != "live_seen",
                stale_reason="CSV fallback is debug/import only." if data_mode != "live_seen" else "",
                current_value=value,
                change_value=value,
                change_unit=unit,
                data_timestamp=anchor_time.isoformat(),
            )
            for symbol, (value, unit) in data.items()
        }
        return rows, health

    def _normalize_market_rows(
        self, rows: list[dict[str, Any]], *, data_mode_override: str | None = None
    ) -> list[dict[str, Any]]:
        normalized: list[dict[str, Any]] = []
        for row in rows:
            normalized.append(
                {
                    "symbol": row.get("symbol", "XAUUSD"),
                    "data_timestamp": row.get("data_timestamp", row.get("timestamp")),
                    "open_price": row.get("open_price", row.get("open")),
                    "high_price": row.get("high_price", row.get("high")),
                    "low_price": row.get("low_price", row.get("low")),
                    "close_price": row.get("close_price", row.get("close")),
                    "bid_price": row.get("bid_price", row.get("bid")),
                    "ask_price": row.get("ask_price", row.get("ask")),
                    "move_percent": row.get("move_percent"),
                    "source": row.get("source"),
                    "source_type": row.get("source_type", "provider_interface"),
                    "data_mode": data_mode_override or row.get("data_mode", "live_seen"),
                    "is_stale": row.get("is_stale", False),
                    "stale_reason": row.get("stale_reason", ""),
                }
            )
        return normalized

    def _load_calendar_csv_fallback(
        self, anchor_time: datetime, *, data_mode: str
    ) -> tuple[list[dict[str, Any]], ProviderHealth]:
        from .calendar_events import load_calendar_events_in_window

        items = load_calendar_events_in_window(
            calendar_dir=self.csv_calendar_dir,
            anchor_time=anchor_time,
            lookback_minutes=60,
            forward_minutes=120,
        )
        rows = [
            {
                "scheduled_at": datetime.strptime(item.timestamp_myt, "%d-%m-%Y %H:%M")
                .replace(tzinfo=anchor_time.tzinfo)
                .isoformat(),
                "source": item.source,
                "title": item.title,
                "relevance_reason": item.relevance_reason,
                "impact_direction_on_gold": item.impact_direction_on_gold,
                "data_mode": data_mode,
            }
            for item in items
        ]
        return rows, build_provider_health(
            source="Calendar",
            source_type="local_csv_fallback",
            data_mode=data_mode if rows else "unavailable",
            is_available=bool(rows),
            is_stale=data_mode != "live_seen" and bool(rows),
            stale_reason="CSV fallback is debug/import only." if data_mode != "live_seen" and rows else "",
            current_value=float(len(rows)),
            data_timestamp=rows[-1]["scheduled_at"] if rows else anchor_time.isoformat(),
        )

    def _normalize_related_rows(
        self,
        key: str,
        rows: list[dict[str, Any]],
        health: ProviderHealth,
        *,
        data_mode_override: str | None = None,
    ) -> list[dict[str, Any]]:
        normalized: list[dict[str, Any]] = []
        for idx, row in enumerate(rows):
            normalized.append(
                {
                    "symbol": key,
                    "data_timestamp": row.get("data_timestamp", row.get("timestamp")),
                    "value": row.get("close"),
                    "change_15m": health.change_value if idx == len(rows) - 1 else None,
                    "change_30m": row.get("change_30m"),
                    "change_60m": row.get("change_60m"),
                    "change_value": health.change_value if idx == len(rows) - 1 else None,
                    "change_unit": health.change_unit or "percent",
                    "source": row.get("source"),
                    "source_type": health.source_type,
                    "data_mode": data_mode_override or health.data_mode,
                    "is_stale": health.is_stale if idx == len(rows) - 1 else False,
                    "stale_reason": health.stale_reason if idx == len(rows) - 1 else "",
                }
            )
        return normalized
