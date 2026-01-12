"""Stage B deep-dive: aggregate event responses and derive follow-up flags."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Sequence

import pandas as pd

BASE_OUTPUT_DIR = Path("data/calendar_outputs/event_price_deepdive")
DEFAULT_ALIGNMENT_PATH = Path(
    "data/calendar_outputs/event_price_alignment/event_price_alignment.parquet"
)
DEFAULT_HEATMAP_PARQUET = BASE_OUTPUT_DIR / "event_response_heatmap.parquet"
DEFAULT_HEATMAP_CSV = BASE_OUTPUT_DIR / "event_response_heatmap.csv"
DEFAULT_THRESHOLDS_CSV = BASE_OUTPUT_DIR / "return_thresholds.csv"
DEFAULT_FLAGS_PARQUET = BASE_OUTPUT_DIR / "event_followup_flags.parquet"
DEFAULT_FLAGS_CSV = BASE_OUTPUT_DIR / "event_followup_flags.csv"

DEFAULT_PRE_WINDOWS = (15, 60, 120, 240, 1440)
DEFAULT_POST_WINDOWS = (15, 60, 120, 240, 1440)
DEFAULT_STAGE_C_WINDOWS = (60, 120, 240)
DEFAULT_STAGE_D_WINDOWS = (15, 60)
DEFAULT_QUANTILES = (0.75, 0.9)
DEFAULT_FLAG_QUANTILE = 0.9
SURPRISE_NEAR_ZERO_PCT = 0.25


def _normalise_windows(values: Sequence[int]) -> tuple[int, ...]:
    return tuple(sorted({int(v) for v in values}))


def _normalise_optional_windows(
    values: Optional[Sequence[int]], fallback: Sequence[int]
) -> tuple[int, ...]:
    if values is None:
        return tuple(fallback)
    return _normalise_windows(values)


def _normalise_surprise_direction(value: Optional[object]) -> str:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return "all"
    label = str(value).strip().lower()
    if label in {"positive", "negative", "neutral"}:
        return label
    return "all"


def _lookup_threshold_value(
    threshold_map: dict[tuple[str, float, str], float],
    metric: str,
    quantile: float,
    direction: str,
) -> tuple[Optional[float], str]:
    for candidate in (direction, "all"):
        value = threshold_map.get((metric, quantile, candidate))
        if value is not None:
            return float(value), candidate
    return (None, "all")


@dataclass
class DeepDiveConfig:
    alignment_path: Path
    heatmap_output_parquet: Path
    heatmap_output_csv: Optional[Path]
    thresholds_output_csv: Path
    flags_output_parquet: Path
    flags_output_csv: Optional[Path]
    pre_windows: Sequence[int] = DEFAULT_PRE_WINDOWS
    post_windows: Sequence[int] = DEFAULT_POST_WINDOWS
    stage_c_windows: Sequence[int] = DEFAULT_STAGE_C_WINDOWS
    stage_d_windows: Sequence[int] = DEFAULT_STAGE_D_WINDOWS
    stage_c_positive_windows: Optional[Sequence[int]] = None
    stage_c_negative_windows: Optional[Sequence[int]] = None
    stage_d_positive_windows: Optional[Sequence[int]] = None
    stage_d_negative_windows: Optional[Sequence[int]] = None
    quantiles: Sequence[float] = DEFAULT_QUANTILES
    flag_quantile: float = DEFAULT_FLAG_QUANTILE

    def __post_init__(self) -> None:
        self.alignment_path = self.alignment_path.expanduser().resolve()
        self.heatmap_output_parquet = self.heatmap_output_parquet.expanduser().resolve()
        if self.heatmap_output_csv is not None:
            self.heatmap_output_csv = self.heatmap_output_csv.expanduser().resolve()
        self.thresholds_output_csv = self.thresholds_output_csv.expanduser().resolve()
        self.flags_output_parquet = self.flags_output_parquet.expanduser().resolve()
        if self.flags_output_csv is not None:
            self.flags_output_csv = self.flags_output_csv.expanduser().resolve()
        self.pre_windows = _normalise_windows(self.pre_windows)
        self.post_windows = _normalise_windows(self.post_windows)
        self.stage_c_windows = _normalise_windows(self.stage_c_windows)
        self.stage_d_windows = _normalise_windows(self.stage_d_windows)
        self.stage_c_positive_windows = _normalise_optional_windows(
            self.stage_c_positive_windows, self.stage_c_windows
        )
        self.stage_c_negative_windows = _normalise_optional_windows(
            self.stage_c_negative_windows, self.stage_c_windows
        )
        self.stage_d_positive_windows = _normalise_optional_windows(
            self.stage_d_positive_windows, self.stage_d_windows
        )
        self.stage_d_negative_windows = _normalise_optional_windows(
            self.stage_d_negative_windows, self.stage_d_windows
        )
        if not 0 < self.flag_quantile < 1:
            raise ValueError("flag_quantile must be between 0 and 1")
        quantile_set = {float(q) for q in self.quantiles if 0 < q < 1}
        quantile_set.add(float(self.flag_quantile))
        self.quantiles = tuple(sorted(quantile_set))


@dataclass
class DeepDiveResult:
    heatmap: pd.DataFrame
    thresholds: pd.DataFrame
    flags: pd.DataFrame


def _ensure_dataframe(
    config: DeepDiveConfig, alignment_df: Optional[pd.DataFrame]
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
    if "event_name" not in df.columns or "event_time" not in df.columns:
        raise ValueError(
            "Alignment dataset missing required columns (event_name/event_time)."
        )
    df["event_time"] = pd.to_datetime(df["event_time"])
    return df


def _mean(series: pd.Series) -> Optional[float]:
    series = series.dropna().astype(float)
    if series.empty:
        return None
    return float(series.mean())


def _median(series: pd.Series) -> Optional[float]:
    series = series.dropna().astype(float)
    if series.empty:
        return None
    return float(series.median())


def _positive_share(series: pd.Series) -> Optional[float]:
    series = series.dropna().astype(float)
    if series.empty:
        return None
    return float((series > 0).mean() * 100.0)


def _abs_quantile(series: pd.Series, quantile: float) -> Optional[float]:
    series = series.dropna().astype(float).abs()
    if series.empty:
        return None
    return float(series.quantile(quantile))


def _quantile(series: pd.Series, quantile: float) -> Optional[float]:
    series = series.dropna().astype(float)
    if series.empty:
        return None
    return float(series.quantile(quantile))


def _parse_return_column(column: str) -> tuple[str, Optional[int]]:
    if column == "return_at_pct":
        return ("at", 0)
    if column.startswith("return_pre_") and column.endswith("_pct"):
        middle = column[len("return_pre_") : -len("_pct")]
        minutes = int(middle) if middle.isdigit() else None
        return ("pre", minutes)
    if column.startswith("return_post_") and column.endswith("_pct"):
        middle = column[len("return_post_") : -len("_pct")]
        minutes = int(middle) if middle.isdigit() else None
        return ("post", minutes)
    return ("unknown", None)


def _build_heatmap_table(
    df: pd.DataFrame, pre_windows: Sequence[int], post_windows: Sequence[int]
) -> pd.DataFrame:
    columns: list[dict[str, object]] = []
    group_keys = ["event_name", "currency"]
    if "importance" in df.columns:
        df["importance"] = df["importance"].astype(str)
    grouped = df.groupby(group_keys, dropna=False, sort=False)

    for (event_name, currency), group in grouped:
        record: dict[str, object] = {
            "event_name": event_name,
            "currency": currency,
            "event_count": int(len(group)),
        }
        if "importance" in group.columns:
            unique_levels = sorted(
                {lvl for lvl in group["importance"].dropna().unique()}
            )
            record["importance_levels"] = (
                ",".join(unique_levels) if unique_levels else ""
            )

        record["avg_return_at_pct"] = _mean(group["return_at_pct"])
        record["median_return_at_pct"] = _median(group["return_at_pct"])
        record["positive_share_at_pct"] = _positive_share(group["return_at_pct"])

        for minutes in pre_windows:
            col = f"return_pre_{minutes}_pct"
            if col not in group.columns:
                continue
            record[f"avg_return_pre_{minutes}_pct"] = _mean(group[col])
            record[f"median_return_pre_{minutes}_pct"] = _median(group[col])
            record[f"positive_share_pre_{minutes}_pct"] = _positive_share(group[col])

        for minutes in post_windows:
            col = f"return_post_{minutes}_pct"
            if col not in group.columns:
                continue
            record[f"avg_return_post_{minutes}_pct"] = _mean(group[col])
            record[f"median_return_post_{minutes}_pct"] = _median(group[col])
            record[f"positive_share_post_{minutes}_pct"] = _positive_share(group[col])

        columns.append(record)

    heatmap = pd.DataFrame(columns)
    if heatmap.empty:
        return heatmap

    numeric_cols = heatmap.select_dtypes(include="number").columns
    heatmap[numeric_cols] = heatmap[numeric_cols].round(6)
    heatmap = heatmap.sort_values(
        by=["currency", "event_count", "event_name"], ascending=[True, False, True]
    )
    return heatmap.reset_index(drop=True)


def _build_threshold_table(
    df: pd.DataFrame, quantiles: Sequence[float]
) -> pd.DataFrame:
    rows: list[dict[str, object]] = []
    return_columns = [
        col
        for col in df.columns
        if (
            col == "return_at_pct"
            or (col.startswith("return_pre_") and col.endswith("_pct"))
            or (col.startswith("return_post_") and col.endswith("_pct"))
        )
    ]

    direction_series = None
    if "surprise_category" in df.columns:
        direction_series = df["surprise_category"].astype(str).str.strip().str.lower()

    directions: list[str] = ["all"]
    if direction_series is not None:
        available = sorted(
            {
                value
                for value in direction_series.dropna().unique()
                if value in {"positive", "negative", "neutral"}
            }
        )
        directions.extend(available)

    for column in return_columns:
        stage, window = _parse_return_column(column)
        for direction in directions:
            if direction == "all":
                subset = df
            else:
                if direction_series is None:
                    continue
                mask = direction_series == direction
                if not mask.any():
                    continue
                subset = df.loc[mask]

            series = subset[column].dropna().astype(float)
            if series.empty:
                continue

            samples = int(series.shape[0])
            mean_value = float(series.mean())
            std_value = float(series.std(ddof=0))
            abs_mean = float(series.abs().mean())

            for quantile in quantiles:
                upper = _quantile(series, quantile)
                lower = _quantile(series, 1 - quantile)
                abs_thresh = _abs_quantile(series, quantile)
                rows.append(
                    {
                        "metric": column,
                        "stage": stage,
                        "window": window,
                        "quantile": quantile,
                        "surprise_direction": direction,
                        "threshold_upper": upper,
                        "threshold_lower": lower,
                        "threshold_abs": abs_thresh,
                        "sample_size": samples,
                        "mean": mean_value,
                        "std": std_value,
                        "abs_mean": abs_mean,
                    }
                )

    thresholds = pd.DataFrame(rows)
    if thresholds.empty:
        return thresholds
    numeric_cols = thresholds.select_dtypes(include="number").columns
    thresholds[numeric_cols] = thresholds[numeric_cols].round(6)
    thresholds = thresholds.sort_values(
        by=["stage", "window", "surprise_direction", "quantile"]
    ).reset_index(drop=True)
    return thresholds


def _build_flag_table(
    df: pd.DataFrame,
    thresholds: pd.DataFrame,
    stage_c_window_map: dict[str, Sequence[int]],
    stage_d_window_map: dict[str, Sequence[int]],
    flag_quantile: float,
) -> pd.DataFrame:
    if thresholds.empty:
        raise SystemExit("Threshold table is empty; cannot derive Stage C/D flags.")

    threshold_map: dict[tuple[str, float, str], float] = {}
    for _, row in thresholds.iterrows():
        direction = _normalise_surprise_direction(row.get("surprise_direction"))
        threshold_map[(row["metric"], row["quantile"], direction)] = row[
            "threshold_abs"
        ]

    if not threshold_map:
        raise SystemExit("No thresholds computed; cannot derive Stage C/D flags.")

    stage_c_all_minutes = sorted(
        {
            int(minutes)
            for minutes_list in stage_c_window_map.values()
            for minutes in minutes_list
        }
    )
    post_windows_for_max = sorted({60, 120, 240, 1440}.union(stage_c_all_minutes))
    quantile_pct = int(round(flag_quantile * 100))

    records: list[dict[str, object]] = []

    for _, row in df.iterrows():
        direction = _normalise_surprise_direction(row.get("surprise_category"))
        stage_c_minutes = tuple(
            stage_c_window_map.get(direction) or stage_c_window_map.get("all", ())
        )
        stage_d_minutes = tuple(
            stage_d_window_map.get(direction) or stage_d_window_map.get("all", ())
        )

        record = {
            "event_id": row.get("event_id"),
            "event_time": row.get("event_time"),
            "event_name": row.get("event_name"),
            "currency": row.get("currency"),
            "importance": row.get("importance"),
            "surprise_pct": row.get("surprise_pct"),
            "revision_pct": row.get("revision_pct"),
            "forecast_minus_previous_pct": row.get("forecast_minus_previous_pct"),
            "surprise_direction": None if direction == "all" else direction,
        }

        stage_c_reasons: list[str] = []
        stage_d_reasons: list[str] = []
        stage_c_used_dirs: set[str] = set()
        stage_d_used_dirs: set[str] = set()

        for minutes in stage_c_minutes:
            column = f"return_post_{minutes}_pct"
            value = row.get(column)
            if value is None:
                continue
            threshold, used_direction = _lookup_threshold_value(
                threshold_map, column, flag_quantile, direction
            )
            if threshold is None:
                continue
            if abs(value) >= threshold:
                move_dir = "up" if value > 0 else "down"
                stage_c_used_dirs.add(used_direction)
                stage_c_reasons.append(
                    f"post_{minutes} {move_dir} {value:.4f}% >= abs_q{quantile_pct}[{used_direction}]({threshold:.4f}%)"
                )

        for minutes in stage_d_minutes:
            column = f"return_pre_{minutes}_pct"
            value = row.get(column)
            if value is None:
                continue
            threshold, used_direction = _lookup_threshold_value(
                threshold_map, column, flag_quantile, direction
            )
            if threshold is None:
                continue
            if abs(value) >= threshold:
                move_dir = "up" if value > 0 else "down"
                stage_d_used_dirs.add(used_direction)
                stage_d_reasons.append(
                    f"pre_{minutes} {move_dir} {value:.4f}% >= abs_q{quantile_pct}[{used_direction}]({threshold:.4f}%)"
                )

        post_values = [
            row.get(f"return_post_{minutes}_pct") for minutes in post_windows_for_max
        ]
        max_post = max(
            [abs(value) for value in post_values if value is not None],
            default=None,
        )
        surprise_abs = row.get("surprise_pct_abs")
        post_60 = row.get("return_post_60_pct")
        post_120 = row.get("return_post_120_pct")
        post_60_threshold, post_60_dir = _lookup_threshold_value(
            threshold_map, "return_post_60_pct", flag_quantile, direction
        )

        threshold_for_large_move = (
            post_60_threshold if post_60_threshold is not None else max_post
        )
        if (
            surprise_abs is not None
            and max_post is not None
            and surprise_abs < SURPRISE_NEAR_ZERO_PCT
            and threshold_for_large_move is not None
            and max_post >= threshold_for_large_move
        ):
            if post_60_threshold is not None:
                stage_d_used_dirs.add(post_60_dir)
            stage_d_reasons.append(
                "large post-event move with limited surprise_pct (requires news review)"
            )

        record["flag_stage_c"] = bool(stage_c_reasons)
        record["stage_c_reasons"] = "; ".join(stage_c_reasons)
        record["flag_stage_d"] = bool(stage_d_reasons)
        record["stage_d_reasons"] = "; ".join(stage_d_reasons)
        record["max_abs_post_return_pct"] = max_post
        record["abs_return_post_60_pct"] = abs(post_60) if post_60 is not None else None
        record["abs_return_post_120_pct"] = (
            abs(post_120) if post_120 is not None else None
        )
        pre_60 = row.get("return_pre_60_pct")
        record["abs_return_pre_60_pct"] = abs(pre_60) if pre_60 is not None else None
        record["requires_follow_up"] = record["flag_stage_c"] or record["flag_stage_d"]
        record["stage_c_windows_used"] = ",".join(str(m) for m in stage_c_minutes)
        record["stage_d_windows_used"] = ",".join(str(m) for m in stage_d_minutes)
        record["threshold_direction_stage_c"] = (
            ",".join(sorted(stage_c_used_dirs)) if stage_c_used_dirs else None
        )
        record["threshold_direction_stage_d"] = (
            ",".join(sorted(stage_d_used_dirs)) if stage_d_used_dirs else None
        )

        records.append(record)

    flags_df = pd.DataFrame(records)
    numeric_cols = flags_df.select_dtypes(include="number").columns
    flags_df[numeric_cols] = flags_df[numeric_cols].round(6)
    flags_df = flags_df.sort_values(
        by=["requires_follow_up", "event_time"], ascending=[False, True]
    ).reset_index(drop=True)
    return flags_df


def run_deepdive(
    config: DeepDiveConfig, alignment_df: Optional[pd.DataFrame] = None
) -> DeepDiveResult:
    df = _ensure_dataframe(config, alignment_df)
    heatmap = _build_heatmap_table(df, config.pre_windows, config.post_windows)
    thresholds = _build_threshold_table(df, config.quantiles)
    stage_c_window_map = {
        "all": tuple(config.stage_c_windows),
        "positive": tuple(config.stage_c_positive_windows),
        "negative": tuple(config.stage_c_negative_windows),
        "neutral": tuple(config.stage_c_windows),
    }
    stage_d_window_map = {
        "all": tuple(config.stage_d_windows),
        "positive": tuple(config.stage_d_positive_windows),
        "negative": tuple(config.stage_d_negative_windows),
        "neutral": tuple(config.stage_d_windows),
    }
    flags = _build_flag_table(
        df,
        thresholds,
        stage_c_window_map,
        stage_d_window_map,
        config.flag_quantile,
    )

    config.heatmap_output_parquet.parent.mkdir(parents=True, exist_ok=True)
    heatmap.to_parquet(config.heatmap_output_parquet, index=False)
    if config.heatmap_output_csv is not None:
        config.heatmap_output_csv.parent.mkdir(parents=True, exist_ok=True)
        heatmap.to_csv(config.heatmap_output_csv, index=False)

    config.thresholds_output_csv.parent.mkdir(parents=True, exist_ok=True)
    thresholds.to_csv(config.thresholds_output_csv, index=False)

    config.flags_output_parquet.parent.mkdir(parents=True, exist_ok=True)
    flags.to_parquet(config.flags_output_parquet, index=False)
    if config.flags_output_csv is not None:
        config.flags_output_csv.parent.mkdir(parents=True, exist_ok=True)
        flags.to_csv(config.flags_output_csv, index=False)

    print(
        "Saved Stage B deep-dive outputs -> "
        f"{config.heatmap_output_parquet}, {config.thresholds_output_csv}, {config.flags_output_parquet}"
    )
    return DeepDiveResult(heatmap=heatmap, thresholds=thresholds, flags=flags)


def parse_args() -> DeepDiveConfig:
    parser = argparse.ArgumentParser(
        description=(
            "Stage B deeper dive: aggregate event-price responses, derive thresholds "
            "and flag candidates for Stage C/D analysis."
        )
    )
    parser.add_argument(
        "--alignment-path",
        type=Path,
        default=DEFAULT_ALIGNMENT_PATH,
        help="Parquet file produced by event_price_alignment.py.",
    )
    parser.add_argument(
        "--heatmap-output-parquet",
        type=Path,
        default=DEFAULT_HEATMAP_PARQUET,
        help="Output parquet for the event response heatmap table.",
    )
    parser.add_argument(
        "--heatmap-output-csv",
        type=Path,
        default=DEFAULT_HEATMAP_CSV,
        help="Optional CSV output for the heatmap table.",
    )
    parser.add_argument(
        "--no-heatmap-csv",
        action="store_true",
        help="Skip writing the heatmap CSV file.",
    )
    parser.add_argument(
        "--thresholds-output-csv",
        type=Path,
        default=DEFAULT_THRESHOLDS_CSV,
        help="Output CSV for return thresholds.",
    )
    parser.add_argument(
        "--flags-output-parquet",
        type=Path,
        default=DEFAULT_FLAGS_PARQUET,
        help="Output parquet for Stage C/D follow-up flags.",
    )
    parser.add_argument(
        "--flags-output-csv",
        type=Path,
        default=DEFAULT_FLAGS_CSV,
        help="Optional CSV output for the flag table.",
    )
    parser.add_argument(
        "--no-flags-csv",
        action="store_true",
        help="Skip writing the flag CSV file.",
    )
    parser.add_argument(
        "--pre-windows",
        type=int,
        nargs="+",
        default=list(DEFAULT_PRE_WINDOWS),
        help="Pre-event windows (minutes) to include when aggregating.",
    )
    parser.add_argument(
        "--post-windows",
        type=int,
        nargs="+",
        default=list(DEFAULT_POST_WINDOWS),
        help="Post-event windows (minutes) to include when aggregating.",
    )
    parser.add_argument(
        "--stage-c-windows",
        type=int,
        nargs="+",
        default=list(DEFAULT_STAGE_C_WINDOWS),
        help="Post-event windows used to flag Stage C window analysis candidates.",
    )
    parser.add_argument(
        "--stage-c-windows-positive",
        type=int,
        nargs="+",
        help="Override Stage C windows for positive surprise events (falls back to --stage-c-windows when omitted).",
    )
    parser.add_argument(
        "--stage-c-windows-negative",
        type=int,
        nargs="+",
        help="Override Stage C windows for negative surprise events (falls back to --stage-c-windows when omitted).",
    )
    parser.add_argument(
        "--stage-d-windows",
        type=int,
        nargs="+",
        default=list(DEFAULT_STAGE_D_WINDOWS),
        help="Pre-event windows used to flag Stage D news cross-check candidates.",
    )
    parser.add_argument(
        "--stage-d-windows-positive",
        type=int,
        nargs="+",
        help="Override Stage D windows for positive surprise events.",
    )
    parser.add_argument(
        "--stage-d-windows-negative",
        type=int,
        nargs="+",
        help="Override Stage D windows for negative surprise events.",
    )
    parser.add_argument(
        "--quantiles",
        type=float,
        nargs="+",
        default=list(DEFAULT_QUANTILES),
        help="Quantiles for threshold derivation (e.g. 0.75 0.9).",
    )
    parser.add_argument(
        "--flag-quantile",
        type=float,
        default=DEFAULT_FLAG_QUANTILE,
        help="Quantile used when flagging Stage C/D follow-ups.",
    )

    args = parser.parse_args()
    return DeepDiveConfig(
        alignment_path=args.alignment_path,
        heatmap_output_parquet=args.heatmap_output_parquet,
        heatmap_output_csv=None if args.no_heatmap_csv else args.heatmap_output_csv,
        thresholds_output_csv=args.thresholds_output_csv,
        flags_output_parquet=args.flags_output_parquet,
        flags_output_csv=None if args.no_flags_csv else args.flags_output_csv,
        pre_windows=args.pre_windows,
        post_windows=args.post_windows,
        stage_c_windows=args.stage_c_windows,
        stage_c_positive_windows=args.stage_c_windows_positive,
        stage_c_negative_windows=args.stage_c_windows_negative,
        stage_d_windows=args.stage_d_windows,
        stage_d_positive_windows=args.stage_d_windows_positive,
        stage_d_negative_windows=args.stage_d_windows_negative,
        quantiles=args.quantiles,
        flag_quantile=args.flag_quantile,
    )


if __name__ == "__main__":
    config = parse_args()
    run_deepdive(config)
