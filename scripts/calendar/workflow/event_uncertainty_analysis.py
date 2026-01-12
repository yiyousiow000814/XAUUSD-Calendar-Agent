"""Stage C predictive uncertainty: confidence intervals and calibration curves."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Sequence

import pandas as pd

try:
    from .event_price_deepdive import _normalise_surprise_direction
except ImportError:  # pragma: no cover
    import sys

    sys.path.append(str(Path(__file__).resolve().parents[3]))
    # fmt: off
    from scripts.calendar.workflow.event_price_deepdive import (
        _normalise_surprise_direction,  # type: ignore[import-not-found]
    )

    # fmt: on

BASE_OUTPUT_DIR = Path("data/calendar_outputs/event_uncertainty")
DEFAULT_ALIGNMENT_PATH = Path(
    "data/calendar_outputs/event_price_alignment/event_price_alignment.parquet"
)
DEFAULT_SUMMARY_PARQUET = BASE_OUTPUT_DIR / "uncertainty_interval_summary.parquet"
DEFAULT_SUMMARY_CSV = BASE_OUTPUT_DIR / "uncertainty_interval_summary.csv"
DEFAULT_CALIBRATION_PARQUET = (
    BASE_OUTPUT_DIR / "uncertainty_calibration_summary.parquet"
)
DEFAULT_CALIBRATION_CSV = BASE_OUTPUT_DIR / "uncertainty_calibration_summary.csv"
DEFAULT_EVENT_PARQUET = BASE_OUTPUT_DIR / "uncertainty_event_predictions.parquet"
DEFAULT_EVENT_CSV = BASE_OUTPUT_DIR / "uncertainty_event_predictions.csv"

DEFAULT_WINDOWS = (60, 120, 240, 1440)
DEFAULT_QUANTILES = (0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95)
DEFAULT_CALIBRATION_BINS = (0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0)
DEFAULT_MIN_SAMPLES = 15
DEFAULT_MIN_CALIBRATION = 30


@dataclass
class UncertaintyConfig:
    alignment_path: Path = DEFAULT_ALIGNMENT_PATH
    summary_output_parquet: Path = DEFAULT_SUMMARY_PARQUET
    summary_output_csv: Optional[Path] = DEFAULT_SUMMARY_CSV
    calibration_output_parquet: Path = DEFAULT_CALIBRATION_PARQUET
    calibration_output_csv: Optional[Path] = DEFAULT_CALIBRATION_CSV
    event_output_parquet: Path = DEFAULT_EVENT_PARQUET
    event_output_csv: Optional[Path] = DEFAULT_EVENT_CSV
    windows: Sequence[int] = DEFAULT_WINDOWS
    quantiles: Sequence[float] = DEFAULT_QUANTILES
    calibration_bins: Sequence[float] = DEFAULT_CALIBRATION_BINS
    min_samples: int = DEFAULT_MIN_SAMPLES
    min_calibration: int = DEFAULT_MIN_CALIBRATION

    def __post_init__(self) -> None:
        self.alignment_path = self.alignment_path.expanduser().resolve()
        self.summary_output_parquet = self.summary_output_parquet.expanduser().resolve()
        if self.summary_output_csv is not None:
            self.summary_output_csv = self.summary_output_csv.expanduser().resolve()
        self.calibration_output_parquet = (
            self.calibration_output_parquet.expanduser().resolve()
        )
        if self.calibration_output_csv is not None:
            self.calibration_output_csv = (
                self.calibration_output_csv.expanduser().resolve()
            )
        self.event_output_parquet = self.event_output_parquet.expanduser().resolve()
        if self.event_output_csv is not None:
            self.event_output_csv = self.event_output_csv.expanduser().resolve()
        self.windows = tuple(sorted({int(w) for w in self.windows if int(w) > 0}))
        if not self.windows:
            raise ValueError("windows must include at least one positive integer")
        cleaned_quantiles = sorted(
            {float(q) for q in self.quantiles if 0 < float(q) < 1}
        )
        if not cleaned_quantiles:
            raise ValueError("quantiles must include values between 0 and 1")
        self.quantiles = tuple(cleaned_quantiles)
        bins = sorted({float(b) for b in self.calibration_bins})
        if bins[0] > 0.0:
            bins.insert(0, 0.0)
        if bins[-1] < 1.0:
            bins.append(1.0)
        self.calibration_bins = tuple(bins)
        if self.min_samples < 5:
            raise ValueError("min_samples must be >= 5")
        if self.min_calibration < 10:
            raise ValueError("min_calibration must be >= 10")


@dataclass
class UncertaintyResult:
    summary: pd.DataFrame
    calibration: pd.DataFrame
    event_predictions: pd.DataFrame


def _load_alignment(
    config: UncertaintyConfig, alignment_df: Optional[pd.DataFrame]
) -> pd.DataFrame:
    if alignment_df is not None:
        df = alignment_df.copy()
    else:
        if not config.alignment_path.exists():
            raise FileNotFoundError(
                f"Alignment dataset not found: {config.alignment_path}"
            )
        df = pd.read_parquet(config.alignment_path)
    if df.empty:
        raise SystemExit("Alignment dataset is empty; nothing to process.")
    df["event_time"] = pd.to_datetime(df["event_time"])
    df["importance"] = df["importance"].astype(str).str.title()
    df["surprise_direction"] = df.get("surprise_category").apply(
        lambda value: _normalise_surprise_direction(value)
    )
    return df


def _compute_quantile_fields(
    series: pd.Series, quantiles: Sequence[float]
) -> dict[str, float]:
    results: dict[str, float] = {}
    for q in quantiles:
        value = float(series.quantile(q))
        results[f"quantile_{int(q*100):02d}"] = value
        if q < 0.5:
            level = int((1 - 2 * q) * 100)
            results[f"ci_{level}_lower"] = value
            results[f"ci_{level}_upper"] = float(series.quantile(1 - q))
    return results


def _build_interval_summary(
    df: pd.DataFrame, config: UncertaintyConfig
) -> pd.DataFrame:
    records: list[dict[str, object]] = []
    directions = ["all", "positive", "negative", "neutral"]

    for direction in directions:
        if direction == "all":
            subset = df
        else:
            mask = df["surprise_direction"] == direction
            if not mask.any():
                continue
            subset = df.loc[mask]

        grouped = subset.groupby(
            ["event_name", "currency", "importance"], dropna=False, sort=False
        )
        for (event_name, currency, importance), group in grouped:
            for window in config.windows:
                column = f"return_post_{window}_pct"
                if column not in group.columns:
                    continue
                series = group[column].dropna().astype(float)
                sample_size = int(series.shape[0])
                if sample_size < config.min_samples:
                    continue
                record: dict[str, object] = {
                    "event_name": event_name,
                    "currency": currency,
                    "importance": importance,
                    "surprise_direction": None if direction == "all" else direction,
                    "window": int(window),
                    "sample_size": sample_size,
                    "mean_return_pct": float(series.mean()),
                    "std_return_pct": float(series.std(ddof=0)),
                    "positive_share_pct": float((series > 0).mean() * 100.0),
                    "negative_share_pct": float((series < 0).mean() * 100.0),
                    "zero_share_pct": float((series == 0).mean() * 100.0),
                    "abs_mean_return_pct": float(series.abs().mean()),
                }
                record.update(_compute_quantile_fields(series, config.quantiles))
                records.append(record)

    if not records:
        return pd.DataFrame()
    summary = pd.DataFrame(records)
    numeric_cols = summary.select_dtypes(include=["number"]).columns
    summary[numeric_cols] = summary[numeric_cols].round(6)
    columns_order = (
        [
            "event_name",
            "currency",
            "importance",
            "surprise_direction",
            "window",
            "sample_size",
            "mean_return_pct",
            "std_return_pct",
            "abs_mean_return_pct",
            "positive_share_pct",
            "negative_share_pct",
            "zero_share_pct",
        ]
        + sorted([col for col in summary.columns if col.startswith("quantile_")])
        + sorted([col for col in summary.columns if col.startswith("ci_")])
    )
    summary = (
        summary[columns_order]
        .sort_values(
            by=["event_name", "currency", "importance", "surprise_direction", "window"]
        )
        .reset_index(drop=True)
    )
    return summary


def _build_event_predictions(
    df: pd.DataFrame, summary: pd.DataFrame, config: UncertaintyConfig
) -> pd.DataFrame:
    positive_map: dict[tuple[str, str, str, Optional[str], int], float] = {}
    if summary.empty:
        return pd.DataFrame()
    for row in summary.itertuples():
        key = (
            row.event_name,
            row.currency,
            row.importance,
            getattr(row, "surprise_direction", None),
            int(row.window),
        )
        positive_map[key] = float(row.positive_share_pct) / 100.0
    event_records: list[dict[str, object]] = []
    for _, row in df.iterrows():
        direction = row.get("surprise_direction")
        for window in config.windows:
            column = f"return_post_{window}_pct"
            if column not in df.columns:
                continue
            value = row.get(column)
            if value is None or pd.isna(value):
                continue
            key = (
                row.get("event_name"),
                row.get("currency"),
                row.get("importance"),
                direction,
                int(window),
            )
            predicted = positive_map.get(key)
            if predicted is None:
                fallback = (
                    row.get("event_name"),
                    row.get("currency"),
                    row.get("importance"),
                    None,
                    int(window),
                )
                predicted = positive_map.get(fallback)
            if predicted is None:
                continue
            record = {
                "event_id": row.get("event_id"),
                "event_time": row.get("event_time"),
                "event_name": row.get("event_name"),
                "currency": row.get("currency"),
                "importance": row.get("importance"),
                "surprise_direction": direction,
                "window": int(window),
                "predicted_positive_share_pct": float(predicted * 100.0),
                "actual_positive_flag": float(1.0 if float(value) > 0 else 0.0),
                "return_pct": float(value),
            }
            event_records.append(record)
    if not event_records:
        return pd.DataFrame()
    event_df = pd.DataFrame(event_records)
    numeric_cols = event_df.select_dtypes(include=["number"]).columns
    event_df[numeric_cols] = event_df[numeric_cols].round(6)
    return event_df.sort_values(by=["event_time", "event_name", "window"]).reset_index(
        drop=True
    )


def _build_calibration_summary(
    event_predictions: pd.DataFrame, config: UncertaintyConfig
) -> pd.DataFrame:
    if event_predictions.empty:
        return pd.DataFrame()
    df = event_predictions.copy()
    df["predicted_prob"] = df["predicted_positive_share_pct"] / 100.0
    bins = list(config.calibration_bins)
    df["prediction_bin"] = pd.cut(
        df["predicted_prob"],
        bins=bins,
        include_lowest=True,
        right=False,
        labels=[f"[{bins[i]:.2f},{bins[i+1]:.2f})" for i in range(len(bins) - 1)],
    )
    grouped = df.groupby(
        ["window", "prediction_bin"], dropna=False, observed=True, sort=False
    )
    records: list[dict[str, object]] = []
    for (window, bin_label), group in grouped:
        sample_size = int(group.shape[0])
        if sample_size < config.min_calibration:
            continue
        records.append(
            {
                "window": int(window),
                "prediction_bin": bin_label,
                "sample_size": sample_size,
                "avg_predicted_prob": float(group["predicted_prob"].mean()),
                "actual_positive_rate": float(group["actual_positive_flag"].mean()),
                "avg_return_pct": float(group["return_pct"].mean()),
            }
        )
    if not records:
        return pd.DataFrame()
    calibration = pd.DataFrame(records)
    numeric_cols = calibration.select_dtypes(include=["number"]).columns
    calibration[numeric_cols] = calibration[numeric_cols].round(6)
    return calibration.sort_values(by=["window", "prediction_bin"]).reset_index(
        drop=True
    )


def run_uncertainty_analysis(
    config: UncertaintyConfig,
    alignment_df: Optional[pd.DataFrame] = None,
) -> UncertaintyResult:
    alignment = _load_alignment(config, alignment_df)
    summary = _build_interval_summary(alignment, config)
    event_predictions = _build_event_predictions(alignment, summary, config)
    calibration = _build_calibration_summary(event_predictions, config)

    config.summary_output_parquet.parent.mkdir(parents=True, exist_ok=True)
    summary.to_parquet(config.summary_output_parquet, index=False)
    if config.summary_output_csv is not None:
        config.summary_output_csv.parent.mkdir(parents=True, exist_ok=True)
        summary.to_csv(config.summary_output_csv, index=False)

    config.calibration_output_parquet.parent.mkdir(parents=True, exist_ok=True)
    calibration.to_parquet(config.calibration_output_parquet, index=False)
    if config.calibration_output_csv is not None:
        config.calibration_output_csv.parent.mkdir(parents=True, exist_ok=True)
        calibration.to_csv(config.calibration_output_csv, index=False)

    config.event_output_parquet.parent.mkdir(parents=True, exist_ok=True)
    event_predictions.to_parquet(config.event_output_parquet, index=False)
    if config.event_output_csv is not None:
        config.event_output_csv.parent.mkdir(parents=True, exist_ok=True)
        event_predictions.to_csv(config.event_output_csv, index=False)

    metadata = {
        "windows": list(config.windows),
        "quantiles": list(config.quantiles),
        "calibration_bins": list(config.calibration_bins),
        "min_samples": config.min_samples,
        "min_calibration": config.min_calibration,
        "summary_rows": int(summary.shape[0]),
        "calibration_rows": int(calibration.shape[0]),
        "event_prediction_rows": int(event_predictions.shape[0]),
    }
    (config.summary_output_parquet.parent / "uncertainty_metadata.json").write_text(
        json.dumps(metadata, indent=2),
        encoding="utf-8",
    )

    return UncertaintyResult(
        summary=summary,
        calibration=calibration,
        event_predictions=event_predictions,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Stage C predictive uncertainty analysis."
    )
    parser.add_argument(
        "--alignment-path",
        type=Path,
        default=DEFAULT_ALIGNMENT_PATH,
        help="Stage A/B alignment dataset (parquet).",
    )
    parser.add_argument(
        "--summary-output-parquet",
        type=Path,
        default=DEFAULT_SUMMARY_PARQUET,
        help="Parquet output for confidence interval summary.",
    )
    parser.add_argument(
        "--summary-output-csv",
        type=Path,
        default=DEFAULT_SUMMARY_CSV,
        help="Optional CSV output for confidence interval summary.",
    )
    parser.add_argument(
        "--no-summary-csv",
        action="store_true",
        help="Skip writing the summary CSV.",
    )
    parser.add_argument(
        "--calibration-output-parquet",
        type=Path,
        default=DEFAULT_CALIBRATION_PARQUET,
        help="Parquet output for calibration summary.",
    )
    parser.add_argument(
        "--calibration-output-csv",
        type=Path,
        default=DEFAULT_CALIBRATION_CSV,
        help="Optional CSV output for calibration summary.",
    )
    parser.add_argument(
        "--no-calibration-csv",
        action="store_true",
        help="Skip writing the calibration CSV.",
    )
    parser.add_argument(
        "--event-output-parquet",
        type=Path,
        default=DEFAULT_EVENT_PARQUET,
        help="Parquet output for event-level predictions.",
    )
    parser.add_argument(
        "--event-output-csv",
        type=Path,
        default=DEFAULT_EVENT_CSV,
        help="Optional CSV output for event-level predictions.",
    )
    parser.add_argument(
        "--no-event-csv",
        action="store_true",
        help="Skip writing the event-level prediction CSV.",
    )
    parser.add_argument(
        "--windows",
        type=int,
        nargs="*",
        default=list(DEFAULT_WINDOWS),
        help="Return windows (minutes) used to compute intervals (default: 60 120 240 1440).",
    )
    parser.add_argument(
        "--quantiles",
        type=float,
        nargs="*",
        default=list(DEFAULT_QUANTILES),
        help="Quantiles for interval estimation (default: 0.05 0.1 0.25 0.5 0.75 0.9 0.95).",
    )
    parser.add_argument(
        "--calibration-bins",
        type=float,
        nargs="*",
        default=list(DEFAULT_CALIBRATION_BINS),
        help="Bin edges for calibration analysis (default: 0.0 0.1 ... 1.0).",
    )
    parser.add_argument(
        "--min-samples",
        type=int,
        default=DEFAULT_MIN_SAMPLES,
        help="Minimum samples required per group to compute intervals (default: 15).",
    )
    parser.add_argument(
        "--min-calibration",
        type=int,
        default=DEFAULT_MIN_CALIBRATION,
        help="Minimum samples required per bin for calibration summary (default: 30).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config = UncertaintyConfig(
        alignment_path=args.alignment_path,
        summary_output_parquet=args.summary_output_parquet,
        summary_output_csv=None if args.no_summary_csv else args.summary_output_csv,
        calibration_output_parquet=args.calibration_output_parquet,
        calibration_output_csv=(
            None if args.no_calibration_csv else args.calibration_output_csv
        ),
        event_output_parquet=args.event_output_parquet,
        event_output_csv=None if args.no_event_csv else args.event_output_csv,
        windows=args.windows,
        quantiles=args.quantiles,
        calibration_bins=args.calibration_bins,
        min_samples=args.min_samples,
        min_calibration=args.min_calibration,
    )
    run_uncertainty_analysis(config)


if __name__ == "__main__":
    main()
