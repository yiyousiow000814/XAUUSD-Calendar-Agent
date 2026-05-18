from __future__ import annotations

import csv
from collections import deque
from datetime import datetime, timedelta
from pathlib import Path

from ..models import CrossAssetSnapshot, MarketMove, ScenarioFixture

TAIL_LINE_COUNT = 4096


def _parse_dt(raw: str) -> datetime:
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return datetime.strptime(raw, "%d-%m-%Y %H:%M:%S.%f").replace(
            tzinfo=datetime.fromisoformat("2026-01-01T00:00:00+00:00").tzinfo
        )


def _row_timestamp(row: dict[str, str]) -> datetime:
    if row.get("timestamp"):
        return _parse_dt(row["timestamp"])
    if row.get("dataset_time_local"):
        parsed = datetime.strptime(row["dataset_time_local"], "%d-%m-%Y %H:%M:%S.%f")
        return parsed.replace(tzinfo=datetime.fromisoformat("2026-01-01T00:00:00+08:00").tzinfo)
    if row.get("bar_close_time_utc"):
        parsed = datetime.strptime(row["bar_close_time_utc"], "%d-%m-%Y %H:%M:%S.%f")
        return parsed.replace(tzinfo=datetime.fromisoformat("2026-01-01T00:00:00+00:00").tzinfo).astimezone(
            datetime.fromisoformat("2026-01-01T00:00:00+08:00").tzinfo
        )
    if row.get("bar_open_time_utc"):
        parsed = datetime.strptime(row["bar_open_time_utc"], "%d-%m-%Y %H:%M:%S.%f")
        return parsed.replace(tzinfo=datetime.fromisoformat("2026-01-01T00:00:00+00:00").tzinfo).astimezone(
            datetime.fromisoformat("2026-01-01T00:00:00+08:00").tzinfo
        )
    raise ValueError("Price row is missing a recognized timestamp column.")


def _read_recent_rows(price_path: Path, tail_line_count: int = TAIL_LINE_COUNT) -> deque[dict[str, str]]:
    rows: deque[dict[str, str]] = deque(maxlen=max(32, tail_line_count))
    with price_path.open("r", encoding="utf-8", newline="") as handle:
        header_line = handle.readline().strip()
    if not header_line:
        return rows
    with price_path.open("rb") as handle:
        handle.seek(0, 2)
        position = handle.tell()
        buffer = bytearray()
        newline_count = 0
        while position > 0 and newline_count <= tail_line_count:
            step = min(65536, position)
            position -= step
            handle.seek(position)
            chunk = handle.read(step)
            buffer[:0] = chunk
            newline_count = buffer.count(b"\n")
        text = buffer.decode("utf-8", errors="replace")
    lines = [line for line in text.splitlines() if line.strip()]
    if lines and lines[0] == header_line:
        data_lines = lines[1:]
    else:
        data_lines = lines
    if not lines:
        return rows
    reader = csv.DictReader([header_line, *data_lines])
    for row in reader:
        rows.append(row)
    return rows


def load_recent_market_snapshot(price_path: Path, anchor_time: datetime) -> ScenarioFixture:
    rows = _read_recent_rows(price_path)

    parsed = []
    for row in rows:
        ts = _row_timestamp(row)
        if ts <= anchor_time:
            parsed.append((ts, row))
    if len(parsed) < 2:
        raise ValueError("Not enough price rows before anchor_time to build market snapshot.")

    parsed.sort(key=lambda item: item[0])
    end_ts, end_row = parsed[-1]
    window_start = end_ts - timedelta(minutes=15)
    start_candidate = parsed[0]
    for item in parsed:
        if item[0] >= window_start:
            start_candidate = item
            break
    start_ts, start_row = start_candidate

    start_close = float(start_row["close"])
    end_close = float(end_row["close"])
    move_percent = ((end_close - start_close) / start_close) * 100 if start_close else 0.0

    market = MarketMove(
        symbol="XAUUSD",
        from_price=start_close,
        to_price=end_close,
        move_percent=round(move_percent, 2),
        move_percent_15m=round(move_percent, 2),
        move_percent_1h=round(move_percent, 2),
        window_minutes=max(1, int((end_ts - start_ts).total_seconds() // 60)),
        breaks=(),
    )
    return ScenarioFixture(
        scenario_id="live_market_snapshot",
        as_of_myt=end_ts.strftime("%d-%m-%Y %H:%M"),
        market=market,
        cross_asset=CrossAssetSnapshot(
            dxy_percent=0.0,
            us10y_bps=0.0,
            us2y_bps=0.0,
            wti_percent=0.0,
            brent_percent=0.0,
            vix_percent=0.0,
            spx_percent=0.0,
            nasdaq_percent=0.0,
        ),
        calendar_events=(),
        news=(),
        expected_llm_claim=None,
    )
