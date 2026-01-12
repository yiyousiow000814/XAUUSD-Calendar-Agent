"""Stage C adaptive window selection based on surprise magnitude."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional, Sequence

import numpy as np
import pandas as pd

try:
    from .event_price_deepdive import _normalise_surprise_direction
except ImportError:  # pragma: no cover
    import sys

    sys.path.append(str(Path(__file__).resolve().parents[3]))
    from scripts.calendar.workflow.event_price_deepdive import (
        _normalise_surprise_direction,
    )

BASE_OUTPUT_DIR = Path("data/calendar_outputs/event_adaptive_window")
DEFAULT_ALIGNMENT_PATH = Path(
    "data/calendar_outputs/event_price_alignment/event_price_alignment.parquet"
)
DEFAULT_EVENTS_PARQUET = BASE_OUTPUT_DIR / "adaptive_window_events.parquet"
DEFAULT_EVENTS_CSV = BASE_OUTPUT_DIR / "adaptive_window_events.csv"
DEFAULT_SUMMARY_PARQUET = BASE_OUTPUT_DIR / "adaptive_window_summary.parquet"
DEFAULT_SUMMARY_CSV = BASE_OUTPUT_DIR / "adaptive_window_summary.csv"
DEFAULT_RECOMMENDATIONS_JSON = BASE_OUTPUT_DIR / "adaptive_window_recommendations.json"

DEFAULT_POST_WINDOWS: tuple[int, ...] = (15, 60, 120, 240, 1440)
DEFAULT_DOMINANCE_RATIO = 0.8
DEFAULT_SURPRISE_QUANTILES: tuple[float, ...] = (0.33, 0.66)
DEFAULT_MIN_EVENTS = 15
DEFAULT_TOP_WINDOWS = 3
DEFAULT_MIN_SHARE = 0.15
DEFAULT_FALLBACK_WINDOWS: tuple[int, ...] = (60, 120, 240)
EPSILON = 1e-9


def _ensure_alignment(path: Path, df: Optional[pd.DataFrame]) -> pd.DataFrame:
    if df is not None:
        frame = df.copy()
    else:
        if not path.exists():
            raise FileNotFoundError(f"Alignment dataset not found: {path}")
        frame = pd.read_parquet(path)
    if frame.empty:
        raise SystemExit("Alignment dataset is empty; nothing to process.")
    required = {"event_id", "event_time", "event_name", "currency"}
    missing = required.difference(frame.columns)
    if missing:
        raise ValueError(f"Alignment dataset missing columns: {sorted(missing)}")
    frame["event_time"] = pd.to_datetime(frame["event_time"])
    return frame


def _detect_post_windows(
    df: pd.DataFrame, configured: Optional[Sequence[int]]
) -> list[int]:
    if configured:
        values = {int(v) for v in configured if int(v) >= 1}
    else:
        values = {
            int(col[len("return_post_") : -len("_pct")])
            for col in df.columns
            if col.startswith("return_post_") and col.endswith("_pct")
        }
    valid = {v for v in values if v > 0}
    if not valid:
        raise SystemExit("No post-event return columns detected for adaptive analysis.")
    return sorted(valid)


def _prepare_surprise_bins(
    series: pd.Series, quantiles: Sequence[float]
) -> list[tuple[str, Optional[float], Optional[float]]]:
    clean = series.dropna().astype(float)
    if clean.empty:
        return [("all", None, None)]

    unique_q = sorted({float(q) for q in quantiles if 0 < q < 1})
    thresholds: list[float] = []
    for q in unique_q:
        value = float(clean.quantile(q))
        if thresholds and abs(value - thresholds[-1]) < EPSILON:
            continue
        thresholds.append(value)

    if not thresholds:
        return [("all", None, None)]

    if len(thresholds) == 1:
        labels = ["low", "high"]
    elif len(thresholds) == 2:
        labels = ["low", "mid", "high"]
    else:
        labels = [f"bin_{i}" for i in range(len(thresholds) + 1)]

    bins: list[tuple[str, Optional[float], Optional[float]]] = []
    lower: Optional[float] = None
    for label, threshold in zip(labels, thresholds):
        bins.append((label, lower, threshold))
        lower = threshold
    bins.append((labels[-1], lower, None))
    return bins


def _assign_bucket(
    value: Optional[float], bins: Sequence[tuple[str, Optional[float], Optional[float]]]
) -> str:
    if value is None or (isinstance(value, float) and np.isnan(value)):
        return "unknown"
    for label, lower, upper in bins:
        lower_ok = True if lower is None else value >= lower - EPSILON
        upper_ok = True if upper is None else value < upper - EPSILON
        if lower_ok and upper_ok:
            return label
    return bins[-1][0] if bins else "all"


def _format_profile(profile: Iterable[tuple[int, float]]) -> str:
    formatted = [f"{minutes}:{ratio:.4f}" for minutes, ratio in profile]
    return ";".join(formatted)


def _compute_event_profiles(
    df: pd.DataFrame,
    post_windows: Sequence[int],
    dominance_ratio: float,
    bins: Sequence[tuple[str, Optional[float], Optional[float]]],
) -> pd.DataFrame:
    records: list[dict[str, object]] = []
    if not 0 < dominance_ratio <= 1:
        raise ValueError("dominance_ratio must be in (0, 1].")

    for _, row in df.iterrows():
        base: dict[str, object] = {
            "event_id": row.get("event_id"),
            "event_time": row.get("event_time"),
            "event_name": row.get("event_name"),
            "currency": row.get("currency"),
            "importance": row.get("importance"),
        }
        surprise_pct = row.get("surprise_pct")
        surprise_abs = None
        if surprise_pct is not None and not pd.isna(surprise_pct):
            surprise_abs = abs(float(surprise_pct))
        base["surprise_pct"] = surprise_pct
        base["surprise_pct_abs"] = surprise_abs
        direction = _normalise_surprise_direction(row.get("surprise_category"))
        base["surprise_direction"] = direction
        base["surprise_bucket"] = _assign_bucket(surprise_abs, bins)

        returns = []
        for minutes in post_windows:
            value = row.get(f"return_post_{minutes}_pct")
            if value is None or pd.isna(value):
                continue
            returns.append((minutes, float(value)))

        if not returns:
            base.update(
                {
                    "adaptive_max_window": None,
                    "adaptive_max_return_pct": None,
                    "adaptive_max_return_abs_pct": None,
                    "adaptive_dominant_window": None,
                    "adaptive_dominant_return_pct": None,
                    "adaptive_dominant_share": None,
                    "adaptive_profile": "",
                }
            )
            records.append(base)
            continue

        returns = sorted(returns, key=lambda item: item[0])
        abs_values = {minutes: abs(value) for minutes, value in returns}
        max_window, max_abs_value = max(
            abs_values.items(), key=lambda item: (item[1], -item[0])
        )
        max_signed_value = dict(returns)[max_window]
        if max_abs_value <= EPSILON:
            dominant_window = max_window
            dominant_signed_value = max_signed_value
            dominant_share = 1.0
        else:
            candidate_minutes = [
                minutes
                for minutes, value in abs_values.items()
                if value >= max_abs_value * dominance_ratio - EPSILON
            ]
            dominant_window = (
                min(candidate_minutes) if candidate_minutes else max_window
            )
            dominant_signed_value = dict(returns)[dominant_window]
            dominant_share = abs(dominant_signed_value) / max_abs_value

        profile_pairs = [
            (
                minutes,
                (
                    (abs_values[minutes] / max_abs_value)
                    if max_abs_value > EPSILON
                    else 0.0
                ),
            )
            for minutes, _ in returns
        ]

        base.update(
            {
                "adaptive_max_window": int(max_window),
                "adaptive_max_return_pct": max_signed_value,
                "adaptive_max_return_abs_pct": max_abs_value,
                "adaptive_dominant_window": int(dominant_window),
                "adaptive_dominant_return_pct": dominant_signed_value,
                "adaptive_dominant_share": dominant_share,
                "adaptive_profile": _format_profile(profile_pairs),
            }
        )
        records.append(base)

    result = pd.DataFrame.from_records(records)
    numeric_cols = result.select_dtypes(include=["number"]).columns
    result[numeric_cols] = result[numeric_cols].astype(float)
    return result


def _summarise_profiles(
    events: pd.DataFrame,
    post_windows: Sequence[int],
    bins: Sequence[tuple[str, Optional[float], Optional[float]]],
    min_events: int,
    top_windows: int,
    min_share: float,
) -> pd.DataFrame:
    columns = [
        "currency",
        "importance",
        "surprise_direction",
        "surprise_bucket",
    ]
    summaries: list[dict[str, object]] = []

    bucket_bounds = {label: (lower, upper) for label, lower, upper in bins}

    for keys, group in events.groupby(columns, dropna=False, sort=False):
        currency, importance, direction, bucket = keys
        direction = direction or "all"
        count = len(group)
        if count < min_events:
            continue
        window_counts = (
            group["adaptive_dominant_window"].dropna().astype(int).value_counts()
        )
        share_info: dict[int, float] = {}
        for minutes in post_windows:
            share = float(window_counts.get(minutes, 0)) / count if count else 0.0
            share_info[minutes] = share

        recommended = [
            minutes
            for minutes, share in share_info.items()
            if share >= min_share - EPSILON
        ]
        if not recommended:
            ordered = sorted(share_info.items(), key=lambda item: (-item[1], item[0]))
            recommended = [minutes for minutes, _ in ordered[:top_windows]]
        recommended = sorted({int(minutes) for minutes in recommended})

        lower, upper = bucket_bounds.get(bucket, (None, None))
        summary = {
            "currency": currency,
            "importance": importance,
            "surprise_direction": direction,
            "surprise_bucket": bucket,
            "bucket_lower_bound": lower,
            "bucket_upper_bound": upper,
            "event_count": int(count),
            "avg_surprise_pct_abs": group["surprise_pct_abs"].dropna().mean(),
            "avg_max_return_abs_pct": group["adaptive_max_return_abs_pct"]
            .dropna()
            .mean(),
            "avg_dominant_share": group["adaptive_dominant_share"].dropna().mean(),
            "avg_dominant_window": group["adaptive_dominant_window"].dropna().mean(),
            "median_dominant_window": group["adaptive_dominant_window"]
            .dropna()
            .median(),
            "recommended_windows": ",".join(str(v) for v in recommended),
        }
        for minutes, share in share_info.items():
            summary[f"dominant_share_{minutes}"] = share * 100.0
        summaries.append(summary)

    if not summaries:
        return pd.DataFrame()
    summary_df = pd.DataFrame(summaries)
    numeric_cols = summary_df.select_dtypes(include=["number"]).columns
    summary_df[numeric_cols] = summary_df[numeric_cols].round(6)
    return summary_df


def _build_recommendations(
    summary: pd.DataFrame, fallback: Sequence[int]
) -> dict[str, tuple[int, ...]]:
    fallback_tuple = tuple(sorted({int(v) for v in fallback if int(v) >= 1}))
    recommendations: dict[str, tuple[int, ...]] = {}

    if summary.empty:
        directions = ["positive", "negative", "neutral"]
        for direction in directions:
            recommendations[direction] = fallback_tuple
        recommendations["all"] = fallback_tuple
        return recommendations

    def extract_windows(mask: pd.Series) -> tuple[int, ...]:
        selected = summary.loc[mask, "recommended_windows"].dropna().astype(str)
        windows: set[int] = set()
        for value in selected:
            for piece in value.split(","):
                piece = piece.strip()
                if not piece:
                    continue
                try:
                    windows.add(int(piece))
                except ValueError:
                    continue
        return tuple(sorted(windows)) if windows else fallback_tuple

    for direction in ["positive", "negative", "neutral"]:
        mask = summary["surprise_direction"].str.lower().fillna("") == direction
        recommendations[direction] = extract_windows(mask)

    union = sorted(
        {minutes for direction, values in recommendations.items() for minutes in values}
    )
    recommendations["all"] = tuple(union) if union else fallback_tuple
    return recommendations


@dataclass
class AdaptiveWindowConfig:
    alignment_path: Path = DEFAULT_ALIGNMENT_PATH
    events_output_parquet: Path = DEFAULT_EVENTS_PARQUET
    events_output_csv: Optional[Path] = DEFAULT_EVENTS_CSV
    summary_output_parquet: Path = DEFAULT_SUMMARY_PARQUET
    summary_output_csv: Optional[Path] = DEFAULT_SUMMARY_CSV
    recommendations_json: Path = DEFAULT_RECOMMENDATIONS_JSON
    post_windows: Sequence[int] = DEFAULT_POST_WINDOWS
    dominance_ratio: float = DEFAULT_DOMINANCE_RATIO
    surprise_quantiles: Sequence[float] = DEFAULT_SURPRISE_QUANTILES
    min_events: int = DEFAULT_MIN_EVENTS
    top_windows: int = DEFAULT_TOP_WINDOWS
    min_share: float = DEFAULT_MIN_SHARE
    fallback_windows: Sequence[int] = DEFAULT_FALLBACK_WINDOWS

    def __post_init__(self) -> None:
        self.alignment_path = self.alignment_path.expanduser().resolve()
        self.events_output_parquet = self.events_output_parquet.expanduser().resolve()
        if self.events_output_csv is not None:
            self.events_output_csv = self.events_output_csv.expanduser().resolve()
        self.summary_output_parquet = self.summary_output_parquet.expanduser().resolve()
        if self.summary_output_csv is not None:
            self.summary_output_csv = self.summary_output_csv.expanduser().resolve()
        self.recommendations_json = self.recommendations_json.expanduser().resolve()
        self.post_windows = tuple(int(v) for v in self.post_windows)
        self.surprise_quantiles = tuple(float(q) for q in self.surprise_quantiles)
        if not 0 < self.dominance_ratio <= 1:
            raise ValueError("dominance_ratio must be within (0, 1].")
        if not 0 < self.min_share <= 1:
            raise ValueError("min_share must be within (0, 1].")
        if self.top_windows < 1:
            raise ValueError("top_windows must be >= 1.")
        self.min_events = int(self.min_events)
        if self.min_events < 1:
            raise ValueError("min_events must be >= 1.")
        self.fallback_windows = tuple(int(v) for v in self.fallback_windows)


@dataclass
class AdaptiveWindowResult:
    events: pd.DataFrame
    summary: pd.DataFrame
    recommendations: dict[str, tuple[int, ...]]


def run_adaptive_window(
    config: AdaptiveWindowConfig, alignment_df: Optional[pd.DataFrame] = None
) -> AdaptiveWindowResult:
    df = _ensure_alignment(config.alignment_path, alignment_df)
    post_windows = _detect_post_windows(df, config.post_windows)
    bins = _prepare_surprise_bins(
        df.get("surprise_pct_abs", pd.Series(dtype=float)), config.surprise_quantiles
    )
    events = _compute_event_profiles(df, post_windows, config.dominance_ratio, bins)
    summary = _summarise_profiles(
        events,
        post_windows,
        bins,
        config.min_events,
        config.top_windows,
        config.min_share,
    )
    recommendations = _build_recommendations(summary, config.fallback_windows)

    config.events_output_parquet.parent.mkdir(parents=True, exist_ok=True)
    events.to_parquet(config.events_output_parquet, index=False)
    if config.events_output_csv is not None:
        config.events_output_csv.parent.mkdir(parents=True, exist_ok=True)
        events.to_csv(config.events_output_csv, index=False)

    if not summary.empty:
        config.summary_output_parquet.parent.mkdir(parents=True, exist_ok=True)
        summary.to_parquet(config.summary_output_parquet, index=False)
        if config.summary_output_csv is not None:
            config.summary_output_csv.parent.mkdir(parents=True, exist_ok=True)
            summary.to_csv(config.summary_output_csv, index=False)
    else:
        print("[WARN] Adaptive window summary is empty (insufficient samples).")

    config.recommendations_json.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "post_windows": post_windows,
        "dominance_ratio": config.dominance_ratio,
        "surprise_quantiles": config.surprise_quantiles,
        "min_events": config.min_events,
        "top_windows": config.top_windows,
        "min_share": config.min_share,
        "fallback_windows": config.fallback_windows,
        "recommendations": {key: list(value) for key, value in recommendations.items()},
    }
    config.recommendations_json.write_text(
        json.dumps(payload, indent=2), encoding="utf-8"
    )

    return AdaptiveWindowResult(
        events=events, summary=summary, recommendations=recommendations
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Stage C adaptive window analysis: recommend post-event observation "
            "windows by surprise magnitude and direction."
        )
    )
    parser.add_argument(
        "--alignment-path",
        type=Path,
        default=DEFAULT_ALIGNMENT_PATH,
        help="Stage A/B alignment dataset (parquet).",
    )
    parser.add_argument(
        "--events-output-parquet",
        type=Path,
        default=DEFAULT_EVENTS_PARQUET,
        help="Parquet output for per-event adaptive metrics.",
    )
    parser.add_argument(
        "--events-output-csv",
        type=Path,
        default=DEFAULT_EVENTS_CSV,
        help="Optional CSV output for per-event adaptive metrics.",
    )
    parser.add_argument(
        "--no-events-csv",
        action="store_true",
        help="Skip writing the per-event adaptive CSV output.",
    )
    parser.add_argument(
        "--summary-output-parquet",
        type=Path,
        default=DEFAULT_SUMMARY_PARQUET,
        help="Parquet output for adaptive window summaries.",
    )
    parser.add_argument(
        "--summary-output-csv",
        type=Path,
        default=DEFAULT_SUMMARY_CSV,
        help="Optional CSV output for adaptive window summaries.",
    )
    parser.add_argument(
        "--no-summary-csv",
        action="store_true",
        help="Skip writing the adaptive summary CSV output.",
    )
    parser.add_argument(
        "--recommendations-json",
        type=Path,
        default=DEFAULT_RECOMMENDATIONS_JSON,
        help="JSON output storing recommended windows per surprise direction.",
    )
    parser.add_argument(
        "--post-windows",
        type=int,
        nargs="*",
        default=list(DEFAULT_POST_WINDOWS),
        help="Candidate post-event windows (minutes) to evaluate.",
    )
    parser.add_argument(
        "--dominance-ratio",
        type=float,
        default=DEFAULT_DOMINANCE_RATIO,
        help="Share of max absolute return required to treat a window as dominant.",
    )
    parser.add_argument(
        "--surprise-quantiles",
        type=float,
        nargs="*",
        default=list(DEFAULT_SURPRISE_QUANTILES),
        help="Quantiles (0-1) to split surprise magnitude buckets.",
    )
    parser.add_argument(
        "--min-events",
        type=int,
        default=DEFAULT_MIN_EVENTS,
        help="Minimum samples required per summary bucket.",
    )
    parser.add_argument(
        "--top-windows",
        type=int,
        default=DEFAULT_TOP_WINDOWS,
        help="Fallback number of windows when min_share is not reached.",
    )
    parser.add_argument(
        "--min-share",
        type=float,
        default=DEFAULT_MIN_SHARE,
        help="Minimum share (0-1) for a window to be recommended explicitly.",
    )
    parser.add_argument(
        "--fallback-windows",
        type=int,
        nargs="*",
        default=list(DEFAULT_FALLBACK_WINDOWS),
        help="Fallback window list when no data-driven recommendation exists.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config = AdaptiveWindowConfig(
        alignment_path=args.alignment_path,
        events_output_parquet=args.events_output_parquet,
        events_output_csv=None if args.no_events_csv else args.events_output_csv,
        summary_output_parquet=args.summary_output_parquet,
        summary_output_csv=None if args.no_summary_csv else args.summary_output_csv,
        recommendations_json=args.recommendations_json,
        post_windows=args.post_windows,
        dominance_ratio=args.dominance_ratio,
        surprise_quantiles=args.surprise_quantiles,
        min_events=args.min_events,
        top_windows=args.top_windows,
        min_share=args.min_share,
        fallback_windows=args.fallback_windows,
    )
    run_adaptive_window(config)


if __name__ == "__main__":
    main()
