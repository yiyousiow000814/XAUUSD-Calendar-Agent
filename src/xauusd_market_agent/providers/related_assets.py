from __future__ import annotations

import csv
from datetime import datetime, timedelta
import json
from pathlib import Path
from urllib.request import urlopen

from ..models import CrossAssetSnapshot


def load_related_assets_snapshot(path: Path | None) -> CrossAssetSnapshot:
    if path is None or not path.exists():
        return CrossAssetSnapshot(
            dxy_percent=0.0,
            us10y_bps=0.0,
            us2y_bps=0.0,
            wti_percent=0.0,
            brent_percent=0.0,
            vix_percent=0.0,
            spx_percent=0.0,
            nasdaq_percent=0.0,
        )

    payload = json.loads(path.read_text(encoding="utf-8"))
    return CrossAssetSnapshot.from_dict(payload)


def _parse_series_dt(raw: str) -> datetime:
    return datetime.fromisoformat(raw)


def _load_series_change(path: Path, anchor_time: datetime, window_minutes: int, *, as_bps: bool) -> float:
    rows: list[tuple[datetime, float]] = []
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            timestamp = _parse_series_dt(row["timestamp"])
            if timestamp <= anchor_time:
                rows.append((timestamp, float(row["close"])))
    if len(rows) < 2:
        return 0.0
    rows.sort(key=lambda item: item[0])
    end_ts, end_value = rows[-1]
    window_start = end_ts - timedelta(minutes=window_minutes)
    start_value = rows[0][1]
    for timestamp, value in rows:
        if timestamp >= window_start:
            start_value = value
            break
    if as_bps:
        return (end_value - start_value) * 100.0
    if start_value == 0:
        return 0.0
    return ((end_value - start_value) / start_value) * 100.0


def load_related_assets_timeseries_snapshot(
    assets_dir: Path | None,
    anchor_time: datetime,
    window_minutes: int,
) -> CrossAssetSnapshot:
    if assets_dir is None or not assets_dir.exists():
        return load_related_assets_snapshot(None)
    mapping = {
        "dxy_percent": ("dxy.csv", False),
        "us10y_bps": ("us10y.csv", True),
        "us2y_bps": ("us2y.csv", True),
        "wti_percent": ("wti.csv", False),
        "brent_percent": ("brent.csv", False),
        "vix_percent": ("vix.csv", False),
        "spx_percent": ("spx.csv", False),
        "nasdaq_percent": ("nasdaq.csv", False),
    }
    values: dict[str, float] = {}
    for key, (filename, as_bps) in mapping.items():
        path = assets_dir / filename
        values[key] = _load_series_change(path, anchor_time, window_minutes, as_bps=as_bps) if path.exists() else 0.0
    return CrossAssetSnapshot.from_dict(values)


def refresh_related_assets_cache(
    sources_path: Path,
    target_dir: Path,
) -> list[str]:
    source_map = json.loads(Path(sources_path).read_text(encoding="utf-8"))
    target_dir.mkdir(parents=True, exist_ok=True)
    refreshed: list[str] = []
    for asset_name, source in source_map.items():
        source_text = str(source).strip()
        if not source_text:
            continue
        target_path = target_dir / f"{asset_name}.csv"
        if source_text.startswith("http://") or source_text.startswith("https://"):
            with urlopen(source_text, timeout=15) as response:
                content = response.read().decode("utf-8", errors="replace")
        else:
            content = Path(source_text).read_text(encoding="utf-8")
        target_path.write_text(content, encoding="utf-8")
        refreshed.append(str(asset_name))
    return refreshed
