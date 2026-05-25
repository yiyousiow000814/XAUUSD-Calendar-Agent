from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from ..models import ProviderHealth
from .base import MarketBar, RelatedAssetBar


_SYMBOL_SOURCE_TYPE = {
    "GC=F": "futures_proxy",
    "DX-Y.NYB": "proxy",
    "^TNX": "proxy",
    "CL=F": "proxy",
    "BZ=F": "proxy",
    "^VIX": "proxy",
    "^GSPC": "proxy",
    "^IXIC": "proxy",
    "NQ=F": "proxy",
}
_HTTP_USER_AGENT = "Mozilla/5.0 (compatible; XAUUSD-Calendar-Agent/1.0)"


def _parse_dt(raw: str) -> datetime:
    return datetime.fromisoformat(raw.replace("Z", "+00:00"))


def _to_iso(dt: datetime, target_tz: timezone | None) -> str:
    if target_tz is None:
        return dt.astimezone(timezone.utc).isoformat()
    return dt.astimezone(target_tz).isoformat()


def _load_fixture_payload(fixture_path: Path) -> dict[str, Any]:
    return json.loads(fixture_path.read_text(encoding="utf-8"))


def _extract_chart_rows(
    payload: dict[str, Any],
    symbol: str,
    source: str,
    *,
    target_tz: timezone | None,
) -> list[MarketBar]:
    chart = payload["chart"]["result"][0]
    timestamps = chart.get("timestamp", [])
    quote = chart["indicators"]["quote"][0]
    opens = quote.get("open", [])
    highs = quote.get("high", [])
    lows = quote.get("low", [])
    closes = quote.get("close", [])
    rows: list[MarketBar] = []
    for idx, ts in enumerate(timestamps):
        if idx >= len(closes) or closes[idx] is None:
            continue
        timestamp = datetime.fromtimestamp(int(ts), tz=timezone.utc)
        rows.append(
            MarketBar(
                timestamp=_to_iso(timestamp, target_tz),
                symbol=symbol,
                open=float(opens[idx] if idx < len(opens) and opens[idx] is not None else closes[idx]),
                high=float(highs[idx] if idx < len(highs) and highs[idx] is not None else closes[idx]),
                low=float(lows[idx] if idx < len(lows) and lows[idx] is not None else closes[idx]),
                close=float(closes[idx]),
                source=source,
                source_type=_SYMBOL_SOURCE_TYPE.get(symbol, "proxy"),
                data_mode="proxy" if symbol == "GC=F" else "live_seen",
            )
        )
    return rows


def _series_changes(rows: list[MarketBar], latest_index: int) -> tuple[float, float, float]:
    if latest_index < 0 or latest_index >= len(rows):
        return 0.0, 0.0, 0.0

    latest = rows[latest_index]
    latest_dt = _parse_dt(latest.timestamp)

    def _change(window_minutes: int, as_bps: bool = False) -> float:
        start = latest_dt - timedelta(minutes=window_minutes)
        base = None
        for row in rows:
            row_dt = _parse_dt(row.timestamp)
            if row_dt <= latest_dt and row_dt >= start:
                base = row
                break
        if base is None:
            base = rows[0]
        if as_bps:
            return (latest.close - base.close) * 100.0
        if base.close == 0:
            return 0.0
        return ((latest.close - base.close) / base.close) * 100.0

    return _change(15), _change(30), _change(60)


class YahooChartProvider:
    def __init__(
        self,
        *,
        fixture_dir: Path | None = None,
        base_url: str = "https://query1.finance.yahoo.com/v8/finance/chart",
        session: Any | None = None,
        enabled: bool = True,
    ) -> None:
        self.fixture_dir = Path(fixture_dir) if fixture_dir is not None else None
        self.base_url = base_url.rstrip("/")
        self.session = session
        self.enabled = enabled

    def _read_payload(self, symbol: str, start: datetime, end: datetime, interval: str) -> dict[str, Any] | None:
        if not self.enabled:
            return None
        if self.fixture_dir is not None:
            fixture_path = self.fixture_dir / f"{symbol.replace('^', '_')}_{interval}.json"
            if fixture_path.exists():
                return _load_fixture_payload(fixture_path)
        params = urlencode(
            {
                "period1": int(start.timestamp()),
                "period2": int(end.timestamp()),
                "interval": interval,
                "includePrePost": "false",
                "events": "div,splits",
            }
        )
        url = f"{self.base_url}/{symbol}?{params}"
        try:
            if self.session is not None:
                response = self.session.get(url, timeout=15)
                response.raise_for_status()
                return response.json()
            request = Request(url, headers={"User-Agent": _HTTP_USER_AGENT})
            with urlopen(request, timeout=15) as response:
                return json.loads(response.read().decode("utf-8", errors="replace"))
        except Exception:
            return None

    def fetch_series(
        self,
        symbol: str,
        start: datetime,
        end: datetime,
        *,
        interval: str = "5m",
    ) -> tuple[list[MarketBar], ProviderHealth]:
        payload = self._read_payload(symbol, start, end, interval)
        now = end.astimezone()
        if payload is None:
            return [], ProviderHealth(
                source=symbol,
                source_type=_SYMBOL_SOURCE_TYPE.get(symbol, "proxy"),
                fetched_at=now.isoformat(),
                data_timestamp=now.isoformat(),
                data_mode="unavailable",
                is_available=False,
                is_stale=False,
                stale_reason="Yahoo chart payload unavailable.",
                error="Yahoo chart payload unavailable.",
            )
        target_tz = end.tzinfo if isinstance(end.tzinfo, timezone) or end.tzinfo is not None else timezone.utc
        rows = _extract_chart_rows(payload, symbol, "Yahoo Finance", target_tz=target_tz)
        if not rows:
            return [], ProviderHealth(
                source=symbol,
                source_type=_SYMBOL_SOURCE_TYPE.get(symbol, "proxy"),
                fetched_at=now.isoformat(),
                data_timestamp=now.isoformat(),
                data_mode="unavailable",
                is_available=False,
                is_stale=False,
                stale_reason="Yahoo chart payload returned no rows.",
                error="No chart rows.",
            )
        latest = rows[-1]
        latest_dt = _parse_dt(latest.timestamp)
        stale = (now - latest_dt).total_seconds() > (600 if symbol != "GC=F" else 120)
        change_15m, change_30m, change_60m = _series_changes(rows, len(rows) - 1)
        latest = MarketBar(
            **{
                **latest.__dict__,
                "is_stale": stale,
                "stale_reason": "Latest chart point is older than freshness threshold." if stale else "",
            }
        )
        rows[-1] = latest
        health = ProviderHealth(
            source=symbol,
            source_type=_SYMBOL_SOURCE_TYPE.get(symbol, "proxy"),
            fetched_at=now.isoformat(),
            data_timestamp=latest.timestamp,
            data_mode="proxy" if symbol == "GC=F" else "live_seen",
            is_available=True,
            is_stale=stale,
            stale_reason="Latest chart point is older than freshness threshold." if stale else "",
            raw_source_id=symbol,
            current_value=latest.close,
            previous_value=rows[-2].close if len(rows) > 1 else latest.close,
            change_value=change_15m,
            change_unit="percent",
        )
        result_rows: list[dict[str, Any]] = []
        for idx, row in enumerate(rows):
            row_payload = dict(row.__dict__)
            if idx == len(rows) - 1:
                row_payload["change_15m"] = change_15m
                row_payload["change_30m"] = change_30m
                row_payload["change_60m"] = change_60m
            result_rows.append(row_payload)
        return result_rows, health

    def fetch_market_price(self, anchor_time: datetime) -> tuple[list[dict[str, Any]], ProviderHealth]:
        return self.fetch_series("GC=F", anchor_time - timedelta(hours=6), anchor_time, interval="5m")

    def fetch_related_asset(self, symbol: str, anchor_time: datetime) -> tuple[list[dict[str, Any]], ProviderHealth]:
        return self.fetch_series(symbol, anchor_time - timedelta(hours=6), anchor_time, interval="5m")

    def backfill(self, symbol: str, start: datetime, end: datetime, interval: str = "5m") -> tuple[list[dict[str, Any]], ProviderHealth]:
        return self.fetch_series(symbol, start, end, interval=interval)
