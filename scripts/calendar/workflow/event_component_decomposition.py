"""Stage B component decomposition: annotate component direction shares."""

from __future__ import annotations

import argparse
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional, Sequence

import pandas as pd

BASE_OUTPUT_DIR = Path("data/calendar_outputs/component_decomposition")
DEFAULT_ALIGNMENT_PATH = Path(
    "data/calendar_outputs/event_price_alignment/event_price_alignment.parquet"
)
DEFAULT_DETAIL_OUTPUT_PARQUET = BASE_OUTPUT_DIR / "component_breakdown.parquet"
DEFAULT_DETAIL_OUTPUT_CSV = BASE_OUTPUT_DIR / "component_breakdown.csv"
DEFAULT_SUMMARY_OUTPUT_PARQUET = BASE_OUTPUT_DIR / "component_summary.parquet"
DEFAULT_SUMMARY_OUTPUT_CSV = BASE_OUTPUT_DIR / "component_summary.csv"

DEFAULT_MIN_EVENTS = 5

FREQUENCY_PATTERNS: Sequence[tuple[str, re.Pattern[str]]] = (
    ("YoY", re.compile(r"\bYoY\b", flags=re.IGNORECASE)),
    ("MoM", re.compile(r"\bMoM\b", flags=re.IGNORECASE)),
    ("QoQ", re.compile(r"\bQoQ\b", flags=re.IGNORECASE)),
    ("WoW", re.compile(r"\bW[/-]?W\b", flags=re.IGNORECASE)),
    ("YoY-SA", re.compile(r"\bYoY\s*SA\b", flags=re.IGNORECASE)),
)

MONTH_SUFFIX = re.compile(
    r"\s*\((jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec"
    r"|january|february|march|april|june|july|august|september|october|november|december"
    r"|q[1-4]|\d{4})[^)]*\)",
    flags=re.IGNORECASE,
)
CORE_PATTERNS: Sequence[re.Pattern[str]] = (
    re.compile(r"\bcore\b", flags=re.IGNORECASE),
    re.compile(r"\bex\b[^()]*\b(food|energy|autos|housing)\b", flags=re.IGNORECASE),
    re.compile(
        r"\bexcluding\b[^()]*\b(food|energy|autos|housing)\b", flags=re.IGNORECASE
    ),
)
ENERGY_PATTERN = re.compile(
    r"\b(energy|oil|gasoline|gas|petroleum|fuel|crude)\b", flags=re.IGNORECASE
)
HOUSING_PATTERN = re.compile(
    r"\b(housing|home|homes|residential|shelter|mortgage)\b", flags=re.IGNORECASE
)
FOOD_PATTERN = re.compile(r"\b(food|agricultural)\b", flags=re.IGNORECASE)


@dataclass
class ComponentConfig:
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
class ComponentResult:
    detail: pd.DataFrame
    summary: pd.DataFrame


def _ensure_alignment_df(
    config: ComponentConfig, alignment_df: Optional[pd.DataFrame]
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


def _strip_month_suffix(name: str) -> str:
    return MONTH_SUFFIX.sub("", name).strip()


def _normalise_base_indicator(name: str) -> str:
    base = _strip_month_suffix(name)
    base = re.sub(r"(?i)^core\s+", "", base)
    base = re.sub(r"(?i)\b(ex|excluding)\b[^()]*", "", base)
    base = re.sub(r"\s+", " ", base)
    return base.strip()


def _extract_frequency(name: str) -> str:
    for label, pattern in FREQUENCY_PATTERNS:
        if pattern.search(name):
            return label
    if "(SA)" in name or "(NSA)" in name:
        return "Seasonal"
    return "Level"


def _categorise_core(name: str) -> str:
    for pattern in CORE_PATTERNS:
        if pattern.search(name):
            return "core"
    return "headline"


def _categorise_component(name: str) -> str:
    if ENERGY_PATTERN.search(name):
        return "energy"
    if HOUSING_PATTERN.search(name):
        return "housing"
    if FOOD_PATTERN.search(name):
        return "food"
    return "other"


def _direction_stats(series: pd.Series) -> dict[str, Optional[float]]:
    clean = series.dropna().astype(float)
    total = int(clean.shape[0])
    if total == 0:
        return {
            "count": 0,
            "positive_count": 0,
            "negative_count": 0,
            "neutral_count": 0,
            "positive_share_pct": None,
            "negative_share_pct": None,
            "neutral_share_pct": None,
            "avg": None,
        }

    positive_count = int((clean > 0).sum())
    negative_count = int((clean < 0).sum())
    neutral_count = total - positive_count - negative_count
    positive_share = round(positive_count / total * 100.0, 4)
    negative_share = round(negative_count / total * 100.0, 4)
    neutral_share = round(neutral_count / total * 100.0, 4)
    avg_value = float(clean.mean())

    return {
        "count": total,
        "positive_count": positive_count,
        "negative_count": negative_count,
        "neutral_count": neutral_count,
        "positive_share_pct": positive_share,
        "negative_share_pct": negative_share,
        "neutral_share_pct": neutral_share,
        "avg": avg_value,
    }


def _populate_directional_metrics(
    record: dict[str, object], series: pd.Series, prefix: str
) -> None:
    stats = _direction_stats(series)
    record[f"{prefix}_sample_size"] = stats["count"]
    record[f"{prefix}_positive_count"] = stats["positive_count"]
    record[f"{prefix}_negative_count"] = stats["negative_count"]
    record[f"{prefix}_neutral_count"] = stats["neutral_count"]
    record[f"{prefix}_positive_share_pct"] = stats["positive_share_pct"]
    record[f"{prefix}_negative_share_pct"] = stats["negative_share_pct"]
    record[f"{prefix}_neutral_share_pct"] = stats["neutral_share_pct"]
    record[f"{prefix}_avg"] = stats["avg"]


def _build_component_metrics(
    df: pd.DataFrame, group_cols: Sequence[str], min_events: int
) -> pd.DataFrame:
    records: list[dict[str, object]] = []

    grouped = df.groupby(group_cols, dropna=False, sort=False)
    for key, group in grouped:
        if not isinstance(key, Iterable) or isinstance(key, str):
            key = (key,)
        record = {col: value for col, value in zip(group_cols, key)}
        record["event_count"] = int(group.shape[0])
        record["unique_events"] = int(group["event_name"].nunique())

        _populate_directional_metrics(record, group["surprise_pct"], "surprise")
        _populate_directional_metrics(
            record, group["return_post_60_pct"], "return_post_60"
        )
        _populate_directional_metrics(
            record, group["return_post_240_pct"], "return_post_240"
        )

        largest_sample = max(
            record["surprise_sample_size"],
            record["return_post_60_sample_size"],
            record["return_post_240_sample_size"],
        )
        if largest_sample < min_events:
            continue

        records.append(record)

    if not records:
        return pd.DataFrame(
            columns=list(group_cols)
            + [
                "event_count",
                "unique_events",
                "surprise_sample_size",
                "surprise_positive_count",
                "surprise_negative_count",
                "surprise_neutral_count",
                "surprise_positive_share_pct",
                "surprise_negative_share_pct",
                "surprise_neutral_share_pct",
                "surprise_avg",
                "return_post_60_sample_size",
                "return_post_60_positive_count",
                "return_post_60_negative_count",
                "return_post_60_neutral_count",
                "return_post_60_positive_share_pct",
                "return_post_60_negative_share_pct",
                "return_post_60_neutral_share_pct",
                "return_post_60_avg",
                "return_post_240_sample_size",
                "return_post_240_positive_count",
                "return_post_240_negative_count",
                "return_post_240_neutral_count",
                "return_post_240_positive_share_pct",
                "return_post_240_negative_share_pct",
                "return_post_240_neutral_share_pct",
                "return_post_240_avg",
            ]
        )

    frame = pd.DataFrame.from_records(records)
    numeric_cols = frame.select_dtypes(include="number").columns
    frame[numeric_cols] = frame[numeric_cols].applymap(
        lambda x: round(x, 6) if isinstance(x, float) else x
    )
    return frame.sort_values(
        list(group_cols) + ["event_count"],
        ascending=[True] * len(group_cols) + [False],
    )


def _prepare_features(df: pd.DataFrame) -> pd.DataFrame:
    enriched = df.copy()
    enriched["base_indicator"] = enriched["event_name"].apply(_normalise_base_indicator)
    enriched["frequency_tag"] = enriched["event_name"].apply(_extract_frequency)
    enriched["core_category"] = enriched["event_name"].apply(_categorise_core)
    enriched["component_category"] = enriched["event_name"].apply(_categorise_component)
    return enriched


def run_component_decomposition(
    config: ComponentConfig, alignment_df: Optional[pd.DataFrame] = None
) -> ComponentResult:
    df = _ensure_alignment_df(config, alignment_df)
    enriched = _prepare_features(df)

    detail = _build_component_metrics(
        enriched,
        ["base_indicator", "frequency_tag", "core_category", "component_category"],
        config.min_events,
    )
    summary = _build_component_metrics(
        enriched,
        ["core_category", "component_category", "frequency_tag"],
        config.min_events,
    )

    config.detail_output_parquet.parent.mkdir(parents=True, exist_ok=True)
    detail.to_parquet(config.detail_output_parquet, index=False)
    if config.detail_output_csv is not None:
        config.detail_output_csv.parent.mkdir(parents=True, exist_ok=True)
        detail.to_csv(config.detail_output_csv, index=False)

    config.summary_output_parquet.parent.mkdir(parents=True, exist_ok=True)
    summary.to_parquet(config.summary_output_parquet, index=False)
    if config.summary_output_csv is not None:
        config.summary_output_csv.parent.mkdir(parents=True, exist_ok=True)
        summary.to_csv(config.summary_output_csv, index=False)

    print(
        "Saved component decomposition outputs -> "
        f"{config.detail_output_parquet}, {config.summary_output_parquet}"
    )
    return ComponentResult(detail=detail, summary=summary)


def parse_args() -> ComponentConfig:
    parser = argparse.ArgumentParser(
        description=(
            "Stage B component decomposition: compute direction shares for core/headline"
            " and key sub-components such as energy or housing."
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
        help="Detailed component breakdown parquet output.",
    )
    parser.add_argument(
        "--detail-output-csv",
        type=Path,
        default=DEFAULT_DETAIL_OUTPUT_CSV,
        help="Optional CSV output for detailed component breakdown.",
    )
    parser.add_argument(
        "--no-detail-csv",
        action="store_true",
        help="Skip writing the detailed component CSV output.",
    )
    parser.add_argument(
        "--summary-output-parquet",
        type=Path,
        default=DEFAULT_SUMMARY_OUTPUT_PARQUET,
        help="Aggregated component summary parquet output.",
    )
    parser.add_argument(
        "--summary-output-csv",
        type=Path,
        default=DEFAULT_SUMMARY_OUTPUT_CSV,
        help="Optional CSV output for aggregated component summary.",
    )
    parser.add_argument(
        "--no-summary-csv",
        action="store_true",
        help="Skip writing the aggregated component CSV output.",
    )
    parser.add_argument(
        "--min-events",
        type=int,
        default=DEFAULT_MIN_EVENTS,
        help="Minimum valid samples required for a component bucket to be reported.",
    )

    args = parser.parse_args()
    return ComponentConfig(
        alignment_path=args.alignment_path,
        detail_output_parquet=args.detail_output_parquet,
        detail_output_csv=None if args.no_detail_csv else args.detail_output_csv,
        summary_output_parquet=args.summary_output_parquet,
        summary_output_csv=None if args.no_summary_csv else args.summary_output_csv,
        min_events=args.min_events,
    )


if __name__ == "__main__":
    config = parse_args()
    run_component_decomposition(config)
