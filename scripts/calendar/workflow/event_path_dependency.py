"""Stage B path dependency: evaluate surprise streak momentum vs fatigue."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import pandas as pd

from .event_component_decomposition import (
    _categorise_core,
    _extract_frequency,
    _normalise_base_indicator,
)
from .event_price_deepdive import SURPRISE_NEAR_ZERO_PCT

BASE_OUTPUT_DIR = Path("data/calendar_outputs/path_dependency")
DETAIL_COLUMNS = [
    "event_id",
    "event_time",
    "event_name",
    "currency",
    "importance",
    "base_indicator",
    "frequency_tag",
    "core_category",
    "surprise_pct",
    "surprise_direction",
    "return_post_60_pct",
    "return_post_240_pct",
    "streak_state",
    "streak_direction",
    "streak_length",
    "streak_bucket",
    "prev_event_time",
    "prev_surprise_direction",
    "prev_surprise_pct",
    "prev_return_post_60_pct",
    "prev_return_post_240_pct",
    "prev_streak_length",
]
SUMMARY_COLUMNS = [
    "currency",
    "base_indicator",
    "frequency_tag",
    "core_category",
    "streak_state",
    "streak_direction",
    "streak_bucket",
    "sample_size",
    "avg_surprise_pct",
    "avg_return_post_60_pct",
    "avg_return_post_240_pct",
    "avg_prev_return_post_60_pct",
    "avg_prev_return_post_240_pct",
    "positive_share_post_60_pct",
    "positive_share_post_240_pct",
    "avg_prev_surprise_pct",
]
DEFAULT_ALIGNMENT_PATH = Path(
    "data/calendar_outputs/event_price_alignment/event_price_alignment.parquet"
)
DEFAULT_DETAIL_OUTPUT_PARQUET = BASE_OUTPUT_DIR / "path_dependency_events.parquet"
DEFAULT_DETAIL_OUTPUT_CSV = BASE_OUTPUT_DIR / "path_dependency_events.csv"
DEFAULT_SUMMARY_OUTPUT_PARQUET = BASE_OUTPUT_DIR / "path_dependency_summary.parquet"
DEFAULT_SUMMARY_OUTPUT_CSV = BASE_OUTPUT_DIR / "path_dependency_summary.csv"

DEFAULT_MIN_EVENTS = 5

GROUP_COLUMNS = ["currency", "base_indicator"]


@dataclass
class PathDependencyConfig:
    alignment_path: Path
    detail_output_parquet: Path
    detail_output_csv: Optional[Path]
    summary_output_parquet: Path
    summary_output_csv: Optional[Path]
    min_events: int = DEFAULT_MIN_EVENTS

    def __post_init__(self) -> None:
        self.alignment_path = self.alignment_path.expanduser().resolve()
        self.detail_output_parquet = self.detail_output_parquet.expanduser().resolve()
        if self.detail_output_csv is not None:
            self.detail_output_csv = self.detail_output_csv.expanduser().resolve()
        self.summary_output_parquet = self.summary_output_parquet.expanduser().resolve()
        if self.summary_output_csv is not None:
            self.summary_output_csv = self.summary_output_csv.expanduser().resolve()
        if self.min_events <= 0:
            raise ValueError("min_events must be positive")


@dataclass
class PathDependencyResult:
    detail: pd.DataFrame
    summary: pd.DataFrame


def _load_alignment(
    config: PathDependencyConfig, alignment_df: Optional[pd.DataFrame]
) -> pd.DataFrame:
    if alignment_df is None:
        if not config.alignment_path.exists():
            raise FileNotFoundError(config.alignment_path)
        alignment_df = pd.read_parquet(config.alignment_path)

    if alignment_df.empty:
        raise SystemExit("Alignment dataset is empty; nothing to analyse.")

    required = {"event_name", "event_time"}
    missing = required - set(alignment_df.columns)
    if missing:
        raise ValueError(f"Alignment dataset missing required columns: {missing}")

    df = alignment_df.copy()
    df["event_name"] = df["event_name"].astype(str)
    df["event_time"] = pd.to_datetime(df["event_time"])
    return df


def _classify_surprise_direction(value: Optional[float]) -> str:
    if value is None or pd.isna(value):
        return "missing"
    if abs(float(value)) < SURPRISE_NEAR_ZERO_PCT:
        return "neutral"
    return "positive" if value > 0 else "negative"


def _positive_share(series: pd.Series) -> Optional[float]:
    clean = series.dropna().astype(float)
    if clean.empty:
        return None
    return round((clean > 0).mean() * 100.0, 4)


def _mean(series: pd.Series) -> Optional[float]:
    clean = series.dropna().astype(float)
    if clean.empty:
        return None
    return float(round(clean.mean(), 6))


def _prepare_features(df: pd.DataFrame) -> pd.DataFrame:
    enriched = df.copy()
    enriched["base_indicator"] = enriched["event_name"].apply(_normalise_base_indicator)
    enriched["frequency_tag"] = enriched["event_name"].apply(_extract_frequency)
    enriched["core_category"] = enriched["event_name"].apply(_categorise_core)
    enriched["surprise_direction"] = enriched["surprise_pct"].apply(
        _classify_surprise_direction
    )
    return enriched


def _build_detail(enriched: pd.DataFrame) -> pd.DataFrame:
    records: list[dict[str, object]] = []

    grouped = enriched.sort_values("event_time").groupby(GROUP_COLUMNS, sort=False)
    for (currency_value, base_indicator), group in grouped:
        group_sorted = group.sort_values("event_time")

        last_event_time = pd.NaT
        last_surprise_direction: Optional[str] = None
        last_surprise_pct: Optional[float] = None
        last_return_post_60: Optional[float] = None
        last_return_post_240: Optional[float] = None
        last_streak_length = 0

        for _, row in group_sorted.iterrows():
            direction = row.get("surprise_direction")
            prev_direction = last_surprise_direction
            prev_streak_length = last_streak_length

            prev_record = {
                "prev_event_time": last_event_time,
                "prev_surprise_direction": prev_direction,
                "prev_surprise_pct": last_surprise_pct,
                "prev_return_post_60_pct": last_return_post_60,
                "prev_return_post_240_pct": last_return_post_240,
                "prev_streak_length": prev_streak_length,
            }

            if direction == "missing":
                streak_state = "missing"
                streak_length = 0
                streak_direction = None
            elif direction == "neutral":
                streak_state = "neutral"
                streak_length = 0
                streak_direction = None
            else:
                if prev_direction in (None, "missing", "neutral"):
                    streak_length = 1
                    streak_state = "baseline"
                elif prev_direction == direction:
                    streak_length = prev_streak_length + 1
                    streak_state = "momentum"
                else:
                    streak_length = 1
                    streak_state = "fatigue"
                streak_direction = direction

            streak_bucket: Optional[str]
            if streak_length == 0:
                streak_bucket = "0"
            elif streak_length >= 3:
                streak_bucket = "3+"
            else:
                streak_bucket = str(streak_length)

            record = {
                "event_id": row.get("event_id"),
                "event_time": row.get("event_time"),
                "event_name": row.get("event_name"),
                "currency": currency_value,
                "importance": row.get("importance"),
                "base_indicator": base_indicator,
                "frequency_tag": row.get("frequency_tag"),
                "core_category": row.get("core_category"),
                "surprise_pct": row.get("surprise_pct"),
                "surprise_direction": direction,
                "return_post_60_pct": row.get("return_post_60_pct"),
                "return_post_240_pct": row.get("return_post_240_pct"),
                "streak_state": streak_state,
                "streak_direction": streak_direction,
                "streak_length": streak_length,
                "streak_bucket": streak_bucket,
            }
            record.update(prev_record)
            records.append(record)

            last_event_time = row.get("event_time")
            last_surprise_pct = row.get("surprise_pct")
            last_return_post_60 = row.get("return_post_60_pct")
            last_return_post_240 = row.get("return_post_240_pct")

            if direction == "missing":
                last_surprise_direction = None
                last_streak_length = 0
            elif direction == "neutral":
                last_surprise_direction = "neutral"
                last_streak_length = 0
            else:
                last_surprise_direction = direction
                last_streak_length = streak_length

    detail = pd.DataFrame.from_records(records)
    if detail.empty:
        return pd.DataFrame(columns=DETAIL_COLUMNS)

    detail = detail.reindex(columns=DETAIL_COLUMNS)
    detail["event_time"] = pd.to_datetime(detail["event_time"])
    detail["prev_event_time"] = pd.to_datetime(detail["prev_event_time"])

    numeric_cols = detail.select_dtypes(include="number").columns
    detail[numeric_cols] = detail[numeric_cols].applymap(
        lambda x: round(x, 6) if isinstance(x, float) else x
    )
    return detail


def _build_summary(detail: pd.DataFrame, min_events: int) -> pd.DataFrame:
    if detail.empty:
        return pd.DataFrame()

    relevant = detail[detail["streak_state"].isin({"baseline", "momentum", "fatigue"})]
    if relevant.empty:
        return pd.DataFrame()

    records: list[dict[str, object]] = []
    group_cols = [
        "currency",
        "base_indicator",
        "frequency_tag",
        "core_category",
        "streak_state",
        "streak_direction",
        "streak_bucket",
    ]
    grouped = relevant.groupby(group_cols, dropna=False, sort=False)
    for key, group in grouped:
        sample_size = int(group.shape[0])
        if sample_size < min_events:
            continue

        record = {col: value for col, value in zip(group_cols, key)}
        record["sample_size"] = sample_size
        record["avg_surprise_pct"] = _mean(group["surprise_pct"])
        record["avg_return_post_60_pct"] = _mean(group["return_post_60_pct"])
        record["avg_return_post_240_pct"] = _mean(group["return_post_240_pct"])
        record["avg_prev_return_post_60_pct"] = _mean(group["prev_return_post_60_pct"])
        record["avg_prev_return_post_240_pct"] = _mean(
            group["prev_return_post_240_pct"]
        )
        record["positive_share_post_60_pct"] = _positive_share(
            group["return_post_60_pct"]
        )
        record["positive_share_post_240_pct"] = _positive_share(
            group["return_post_240_pct"]
        )
        record["avg_prev_surprise_pct"] = _mean(group["prev_surprise_pct"])
        records.append(record)

    summary = pd.DataFrame.from_records(records)
    if summary.empty:
        return pd.DataFrame(columns=SUMMARY_COLUMNS)

    summary = summary.reindex(columns=SUMMARY_COLUMNS)
    numeric_cols = summary.select_dtypes(include="number").columns
    summary[numeric_cols] = summary[numeric_cols].applymap(
        lambda x: round(x, 6) if isinstance(x, float) else x
    )
    return summary.sort_values(
        group_cols + ["sample_size"], ascending=[True] * len(group_cols) + [False]
    )


def run_path_dependency(
    config: PathDependencyConfig, alignment_df: Optional[pd.DataFrame] = None
) -> PathDependencyResult:
    df = _load_alignment(config, alignment_df)
    enriched = _prepare_features(df)
    detail = _build_detail(enriched)
    summary = _build_summary(detail, config.min_events)

    if not detail.empty:
        config.detail_output_parquet.parent.mkdir(parents=True, exist_ok=True)
        detail.to_parquet(config.detail_output_parquet, index=False)
        if config.detail_output_csv is not None:
            config.detail_output_csv.parent.mkdir(parents=True, exist_ok=True)
            detail.to_csv(config.detail_output_csv, index=False)
    else:
        print("[INFO] No path dependency events produced; skipping detail outputs.")

    if not summary.empty:
        config.summary_output_parquet.parent.mkdir(parents=True, exist_ok=True)
        summary.to_parquet(config.summary_output_parquet, index=False)
        if config.summary_output_csv is not None:
            config.summary_output_csv.parent.mkdir(parents=True, exist_ok=True)
            summary.to_csv(config.summary_output_csv, index=False)
    else:
        print("[INFO] No path dependency summary produced; skipping summary outputs.")

    if not detail.empty or not summary.empty:
        print(
            "Saved path dependency outputs -> "
            f"{config.detail_output_parquet}, {config.summary_output_parquet}"
        )
    return PathDependencyResult(detail=detail, summary=summary)


def parse_args() -> PathDependencyConfig:
    parser = argparse.ArgumentParser(
        description=(
            "Stage B path dependency: capture surprise streak momentum vs fatigue"
            " and associated price reactions."
        )
    )
    parser.add_argument(
        "--alignment-path",
        type=Path,
        default=DEFAULT_ALIGNMENT_PATH,
        help="Parquet file produced by event_price_alignment.py.",
    )
    parser.add_argument(
        "--detail-output-parquet",
        type=Path,
        default=DEFAULT_DETAIL_OUTPUT_PARQUET,
        help="Detailed event-level output path (parquet).",
    )
    parser.add_argument(
        "--detail-output-csv",
        type=Path,
        default=DEFAULT_DETAIL_OUTPUT_CSV,
        help="Optional CSV output for event-level records.",
    )
    parser.add_argument(
        "--no-detail-csv",
        action="store_true",
        help="Skip writing the detail CSV output.",
    )
    parser.add_argument(
        "--summary-output-parquet",
        type=Path,
        default=DEFAULT_SUMMARY_OUTPUT_PARQUET,
        help="Aggregated summary output path (parquet).",
    )
    parser.add_argument(
        "--summary-output-csv",
        type=Path,
        default=DEFAULT_SUMMARY_OUTPUT_CSV,
        help="Optional CSV output for aggregated summaries.",
    )
    parser.add_argument(
        "--no-summary-csv",
        action="store_true",
        help="Skip writing the summary CSV output.",
    )
    parser.add_argument(
        "--min-events",
        type=int,
        default=DEFAULT_MIN_EVENTS,
        help="Minimum sample size required when reporting aggregated streak metrics.",
    )

    args = parser.parse_args()
    return PathDependencyConfig(
        alignment_path=args.alignment_path,
        detail_output_parquet=args.detail_output_parquet,
        detail_output_csv=None if args.no_detail_csv else args.detail_output_csv,
        summary_output_parquet=args.summary_output_parquet,
        summary_output_csv=None if args.no_summary_csv else args.summary_output_csv,
        min_events=args.min_events,
    )


if __name__ == "__main__":
    config = parse_args()
    run_path_dependency(config)
