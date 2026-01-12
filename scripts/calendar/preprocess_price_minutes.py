"""Preprocess XAUUSD trade CSV into a continuous minute timeline (UTC+8).

Steps implemented:
- Remove the first 20 warm-up trades.
- Ensure rows are ordered by trade_id and bar_idx.
- Parse `entry_time` (format like "03012020 8:56 AM") and compute a
  per-row `timestamp` using `entry_time + (bar_idx - 1) minutes`.
- Write the result to CSV/Parquet with the new continuous `timestamp` column.

Usage
-----
python scripts/calendar/preprocess_price_minutes.py \
    --input data/XAUUSD_1m_data/SuperTrend.csv \
    --output data/features/SuperTrend_minutes.parquet
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Dict

import pandas as pd

DEFAULT_OUTPUT_PATH = Path("data/XAUUSD_1m_data/preprocessed_minutes.parquet")
DEFAULT_PREVIEW_PATH = Path("data/XAUUSD_1m_data/preprocessed_minutes_preview.csv")
DEFAULT_PREVIEW_TRADES = 1000

ENTRY_TIME_FORMATS: tuple[str, ...] = (
    "%d%m%Y %I:%M %p",
    "%d/%m/%Y %I:%M %p",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build minute timeline for XAUUSD trades"
    )
    parser.add_argument("--input", type=Path, required=True, help="Input CSV file path")
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT_PATH,
        help=(
            "Output file (csv or parquet). Default: data/XAUUSD_1m_data/preprocessed_minutes.parquet"
        ),
    )
    parser.add_argument(
        "--drop-trades",
        type=int,
        default=20,
        help="Number of warm-up trades to drop from the beginning (default: 20)",
    )
    return parser.parse_args()


def parse_entry_time(series: pd.Series) -> pd.Series:
    for fmt in ENTRY_TIME_FORMATS:
        try:
            return pd.to_datetime(series, format=fmt)
        except ValueError:
            continue
    raise ValueError("entry_time column does not match expected formats")


def remove_warmup(df: pd.DataFrame, count: int) -> pd.DataFrame:
    if count <= 0:
        return df
    trade_ids = df["trade_id"].drop_duplicates().to_list()
    drop_ids = trade_ids[:count]
    return df[~df["trade_id"].isin(drop_ids)].copy()


def build_timestamp_column(df: pd.DataFrame) -> pd.DataFrame:
    if "entry_time" not in df.columns or "bar_idx" not in df.columns:
        raise KeyError("input dataframe requires 'entry_time' and 'bar_idx' columns")

    df = df.copy()
    df.sort_values(["trade_id", "bar_idx"], inplace=True)

    starts = df[df["bar_idx"] == 1][["trade_id", "entry_time"]]
    parsed = parse_entry_time(starts["entry_time"])
    trade_start_map: Dict[int, pd.Timestamp] = dict(zip(starts["trade_id"], parsed))

    missing = [tid for tid, ts in trade_start_map.items() if pd.isna(ts)]
    if missing:
        raise ValueError(
            "Missing or unparsable entry_time for trades: "
            + ", ".join(map(str, missing[:5]))
            + ("..." if len(missing) > 5 else "")
        )

    base = df["trade_id"].map(trade_start_map)
    minute_offsets = pd.to_timedelta(df["bar_idx"].astype(int) - 1, unit="m")
    df["timestamp"] = base + minute_offsets
    return df


def write_preview(df: pd.DataFrame, output_path: Path, trades: int) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    ordered_ids = df["trade_id"].drop_duplicates()
    selected_ids = set(ordered_ids.iloc[:trades])
    preview = df[df["trade_id"].isin(selected_ids)].sort_values(["trade_id", "bar_idx"])
    preview.to_csv(output_path, index=False)


def write_output(df: pd.DataFrame, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_path.suffix.lower() == ".csv":
        df.to_csv(output_path, index=False)
    elif output_path.suffix.lower() in {".parquet", ".pq"}:
        df.to_parquet(output_path, index=False)
    else:
        raise ValueError(f"Unsupported output extension: {output_path.suffix}")


def main() -> None:
    args = parse_args()
    raw_df = pd.read_csv(args.input)
    processed = remove_warmup(raw_df, args.drop_trades)
    processed = build_timestamp_column(processed)

    write_preview(processed, DEFAULT_PREVIEW_PATH, DEFAULT_PREVIEW_TRADES)
    write_output(processed, args.output)


if __name__ == "__main__":
    main()
