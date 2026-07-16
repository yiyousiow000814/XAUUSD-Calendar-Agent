from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import re
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any
from urllib.request import Request, urlopen

from ..models import ProviderHealth
from ..provider_health import build_provider_health


_US2Y_URL = "https://tradingeconomics.com/united-states/2-year-note-yield"
_USER_AGENT = "Mozilla/5.0 (compatible; XAUUSD-Calendar-Agent/1.0)"
_STALE_AFTER_SECONDS = 1800
_CACHE_RETENTION = timedelta(days=7)


def _parse_te_last_update(raw: str, target_tz: timezone | None) -> datetime:
    parsed = datetime.strptime(raw, "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
    return parsed.astimezone(target_tz or timezone.utc)


def _extract_quote(
    html: str,
    target_tz: timezone | None,
    *,
    expected_ticker: str,
    label: str,
) -> tuple[float, datetime, dict[str, Any]]:
    update_match = re.search(r"TELastUpdate\s*=\s*'(\d{12})'", html)
    meta_match = re.search(r"TEChartsMeta\s*=\s*(\[.*?\]);", html, re.DOTALL)
    if update_match is None or meta_match is None:
        raise ValueError(f"Trading Economics {label} quote metadata was not found.")

    meta = json.loads(meta_match.group(1))
    if not isinstance(meta, list) or not meta:
        raise ValueError(f"Trading Economics {label} quote metadata is empty.")
    expected = expected_ticker.upper()
    item = next(
        (
            candidate
            for candidate in meta
            if isinstance(candidate, dict)
            and str(candidate.get("ticker") or candidate.get("symbol") or "").upper() == expected
        ),
        meta[0],
    )
    value = item.get("last", item.get("value"))
    if value is None:
        raise ValueError(f"Trading Economics {label} quote value was not found.")
    timestamp = _parse_te_last_update(update_match.group(1), target_tz)
    return float(value), timestamp, item if isinstance(item, dict) else {}


def _read_cache(cache_path: Path) -> list[dict[str, Any]]:
    if not cache_path.exists():
        return []
    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    rows = payload.get("rows") if isinstance(payload, dict) else payload
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def _write_cache(cache_path: Path, rows: list[dict[str, Any]]) -> None:
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile("w", encoding="utf-8", dir=cache_path.parent, delete=False) as handle:
        json.dump({"rows": rows}, handle, ensure_ascii=True, indent=2)
        temp_path = Path(handle.name)
    temp_path.replace(cache_path)


def _parse_cached_timestamp(row: dict[str, Any]) -> datetime | None:
    try:
        return datetime.fromisoformat(str(row.get("timestamp") or ""))
    except ValueError:
        return None


def _merge_cache(rows: list[dict[str, Any]], timestamp: datetime, value: float) -> list[dict[str, Any]]:
    cutoff = timestamp - _CACHE_RETENTION
    merged: dict[str, dict[str, Any]] = {}
    for row in rows:
        parsed = _parse_cached_timestamp(row)
        if parsed is None or parsed < cutoff:
            continue
        merged[parsed.isoformat()] = {"timestamp": parsed.isoformat(), "value": float(row.get("value", 0.0))}
    merged[timestamp.isoformat()] = {"timestamp": timestamp.isoformat(), "value": value}
    return [merged[key] for key in sorted(merged)]


def _change_bps(rows: list[dict[str, Any]], latest: dict[str, Any], window_minutes: int) -> float:
    latest_ts = _parse_cached_timestamp(latest)
    if latest_ts is None:
        return 0.0
    latest_value = float(latest["value"])
    start = latest_ts - timedelta(minutes=window_minutes)
    base = rows[0]
    for row in rows:
        parsed = _parse_cached_timestamp(row)
        if parsed is not None and parsed >= start:
            base = row
            break
    return (latest_value - float(base["value"])) * 100.0


def _change_percent(rows: list[dict[str, Any]], latest: dict[str, Any], window_minutes: int) -> float:
    latest_ts = _parse_cached_timestamp(latest)
    if latest_ts is None:
        return 0.0
    latest_value = float(latest["value"])
    start = latest_ts - timedelta(minutes=window_minutes)
    base = rows[0]
    for row in rows:
        parsed = _parse_cached_timestamp(row)
        if parsed is not None and parsed >= start:
            base = row
            break
    base_value = float(base["value"])
    if base_value == 0:
        return 0.0
    return ((latest_value - base_value) / base_value) * 100.0


TRADING_ECONOMICS_QUOTES: dict[str, dict[str, str]] = {
    "us10y": {
        "url": "https://tradingeconomics.com/united-states/government-bond-yield",
        "ticker": "USGG10YR:IND",
        "label": "US10Y",
        "unit": "bps",
    },
    "us2y": {
        "url": _US2Y_URL,
        "ticker": "USGG2YR:IND",
        "label": "US2Y",
        "unit": "bps",
    },
    "vix": {
        "url": "https://tradingeconomics.com/vix:ind",
        "ticker": "VIX:IND",
        "label": "VIX",
        "unit": "percent",
    },
    "spx": {
        "url": "https://tradingeconomics.com/spx:ind",
        "ticker": "SPX:IND",
        "label": "S&P 500",
        "unit": "percent",
    },
    "nasdaq": {
        "url": "https://tradingeconomics.com/ccmp:ind",
        "ticker": "CCMP:IND",
        "label": "Nasdaq",
        "unit": "percent",
    },
}


class TradingEconomicsQuoteProvider:
    def __init__(
        self,
        *,
        symbol: str,
        cache_path: Path,
        session: Any | None = None,
        enabled: bool = True,
    ) -> None:
        if symbol not in TRADING_ECONOMICS_QUOTES:
            raise ValueError(f"Unsupported Trading Economics quote symbol: {symbol}")
        self.symbol = symbol
        self.spec = TRADING_ECONOMICS_QUOTES[symbol]
        self.cache_path = cache_path
        self.session = session
        self.enabled = enabled

    def _read_html(self) -> str:
        if not self.enabled:
            raise RuntimeError(f"Trading Economics {self.spec['label']} provider is disabled.")
        if self.session is not None:
            response = self.session.get(self.spec["url"], timeout=20)
            response.raise_for_status()
            return str(response.text)
        request = Request(self.spec["url"], headers={"User-Agent": _USER_AGENT})
        with urlopen(request, timeout=20) as response:
            return response.read().decode("utf-8", errors="replace")

    def fetch_latest(self, anchor_time: datetime) -> tuple[list[dict[str, Any]], ProviderHealth]:
        target_tz = anchor_time.tzinfo if anchor_time.tzinfo is not None else timezone.utc
        label = self.spec["label"]
        try:
            html = self._read_html()
            value, quote_timestamp, metadata = _extract_quote(
                html,
                target_tz,
                expected_ticker=self.spec["ticker"],
                label=label,
            )
            rows = _merge_cache(_read_cache(self.cache_path), quote_timestamp, value)
            _write_cache(self.cache_path, rows)
        except Exception as exc:  # noqa: BLE001
            return [], build_provider_health(
                source=f"Trading Economics {label}",
                source_type="yield_quote" if self.spec["unit"] == "bps" else "index_quote",
                data_mode="unavailable",
                is_available=False,
                stale_reason=f"Trading Economics {label} quote unavailable.",
                error=str(exc),
                raw_source_id=self.spec["ticker"],
                data_timestamp=anchor_time.isoformat(),
            )

        latest = rows[-1]
        age_seconds = (anchor_time - quote_timestamp).total_seconds()
        is_stale = age_seconds > _STALE_AFTER_SECONDS
        stale_reason = f"Trading Economics {label} quote is older than freshness threshold." if is_stale else ""
        if self.spec["unit"] == "bps":
            change_15m = _change_bps(rows, latest, 15)
            change_30m = _change_bps(rows, latest, 30)
            change_60m = _change_bps(rows, latest, 60)
            source_type = "yield_quote"
            change_unit = "bps"
        else:
            change_15m = _change_percent(rows, latest, 15)
            change_30m = _change_percent(rows, latest, 30)
            change_60m = _change_percent(rows, latest, 60)
            source_type = "index_quote"
            change_unit = "percent"
        row = {
            "symbol": self.symbol,
            "data_timestamp": quote_timestamp.isoformat(),
            "value": value,
            "close": value,
            "change_15m": change_15m,
            "change_30m": change_30m,
            "change_60m": change_60m,
            "change_value": change_15m,
            "change_unit": change_unit,
            "source": "Trading Economics",
            "source_type": source_type,
            "data_mode": "live_seen",
            "is_stale": is_stale,
            "stale_reason": stale_reason,
        }
        return [row], build_provider_health(
            source=f"Trading Economics {label}",
            source_type=source_type,
            data_mode="live_seen",
            is_available=True,
            is_stale=is_stale,
            stale_reason=stale_reason,
            raw_source_id=str(metadata.get("ticker") or self.spec["ticker"]),
            current_value=value,
            change_value=change_15m,
            change_unit=change_unit,
            data_timestamp=quote_timestamp.isoformat(),
            metadata={"url": self.spec["url"], "cache_path": str(self.cache_path), "history_points": len(rows)},
        )


class TradingEconomicsUS2YProvider:
    def __init__(
        self,
        *,
        cache_path: Path,
        url: str = _US2Y_URL,
        session: Any | None = None,
        enabled: bool = True,
    ) -> None:
        self.cache_path = cache_path
        self.url = url
        self.session = session
        self.enabled = enabled

    def _read_html(self) -> str:
        if not self.enabled:
            raise RuntimeError("Trading Economics US2Y provider is disabled.")
        if self.session is not None:
            response = self.session.get(self.url, timeout=20)
            response.raise_for_status()
            return str(response.text)
        request = Request(self.url, headers={"User-Agent": _USER_AGENT})
        with urlopen(request, timeout=20) as response:
            return response.read().decode("utf-8", errors="replace")

    def fetch_latest(self, anchor_time: datetime) -> tuple[list[dict[str, Any]], ProviderHealth]:
        return TradingEconomicsQuoteProvider(
            symbol="us2y",
            cache_path=self.cache_path,
            session=self.session,
            enabled=self.enabled,
        ).fetch_latest(anchor_time)

    def backfill(self, start: datetime, end: datetime) -> tuple[list[dict[str, Any]], ProviderHealth]:
        return self.fetch_latest(end)
