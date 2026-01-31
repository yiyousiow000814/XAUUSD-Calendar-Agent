"""
Build XAUUSD price impact statistics for USD economic events.

This script is designed for local generation only:
- It reads a large CSV (ignored by git) with 1-minute XAUUSD bars in UTC.
- It reads the event history NDJSON (pulled calendar repo) and parses event points as UTC+8.
- It outputs a small JSON file that the desktop app can load and visualize.

Usage (PowerShell):
  python scripts/analysis/build_event_impact_usd.py ^
    --price-csv data/XAUUSD_data/XAUUSD_data.csv ^
    --event-ndjson user-data/data/event_history_index/event_history_by_event.ndjson ^
    --out user-data/analysis/xauusd_event_impact_usd.json
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
from bisect import bisect_left
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


WINDOWS_MINUTES: List[int] = [
    -12 * 60,
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
    12 * 60,
]

BUCKET_GT = "ap_gt_prev"
BUCKET_LT = "ap_lt_prev"
BUCKET_EQ = "ap_eq_prev"


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
    try:
        dt = datetime.strptime(f"{date_text} {time_text}", "%d-%m-%Y %H:%M")
    except ValueError:
        return None
    utc8 = timezone(timedelta(hours=8))
    return dt.replace(tzinfo=utc8)


_NUM_SUFFIX_RE = re.compile(r"^([+-]?\d+(?:\.\d+)?)([kmb])?$", re.IGNORECASE)


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
    return base


def classify_bucket(actual: str, previous: str, eq_eps: float = 0.0) -> Optional[str]:
    a = parse_number(actual)
    p = parse_number(previous)
    if a is None or p is None:
        return None
    if eq_eps > 0 and abs(a - p) <= eq_eps:
        return BUCKET_EQ
    if a > p:
        return BUCKET_GT
    if a < p:
        return BUCKET_LT
    return BUCKET_EQ


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

        def percentile(q: float) -> float:
            # q in [0,1]
            if n == 1:
                return sorted_vals[0]
            pos = q * (n - 1)
            lo = int(math.floor(pos))
            hi = int(math.ceil(pos))
            if lo == hi:
                return sorted_vals[lo]
            w = pos - lo
            return sorted_vals[lo] * (1 - w) + sorted_vals[hi] * w

        p10 = percentile(0.10)
        p50 = percentile(0.50)
        p90 = percentile(0.90)
        p_up = self.up / n
        p_down = self.down / n

        best_direction = "up" if p_up >= p_down else "down"
        best_p = p_up if best_direction == "up" else p_down

        # Median pct among samples in the best direction.
        if best_direction == "up":
            dir_vals = [v for v in sorted_vals if v > 0]
        else:
            dir_vals = [v for v in sorted_vals if v < 0]
        if not dir_vals:
            best_median = 0.0
        else:
            mid = len(dir_vals) // 2
            best_median = dir_vals[mid] if len(dir_vals) % 2 == 1 else (dir_vals[mid - 1] + dir_vals[mid]) / 2

        return {
            "n": n,
            "p_up": p_up,
            "p_down": p_down,
            "p10": p10,
            "p50": p50,
            "p90": p90,
            "best_direction": best_direction,
            "best_p": best_p,
            "best_median_pct": best_median,
        }


def load_price_series(price_csv: Path) -> Tuple[List[int], List[float]]:
    minutes: List[int] = []
    mids: List[float] = []
    with price_csv.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        required = {"bar_open_time_utc", "open", "high", "low", "close"}
        missing = required - set(reader.fieldnames or [])
        if missing:
            raise SystemExit(f"Missing columns in price CSV: {sorted(missing)}")
        for row in reader:
            dt = parse_price_dt_utc(row["bar_open_time_utc"])
            minute = int(dt.timestamp() // 60)
            o = float(row["open"])
            h = float(row["high"])
            l = float(row["low"])
            c = float(row["close"])
            mid = (o + h + l + c) / 4.0
            minutes.append(minute)
            mids.append(mid)
    return minutes, mids


def find_minute_index(minutes: List[int], minute: int) -> Optional[int]:
    i = bisect_left(minutes, minute)
    if i >= len(minutes):
        return None
    if minutes[i] < minute:
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
    p.add_argument("--out", required=True)
    p.add_argument("--eq-eps", type=float, default=0.0)
    args = p.parse_args()

    price_csv = Path(args.price_csv)
    event_ndjson = Path(args.event_ndjson)
    out_path = Path(args.out)

    if not price_csv.exists():
        raise SystemExit(f"Missing price CSV: {price_csv}")
    if not event_ndjson.exists():
        raise SystemExit(f"Missing event NDJSON: {event_ndjson}")

    minutes, mids = load_price_series(price_csv)
    if not minutes:
        raise SystemExit("Empty price series")

    result: Dict[str, Any] = {
        "schema": 1,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "windows_minutes": WINDOWS_MINUTES,
        "events": {},
    }

    # events[eventId][bucket][offset] = WindowStats
    events: Dict[str, Dict[str, Dict[int, WindowStats]]] = {}

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
            previous = str(row[4] or "")

            dt_source = parse_event_dt_source_utc8(date_text, time_text)
            if dt_source is None:
                continue
            bucket = classify_bucket(actual, previous, eq_eps=args.eq_eps)
            if bucket is None:
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

            by_bucket = events.setdefault(event_id, {}).setdefault(bucket, {})
            for offset in WINDOWS_MINUTES:
                target_minute = t0_minute + offset
                j = find_exact_minute_index(minutes, target_minute)
                if j is None:
                    continue
                pct = (mids[j] - t0_mid) / t0_mid * 100.0
                stats = by_bucket.get(offset)
                if stats is None:
                    stats = WindowStats(values=[])
                    by_bucket[offset] = stats
                stats.add(pct)

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

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()

