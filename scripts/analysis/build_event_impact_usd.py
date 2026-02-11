"""
Build XAUUSD price impact statistics for USD economic events.

This script is designed for local generation only:
- It reads a large CSV (ignored by git) with 1-minute XAUUSD bars in UTC.
- It reads the event history NDJSON (pulled calendar repo) and parses event points as UTC+8.
- It outputs a small JSON file that the desktop app can load and visualize.

Usage (PowerShell):
  python scripts/analysis/build_event_impact_usd.py ^
    --price-csv data/XAUUSD_data/XAUUSD_data.csv ^
    --event-ndjson user-data/data/event_history_index/event_history_by_event.ndjson

By default, output is written to:
  %APPDATA%\\XAUUSDCalendar\\analysis\\xauusd_event_impact_usd.json

Override the output path with:
  --out <path>
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import re
from bisect import bisect_left
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


WINDOWS_MINUTES: List[int] = [
    -24 * 60,
    -12 * 60,
    -8 * 60,
    -4 * 60,
    -60,
    -30,
    -15,
    -5,
    -1,
    1,
    5,
    15,
    30,
    60,
    4 * 60,
    8 * 60,
    12 * 60,
    24 * 60,
]

BUCKET_GT = "ap_gt_prev"
BUCKET_LT = "ap_lt_prev"
BUCKET_EQ = "ap_eq_prev"

BUCKET_AF_GT = "af_gt_forecast"
BUCKET_AF_LT = "af_lt_forecast"
BUCKET_AF_EQ = "af_eq_forecast"


def parse_price_dt_utc(value: str) -> datetime:
    # bar_open_time_utc format: DD-MM-YYYY HH:MM:SS.mmm
    return datetime.strptime(value.strip(), "%d-%m-%Y %H:%M:%S.%f").replace(tzinfo=timezone.utc)


def parse_event_dt_source_utc8(date_ddmmyyyy: str, time_hhmm: str) -> Optional[datetime]:
    date_text = date_ddmmyyyy.strip()
    time_text = time_hhmm.strip()
    if not date_text or not time_text:
        return None
    if time_text.lower() == "all day":
        return None
    if ":" not in time_text:
        return None
    dt = None
    for fmt in ("%d-%m-%Y %H:%M", "%Y-%m-%d %H:%M"):
        try:
            dt = datetime.strptime(f"{date_text} {time_text}", fmt)
            break
        except ValueError:
            continue
    if dt is None:
        return None
    utc8 = timezone(timedelta(hours=8))
    return dt.replace(tzinfo=utc8)


_NUM_SUFFIX_RE = re.compile(r"^([+-]?\d+(?:\.\d+)?)([kmbt])?$", re.IGNORECASE)


def parse_number(raw: str) -> Optional[float]:
    text = (raw or "").strip()
    if not text:
        return None
    lowered = text.lower()
    if lowered in {"--", "—", "-", "tba", "n/a", "na", "null"}:
        return None
    cleaned = text.replace(",", "").replace("%", "").replace(" ", "")
    m = _NUM_SUFFIX_RE.match(cleaned)
    if not m:
        return None
    base = float(m.group(1))
    suf = (m.group(2) or "").lower()
    if suf == "k":
        return base * 1_000.0
    if suf == "m":
        return base * 1_000_000.0
    if suf == "b":
        return base * 1_000_000_000.0
    if suf == "t":
        return base * 1_000_000_000_000.0
    return base


def classify_bucket_cmp(
    actual: str,
    baseline: str,
    *,
    eq_eps: float = 0.0,
    bucket_gt: str,
    bucket_lt: str,
    bucket_eq: str,
) -> Optional[str]:
    a = parse_number(actual)
    b = parse_number(baseline)
    if a is None or b is None:
        return None
    if eq_eps > 0 and abs(a - b) <= eq_eps:
        return bucket_eq
    if a > b:
        return bucket_gt
    if a < b:
        return bucket_lt
    return bucket_eq


def classify_bucket_ap(actual: str, previous: str, eq_eps: float = 0.0) -> Optional[str]:
    return classify_bucket_cmp(
        actual,
        previous,
        eq_eps=eq_eps,
        bucket_gt=BUCKET_GT,
        bucket_lt=BUCKET_LT,
        bucket_eq=BUCKET_EQ,
    )


def classify_bucket_af(actual: str, forecast: str, eq_eps: float = 0.0) -> Optional[str]:
    return classify_bucket_cmp(
        actual,
        forecast,
        eq_eps=eq_eps,
        bucket_gt=BUCKET_AF_GT,
        bucket_lt=BUCKET_AF_LT,
        bucket_eq=BUCKET_AF_EQ,
    )


@dataclass
class WindowStats:
    values: List[float]
    up: int = 0
    down: int = 0

    def add(self, pct: float) -> None:
        self.values.append(pct)
        if pct > 0:
            self.up += 1
        elif pct < 0:
            self.down += 1

    def finalize(self) -> Dict[str, Any]:
        n = len(self.values)
        if n == 0:
            return {"n": 0}
        sorted_vals = sorted(self.values)

        def percentile(sorted_list: List[float], q: float) -> float:
            # q in [0,1]
            m = len(sorted_list)
            if m == 0:
                return 0.0
            if m == 1:
                return sorted_list[0]
            pos = q * (m - 1)
            lo = int(math.floor(pos))
            hi = int(math.ceil(pos))
            if lo == hi:
                return sorted_list[lo]
            w = pos - lo
            return sorted_list[lo] * (1 - w) + sorted_list[hi] * w

        # Percentiles of *all* samples (kept for debugging / future UI).
        p05_all = percentile(sorted_vals, 0.05)
        p10_all = percentile(sorted_vals, 0.10)
        p25_all = percentile(sorted_vals, 0.25)
        p50_all = percentile(sorted_vals, 0.50)
        p75_all = percentile(sorted_vals, 0.75)
        p90_all = percentile(sorted_vals, 0.90)
        p95_all = percentile(sorted_vals, 0.95)
        p_up = self.up / n
        p_down = self.down / n

        up_vals = [v for v in sorted_vals if v > 0]
        down_vals = [v for v in sorted_vals if v < 0]

        best_direction = "up" if p_up >= p_down else "down"
        best_p = p_up if best_direction == "up" else p_down

        # Percentiles among samples in the most likely direction.
        if best_direction == "up":
            dir_vals = up_vals
        else:
            dir_vals = down_vals

        p10 = percentile(dir_vals, 0.10)
        p50 = percentile(dir_vals, 0.50)
        p90 = percentile(dir_vals, 0.90)
        best_median = p50

        # Direction-conditional percentiles (used by UI to communicate risk/reward clearly).
        up_p10 = percentile(up_vals, 0.10) if up_vals else None
        up_p50 = percentile(up_vals, 0.50) if up_vals else None
        up_p90 = percentile(up_vals, 0.90) if up_vals else None
        down_p10 = percentile(down_vals, 0.10) if down_vals else None
        down_p50 = percentile(down_vals, 0.50) if down_vals else None
        down_p90 = percentile(down_vals, 0.90) if down_vals else None

        return {
            "n": n,
            "p_up": p_up,
            "p_down": p_down,
            "p10": p10,
            "p50": p50,
            "p90": p90,
            "p05_all": p05_all,
            "p10_all": p10_all,
            "p25_all": p25_all,
            "p50_all": p50_all,
            "p75_all": p75_all,
            "p90_all": p90_all,
            "p95_all": p95_all,
            "up_n": len(up_vals),
            "down_n": len(down_vals),
            "up_p10": up_p10,
            "up_p50": up_p50,
            "up_p90": up_p90,
            "down_p10": down_p10,
            "down_p50": down_p50,
            "down_p90": down_p90,
            "best_direction": best_direction,
            "best_p": best_p,
            "best_median_pct": best_median,
        }


def load_price_series(
    price_csv: Path,
) -> Tuple[List[int], List[float], Optional[datetime], Optional[datetime]]:
    minutes: List[int] = []
    mids: List[float] = []
    min_dt: Optional[datetime] = None
    max_dt: Optional[datetime] = None
    with price_csv.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        required = {"bar_open_time_utc", "open", "high", "low", "close"}
        missing = required - set(reader.fieldnames or [])
        if missing:
            raise SystemExit(f"Missing columns in price CSV: {sorted(missing)}")
        for row in reader:
            dt = parse_price_dt_utc(row["bar_open_time_utc"])
            if min_dt is None or dt < min_dt:
                min_dt = dt
            if max_dt is None or dt > max_dt:
                max_dt = dt
            minute = int(dt.timestamp() // 60)
            o = float(row["open"])
            h = float(row["high"])
            l = float(row["low"])
            c = float(row["close"])
            mid = (o + h + l + c) / 4.0
            minutes.append(minute)
            mids.append(mid)
    return minutes, mids, min_dt, max_dt


def find_minute_index(minutes: List[int], minute: int) -> Optional[int]:
    if not minutes:
        return None
    # If the event is earlier than the first available bar, we cannot align it reliably.
    if minute < minutes[0]:
        return None
    i = bisect_left(minutes, minute)
    if i >= len(minutes):
        return None
    return i


def find_exact_minute_index(minutes: List[int], minute: int) -> Optional[int]:
    i = bisect_left(minutes, minute)
    if i >= len(minutes) or minutes[i] != minute:
        return None
    return i


def iter_ndjson(path: Path) -> Iterable[Dict[str, Any]]:
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--price-csv", required=True)
    p.add_argument("--event-ndjson", required=True)
    p.add_argument("--out")
    p.add_argument("--eq-eps", type=float, default=0.0)
    args = p.parse_args()

    price_csv = Path(args.price_csv)
    event_ndjson = Path(args.event_ndjson)
    out_path: Path
    if args.out:
        out_path = Path(args.out)
    else:
        # Match the desktop app's default data directory behavior on Windows.
        # - Prefer an explicit override, if provided.
        # - Otherwise, default to the legacy roaming folder name used by the app.
        override_dir = (os.environ.get("XAUUSD_CALENDAR_AGENT_DATA_DIR") or "").strip()
        if override_dir:
            base = Path(override_dir)
        else:
            appdata = (os.environ.get("APPDATA") or "").strip()
            if appdata:
                base = Path(appdata) / "XAUUSDCalendar"
            else:
                # Fallback for non-Windows / unusual environments: use repo-local user-data.
                repo_root = Path(__file__).resolve().parents[2]
                base = repo_root / "user-data"
        out_path = base / "analysis" / "xauusd_event_impact_usd.json"

    if not price_csv.exists():
        raise SystemExit(f"Missing price CSV: {price_csv}")
    if not event_ndjson.exists():
        raise SystemExit(f"Missing event NDJSON: {event_ndjson}")

    minutes, mids, price_min_dt, price_max_dt = load_price_series(price_csv)
    if not minutes:
        raise SystemExit("Empty price series")

    result: Dict[str, Any] = {
        "schema": 1,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "windows_minutes": WINDOWS_MINUTES,
        "meta": {
            "price_min_utc": price_min_dt.isoformat() if price_min_dt else None,
            "price_max_utc": price_max_dt.isoformat() if price_max_dt else None,
            "event_source_tz": "UTC+08:00",
            "event_min_utc": None,
            "event_max_utc": None,
            "sample_points": 0,
        },
        "events": {},
    }

    # events[eventId][bucket][offset] = WindowStats
    events: Dict[str, Dict[str, Dict[int, WindowStats]]] = {}
    event_min_dt_utc: Optional[datetime] = None
    event_max_dt_utc: Optional[datetime] = None
    sample_points = 0

    for payload in iter_ndjson(event_ndjson):
        event_id = str(payload.get("eventId") or "")
        if not event_id.startswith("USD::"):
            continue
        points = payload.get("points")
        if not isinstance(points, list):
            continue
        for row in points:
            if not isinstance(row, list) or len(row) < 5:
                continue
            date_text = str(row[0] or "").strip()
            time_text = str(row[1] or "").strip()
            actual = str(row[2] or "")
            forecast = str(row[3] or "")
            previous = str(row[4] or "")

            dt_source = parse_event_dt_source_utc8(date_text, time_text)
            if dt_source is None:
                continue
            bucket_ap = classify_bucket_ap(actual, previous, eq_eps=args.eq_eps)
            bucket_af = classify_bucket_af(actual, forecast, eq_eps=args.eq_eps)
            if bucket_ap is None and bucket_af is None:
                continue

            dt_utc = dt_source.astimezone(timezone.utc)
            event_minute = int(dt_utc.timestamp() // 60)
            t0_index = find_minute_index(minutes, event_minute)
            if t0_index is None:
                continue
            t0_minute = minutes[t0_index]
            t0_mid = mids[t0_index]
            if not (t0_mid > 0):
                continue

            pct_by_offset: Dict[int, float] = {}
            for offset in WINDOWS_MINUTES:
                target_minute = t0_minute + offset
                j = find_exact_minute_index(minutes, target_minute)
                if j is None:
                    continue
                # Offsets are interpreted as "minutes relative to the event".
                # For positive offsets, pct is event -> future.
                #
                # For negative offsets, we want the intuitive "past -> event" move
                # (i.e., the price drift into the release), not "event -> past".
                #
                # We keep the event mid as the denominator for symmetry with the
                # positive side and just flip the sign for negative offsets.
                raw = (mids[j] - t0_mid) / t0_mid * 100.0
                pct = raw if offset >= 0 else -raw
                pct_by_offset[offset] = pct

            if not pct_by_offset:
                continue

            def add_bucket(bucket_key: str) -> None:
                by_bucket = events.setdefault(event_id, {}).setdefault(bucket_key, {})
                for offset, pct in pct_by_offset.items():
                    stats = by_bucket.get(offset)
                    if stats is None:
                        stats = WindowStats(values=[])
                        by_bucket[offset] = stats
                    stats.add(pct)

            if bucket_ap is not None:
                add_bucket(bucket_ap)
            if bucket_af is not None:
                add_bucket(bucket_af)

            sample_points += 1
            if event_min_dt_utc is None or dt_utc < event_min_dt_utc:
                event_min_dt_utc = dt_utc
            if event_max_dt_utc is None or dt_utc > event_max_dt_utc:
                event_max_dt_utc = dt_utc

    # Finalize
    out_events: Dict[str, Any] = {}
    for event_id, buckets in events.items():
        out_buckets: Dict[str, Any] = {}
        for bucket, offsets in buckets.items():
            out_offsets: Dict[str, Any] = {}
            for offset, stats in offsets.items():
                out_offsets[str(offset)] = stats.finalize()
            out_buckets[bucket] = out_offsets
        out_events[event_id] = out_buckets
    result["events"] = out_events
    result["meta"]["event_min_utc"] = event_min_dt_utc.isoformat() if event_min_dt_utc else None
    result["meta"]["event_max_utc"] = event_max_dt_utc.isoformat() if event_max_dt_utc else None
    result["meta"]["sample_points"] = sample_points

    out_path.parent.mkdir(parents=True, exist_ok=True)
    # Force LF so Windows checkouts don't flip the entire JSON to CRLF and create noisy diffs.
    text = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    with out_path.open("w", encoding="utf-8", newline="\n") as f:
        f.write(text)


if __name__ == "__main__":
    main()
