"""Stage B preheat monitor: flag pre-event price/volume anomalies."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Sequence

import pandas as pd

BASE_OUTPUT_DIR = Path("data/calendar_outputs/event_preheat_monitor")
DEFAULT_ALIGNMENT_PATH = Path(
    "data/calendar_outputs/event_price_alignment/event_price_alignment.parquet"
)
DEFAULT_METRICS_PARQUET = BASE_OUTPUT_DIR / "preheat_metrics.parquet"
DEFAULT_METRICS_CSV = BASE_OUTPUT_DIR / "preheat_metrics.csv"
DEFAULT_FLAGS_PARQUET = BASE_OUTPUT_DIR / "preheat_flags.parquet"
DEFAULT_FLAGS_CSV = BASE_OUTPUT_DIR / "preheat_flags.csv"
DEFAULT_THRESHOLDS_CSV = BASE_OUTPUT_DIR / "preheat_thresholds.csv"
DEFAULT_SUMMARY_PARQUET = BASE_OUTPUT_DIR / "preheat_summary.parquet"
DEFAULT_SUMMARY_CSV = BASE_OUTPUT_DIR / "preheat_summary.csv"

DEFAULT_PRE_WINDOWS = (15, 60)
DEFAULT_VOLUME_BASELINES = (60, 240, 1440)
DEFAULT_QUANTILES = (0.75, 0.9, 0.95)
DEFAULT_FLAG_QUANTILE = 0.9


@dataclass
class PreheatConfig:
    alignment_path: Path
    metrics_output_parquet: Path
    metrics_output_csv: Optional[Path]
    flags_output_parquet: Path
    flags_output_csv: Optional[Path]
    thresholds_output_csv: Path
    summary_output_parquet: Path
    summary_output_csv: Optional[Path]
    pre_windows: Sequence[int] = DEFAULT_PRE_WINDOWS
    volume_baselines: Sequence[int] = DEFAULT_VOLUME_BASELINES
    quantiles: Sequence[float] = DEFAULT_QUANTILES
    flag_quantile: float = DEFAULT_FLAG_QUANTILE

    def __post_init__(self) -> None:
        self.alignment_path = self.alignment_path.expanduser().resolve()
        self.metrics_output_parquet = self.metrics_output_parquet.expanduser().resolve()
        if self.metrics_output_csv is not None:
            self.metrics_output_csv = self.metrics_output_csv.expanduser().resolve()
        self.flags_output_parquet = self.flags_output_parquet.expanduser().resolve()
        if self.flags_output_csv is not None:
            self.flags_output_csv = self.flags_output_csv.expanduser().resolve()
        self.thresholds_output_csv = self.thresholds_output_csv.expanduser().resolve()
        self.summary_output_parquet = self.summary_output_parquet.expanduser().resolve()
        if self.summary_output_csv is not None:
            self.summary_output_csv = self.summary_output_csv.expanduser().resolve()

        self.pre_windows = tuple(sorted({int(w) for w in self.pre_windows if w > 0}))
        if not self.pre_windows:
            raise ValueError("pre_windows must contain positive integers")

        self.volume_baselines = tuple(
            sorted({int(w) for w in self.volume_baselines if w > 0})
        )
        if not 0 < self.flag_quantile < 1:
            raise ValueError("flag_quantile must be between 0 and 1")
        quant_set = {float(q) for q in self.quantiles if 0 < q < 1}
        quant_set.add(float(self.flag_quantile))
        self.quantiles = tuple(sorted(quant_set))


@dataclass
class PreheatResult:
    metrics: pd.DataFrame
    thresholds: pd.DataFrame
    flags: pd.DataFrame
    summary: pd.DataFrame


def _load_alignment(path: Path) -> pd.DataFrame:
    if not path.exists():
        raise FileNotFoundError(f"Alignment dataset not found: {path}")
    df = pd.read_parquet(path)
    if df.empty:
        raise SystemExit("Alignment dataset is empty; nothing to process.")
    return df


def _baseline_pairs(
    pre_windows: Sequence[int], baselines: Sequence[int]
) -> set[tuple[int, int]]:
    pairs: set[tuple[int, int]] = set()
    for window in pre_windows:
        for base in baselines:
            if base != window:
                pairs.add((window, base))
    sorted_pre = sorted(pre_windows)
    for idx, window in enumerate(sorted_pre):
        for base in sorted_pre[idx + 1 :]:
            pairs.add((window, base))
    return pairs


def _compute_metrics(
    df: pd.DataFrame, pre_windows: Sequence[int], baselines: Sequence[int]
) -> tuple[pd.DataFrame, list[dict[str, object]]]:
    base_columns = [
        "event_id",
        "event_time",
        "event_name",
        "currency",
        "importance",
        "surprise",
        "surprise_pct",
        "revision",
        "revision_pct",
        "forecast_minus_previous",
        "forecast_minus_previous_pct",
    ]
    available_cols = [col for col in base_columns if col in df.columns]
    metrics = df[available_cols].copy()

    metric_specs: list[dict[str, object]] = []

    for window in pre_windows:
        return_col = f"return_pre_{window}_pct"
        if return_col in df.columns:
            abs_col = f"abs_return_pre_{window}_pct"
            metrics[abs_col] = df[return_col].abs()
            metric_specs.append(
                {
                    "column": abs_col,
                    "metric_type": "abs_return",
                    "window": window,
                    "baseline": None,
                    "source_column": return_col,
                }
            )

        vol_col = f"volatility_pre_{window}_pct"
        if vol_col in df.columns:
            metrics[vol_col] = df[vol_col]
            metric_specs.append(
                {
                    "column": vol_col,
                    "metric_type": "volatility",
                    "window": window,
                    "baseline": None,
                    "source_column": vol_col,
                }
            )

    pairs = _baseline_pairs(pre_windows, baselines)
    for window, baseline in sorted(pairs):
        num_col = f"volume_pre_{window}_avg"
        denom_col = f"volume_pre_{baseline}_avg"
        if num_col not in df.columns or denom_col not in df.columns:
            continue
        ratio_col = f"volume_ratio_pre_{window}_over_{baseline}"
        numerator = df[num_col].astype(float)
        denominator = df[denom_col].astype(float).replace({0.0: pd.NA})
        ratio = numerator.div(denominator)
        ratio = ratio.replace([float("inf"), float("-inf")], pd.NA)
        metrics[ratio_col] = ratio
        metric_specs.append(
            {
                "column": ratio_col,
                "metric_type": "volume_ratio",
                "window": window,
                "baseline": baseline,
                "source_column": num_col,
                "baseline_column": denom_col,
            }
        )

    return metrics, metric_specs


def _build_thresholds(
    metrics: pd.DataFrame,
    metric_specs: Sequence[dict[str, object]],
    quantiles: Sequence[float],
) -> pd.DataFrame:
    rows: list[dict[str, object]] = []
    for spec in metric_specs:
        column = spec["column"]
        series = metrics[column].dropna().astype(float)
        if series.empty:
            continue
        for quantile in quantiles:
            rows.append(
                {
                    "metric": column,
                    "metric_type": spec.get("metric_type"),
                    "window": spec.get("window"),
                    "baseline": spec.get("baseline"),
                    "quantile": quantile,
                    "threshold": float(series.quantile(quantile)),
                    "sample_size": int(series.shape[0]),
                    "mean": float(series.mean()),
                    "std": float(series.std(ddof=0)),
                }
            )
    if not rows:
        return pd.DataFrame(
            columns=[
                "metric",
                "metric_type",
                "window",
                "baseline",
                "quantile",
                "threshold",
                "sample_size",
                "mean",
                "std",
            ]
        )
    thresholds = pd.DataFrame(rows)
    numeric_cols = thresholds.select_dtypes(include="number").columns
    thresholds[numeric_cols] = thresholds[numeric_cols].round(6)
    return thresholds.sort_values(["metric", "quantile"]).reset_index(drop=True)


def _apply_flags(
    metrics: pd.DataFrame,
    metric_specs: Sequence[dict[str, object]],
    thresholds: pd.DataFrame,
    flag_quantile: float,
) -> tuple[pd.DataFrame, list[dict[str, object]]]:
    threshold_lookup = {}
    for _, row in thresholds.iterrows():
        threshold_lookup[(row["metric"], row["quantile"])] = row["threshold"]

    flag_infos: list[dict[str, object]] = []

    for spec in metric_specs:
        column = spec["column"]
        threshold = threshold_lookup.get((column, flag_quantile))
        if threshold is None:
            continue
        if spec["metric_type"] == "abs_return":
            flag_col = f"flag_price_pre_{spec['window']}"
        elif spec["metric_type"] == "volatility":
            flag_col = f"flag_volatility_pre_{spec['window']}"
        elif spec["metric_type"] == "volume_ratio":
            baseline = spec.get("baseline")
            flag_col = f"flag_volume_pre_{spec['window']}_over_{baseline}"
        else:
            continue
        metrics[flag_col] = metrics[column].astype(float) >= threshold
        flag_infos.append(
            {
                "flag_column": flag_col,
                "metric_column": column,
                "threshold": threshold,
                "metric_type": spec.get("metric_type"),
                "window": spec.get("window"),
                "baseline": spec.get("baseline"),
            }
        )

    if not flag_infos:
        metrics["flag_price_pre"] = False
        metrics["flag_volatility_pre"] = False
        metrics["flag_volume_pre"] = False
        metrics["requires_preheat_review"] = False
        metrics["preheat_reasons"] = ""
        return metrics, flag_infos

    price_flags = [
        info["flag_column"]
        for info in flag_infos
        if info["metric_type"] == "abs_return"
    ]
    vol_flags = [
        info["flag_column"]
        for info in flag_infos
        if info["metric_type"] == "volatility"
    ]
    volume_flags = [
        info["flag_column"]
        for info in flag_infos
        if info["metric_type"] == "volume_ratio"
    ]

    metrics["flag_price_pre"] = (
        metrics[price_flags].any(axis=1) if price_flags else False
    )
    metrics["flag_volatility_pre"] = (
        metrics[vol_flags].any(axis=1) if vol_flags else False
    )
    metrics["flag_volume_pre"] = (
        metrics[volume_flags].any(axis=1) if volume_flags else False
    )

    metrics["requires_preheat_review"] = metrics[
        ["flag_price_pre", "flag_volatility_pre", "flag_volume_pre"]
    ].any(axis=1)

    def build_reason(row: pd.Series) -> str:
        reasons: list[str] = []
        for info in flag_infos:
            flag_col = info["flag_column"]
            if not bool(row.get(flag_col)):
                continue
            metric_value = row.get(info["metric_column"])
            if pd.isna(metric_value):
                continue
            if info["metric_type"] == "volume_ratio":
                reasons.append(
                    f"volume pre{info['window']}/pre{info['baseline']} {metric_value:.4f} >= q{int(flag_quantile*100)} {info['threshold']:.4f}"
                )
            elif info["metric_type"] == "abs_return":
                reasons.append(
                    f"abs return pre{info['window']} {metric_value:.4f}% >= q{int(flag_quantile*100)} {info['threshold']:.4f}%"
                )
            else:
                reasons.append(
                    f"volatility pre{info['window']} {metric_value:.4f}% >= q{int(flag_quantile*100)} {info['threshold']:.4f}%"
                )
        return "; ".join(reasons)

    metrics["preheat_reasons"] = metrics.apply(build_reason, axis=1)
    return metrics, flag_infos


def _build_summary(metrics: pd.DataFrame) -> pd.DataFrame:
    summary = (
        metrics.groupby("event_name", dropna=False)
        .agg(
            total_events=("event_id", "count"),
            flagged_events=("requires_preheat_review", "sum"),
            price_flags=("flag_price_pre", "sum"),
            volume_flags=("flag_volume_pre", "sum"),
            volatility_flags=("flag_volatility_pre", "sum"),
        )
        .reset_index()
    )
    summary["flagged_share"] = (
        summary["flagged_events"] / summary["total_events"] * 100.0
    ).round(2)
    return summary.sort_values(
        ["flagged_share", "total_events"], ascending=[False, False]
    )


def run_preheat_monitor(
    config: PreheatConfig, alignment_df: Optional[pd.DataFrame] = None
) -> PreheatResult:
    df = (
        alignment_df.copy()
        if alignment_df is not None
        else _load_alignment(config.alignment_path)
    )
    metrics, specs = _compute_metrics(df, config.pre_windows, config.volume_baselines)
    thresholds = _build_thresholds(metrics, specs, config.quantiles)
    metrics, _ = _apply_flags(metrics, specs, thresholds, config.flag_quantile)
    summary = _build_summary(metrics)
    flags = metrics[metrics["requires_preheat_review"].fillna(False)].copy()

    config.metrics_output_parquet.parent.mkdir(parents=True, exist_ok=True)
    metrics.to_parquet(config.metrics_output_parquet, index=False)
    if config.metrics_output_csv is not None:
        config.metrics_output_csv.parent.mkdir(parents=True, exist_ok=True)
        metrics.to_csv(config.metrics_output_csv, index=False)

    config.flags_output_parquet.parent.mkdir(parents=True, exist_ok=True)
    flags.to_parquet(config.flags_output_parquet, index=False)
    if config.flags_output_csv is not None:
        config.flags_output_csv.parent.mkdir(parents=True, exist_ok=True)
        flags.to_csv(config.flags_output_csv, index=False)

    config.thresholds_output_csv.parent.mkdir(parents=True, exist_ok=True)
    thresholds.to_csv(config.thresholds_output_csv, index=False)

    config.summary_output_parquet.parent.mkdir(parents=True, exist_ok=True)
    summary.to_parquet(config.summary_output_parquet, index=False)
    if config.summary_output_csv is not None:
        config.summary_output_csv.parent.mkdir(parents=True, exist_ok=True)
        summary.to_csv(config.summary_output_csv, index=False)

    print(
        "Saved Stage B preheat monitor outputs -> "
        f"{config.metrics_output_parquet}, {config.flags_output_parquet}, {config.thresholds_output_csv}"
    )

    return PreheatResult(
        metrics=metrics, thresholds=thresholds, flags=flags, summary=summary
    )


def parse_args() -> PreheatConfig:
    parser = argparse.ArgumentParser(
        description=(
            "Stage B preheat monitor: flag pre-event price/volume anomalies indicating potential leaks."
        )
    )
    parser.add_argument("--alignment-path", type=Path, default=DEFAULT_ALIGNMENT_PATH)
    parser.add_argument(
        "--metrics-output-parquet",
        type=Path,
        default=DEFAULT_METRICS_PARQUET,
        help="Output parquet with per-event preheat metrics and flags.",
    )
    parser.add_argument(
        "--metrics-output-csv",
        type=Path,
        default=DEFAULT_METRICS_CSV,
        help="Optional CSV for per-event metrics (omit via --no-metrics-csv).",
    )
    parser.add_argument(
        "--no-metrics-csv",
        action="store_true",
        help="Skip writing the per-event metrics CSV.",
    )
    parser.add_argument(
        "--flags-output-parquet",
        type=Path,
        default=DEFAULT_FLAGS_PARQUET,
        help="Output parquet filtered to flagged events only.",
    )
    parser.add_argument(
        "--flags-output-csv",
        type=Path,
        default=DEFAULT_FLAGS_CSV,
        help="Optional CSV filtered to flagged events (omit via --no-flags-csv).",
    )
    parser.add_argument(
        "--no-flags-csv",
        action="store_true",
        help="Skip writing the flagged events CSV.",
    )
    parser.add_argument(
        "--thresholds-output-csv",
        type=Path,
        default=DEFAULT_THRESHOLDS_CSV,
        help="CSV storing quantile thresholds for monitored metrics.",
    )
    parser.add_argument(
        "--summary-output-parquet",
        type=Path,
        default=DEFAULT_SUMMARY_PARQUET,
        help="Output parquet summarising flagged counts by event name.",
    )
    parser.add_argument(
        "--summary-output-csv",
        type=Path,
        default=DEFAULT_SUMMARY_CSV,
        help="Optional CSV summary (omit via --no-summary-csv).",
    )
    parser.add_argument(
        "--no-summary-csv",
        action="store_true",
        help="Skip writing the summary CSV.",
    )
    parser.add_argument(
        "--pre-windows",
        type=int,
        nargs="+",
        default=list(DEFAULT_PRE_WINDOWS),
        help="Pre-event windows (minutes) to monitor (default: 15 60).",
    )
    parser.add_argument(
        "--volume-baselines",
        type=int,
        nargs="+",
        default=list(DEFAULT_VOLUME_BASELINES),
        help="Baseline windows (minutes) used to compute volume ratios (default: 60 240 1440).",
    )
    parser.add_argument(
        "--quantiles",
        type=float,
        nargs="+",
        default=list(DEFAULT_QUANTILES),
        help="Quantiles used for threshold calculation (default: 0.75 0.9 0.95).",
    )
    parser.add_argument(
        "--flag-quantile",
        type=float,
        default=DEFAULT_FLAG_QUANTILE,
        help="Quantile level to trigger preheat flags (default: 0.9).",
    )

    args = parser.parse_args()
    return PreheatConfig(
        alignment_path=args.alignment_path,
        metrics_output_parquet=args.metrics_output_parquet,
        metrics_output_csv=None if args.no_metrics_csv else args.metrics_output_csv,
        flags_output_parquet=args.flags_output_parquet,
        flags_output_csv=None if args.no_flags_csv else args.flags_output_csv,
        thresholds_output_csv=args.thresholds_output_csv,
        summary_output_parquet=args.summary_output_parquet,
        summary_output_csv=None if args.no_summary_csv else args.summary_output_csv,
        pre_windows=args.pre_windows,
        volume_baselines=args.volume_baselines,
        quantiles=args.quantiles,
        flag_quantile=args.flag_quantile,
    )


if __name__ == "__main__":
    cfg = parse_args()
    run_preheat_monitor(cfg)
