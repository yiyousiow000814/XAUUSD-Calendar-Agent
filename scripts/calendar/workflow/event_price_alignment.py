"""Summarise price behaviour around economic events (Stage B: Event ↔ Price)."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Mapping, Optional

import pandas as pd

EPSILON = 1e-6
SHOCK_PERCENT_THRESHOLD = 0.25
SHOCK_ABS_THRESHOLD = 1e-6

BASE_OUTPUT_DIR = Path("data/calendar_outputs")
DEFAULT_MINUTES_DIR = BASE_OUTPUT_DIR / "minute_event_datasets"
DEFAULT_OUTPUT_PARQUET = (
    BASE_OUTPUT_DIR / "event_price_alignment/event_price_alignment.parquet"
)
DEFAULT_OUTPUT_CSV = BASE_OUTPUT_DIR / "event_price_alignment/event_price_alignment.csv"
IMPORTANT_LEVELS = {"Medium", "High"}
PRE_WINDOWS_DEFAULT = [1, 15, 60, 120, 240, 1440]
POST_WINDOWS_DEFAULT = [1, 15, 60, 120, 240, 1440]


@dataclass
class AlignmentConfig:
    minutes_dir: Optional[Path]
    output_parquet: Path
    output_csv: Optional[Path]
    start_year: int
    end_year: int
    pre_window: int
    post_window: int
    importance_levels: set[str]

    def __post_init__(self) -> None:
        if self.start_year > self.end_year:
            raise ValueError("start_year must be <= end_year")
        if self.minutes_dir is not None:
            self.minutes_dir = self.minutes_dir.expanduser().resolve()
        self.output_parquet = self.output_parquet.expanduser().resolve()
        if self.output_csv is not None:
            self.output_csv = self.output_csv.expanduser().resolve()

    @property
    def years(self) -> Iterable[int]:
        return range(self.start_year, self.end_year + 1)


def load_year(
    minutes_dir: Optional[Path],
    year: int,
    datasets_by_year: Optional[Mapping[int, pd.DataFrame]] = None,
) -> pd.DataFrame:
    if datasets_by_year is not None and year in datasets_by_year:
        df = datasets_by_year[year]
        if "event_id" not in df.columns:
            raise ValueError(f"In-memory dataset for {year} is missing event_id column")
        return df.copy()

    if minutes_dir is None:
        raise FileNotFoundError(
            f"Stage A dataset for {year} not available in memory and no minutes_dir set"
        )

    path = minutes_dir / str(year) / "xauusd_minutes_with_events.parquet"
    if not path.exists():
        raise FileNotFoundError(f"Stage A dataset not found: {path}")
    df = pd.read_parquet(path)
    if "event_id" not in df.columns:
        raise ValueError(f"Dataset {path} is missing required event columns")
    return df


def summarise_event(
    group: pd.DataFrame, pre_window: int, post_window: int
) -> pd.Series:
    group = group.sort_values("minutes_from_event").set_index("minutes_from_event")

    close_series = group["close"].astype(float)
    volume_series = group.get("tick_volume", pd.Series(dtype=float))

    info = group.iloc[0]
    summary = {
        "event_id": info["event_id"],
        "event_time": info["event_time"],
        "event_name": info["event_name"],
        "currency": info["currency"],
        "importance": info["importance"],
        "actual_value": info.get("actual_value"),
        "forecast_value": info.get("forecast_value"),
        "previous_value": info.get("previous_value"),
        "surprise": info.get("surprise"),
        "revision": info.get("revision"),
    }

    def get_price(offset: int, default: Optional[float] = None) -> Optional[float]:
        if offset in close_series.index:
            value = close_series.loc[offset]
            if isinstance(value, pd.Series):
                value = value.iloc[-1]
            return float(value)
        if default is not None:
            return default
        return None

    def compute_return(
        base: Optional[float], target: Optional[float]
    ) -> Optional[float]:
        if base in (None, 0) or target is None:
            return None
        return (target / base - 1.0) * 100.0

    def compute_vol(mask) -> Optional[float]:
        window = pct_change[mask].dropna()
        if window.empty:
            return None
        return float(window.std(ddof=0) * 100)

    def compute_volume(mask) -> Optional[float]:
        if volume_series.empty:
            return None
        window = volume_series[mask]
        if window.empty:
            return None
        return float(window.mean())

    def relative_pct(diff: Optional[float], base: Optional[float]) -> Optional[float]:
        if diff is None or base in (None, 0):
            return None
        if abs(base) < EPSILON:
            return None
        return float(diff / base * 100.0)

    def normalize(
        metric: Optional[float], shock: Optional[float], *, absolute: bool = False
    ) -> Optional[float]:
        if metric is None or shock in (None, 0):
            return None
        denominator = abs(shock) if absolute else shock
        if denominator == 0 or abs(denominator) < EPSILON:
            return None
        return float(metric / denominator)

    def categorize_shock(
        value: Optional[float], percent: Optional[float]
    ) -> Optional[str]:
        if percent is not None and not pd.isna(percent):
            metric = float(percent)
            threshold = SHOCK_PERCENT_THRESHOLD
        elif value is not None and not pd.isna(value):
            metric = float(value)
            threshold = SHOCK_ABS_THRESHOLD
        else:
            return None
        if abs(metric) < threshold:
            return "neutral"
        return "positive" if metric > 0 else "negative"

    price_at = get_price(0)
    summary["close_at"] = price_at
    pct_change = close_series.pct_change()

    pre_windows = sorted(set(PRE_WINDOWS_DEFAULT + [pre_window]))
    post_windows = sorted(set(POST_WINDOWS_DEFAULT + [post_window]))

    for minutes in pre_windows:
        price_pre = get_price(-minutes)
        summary[f"close_pre_{minutes}"] = price_pre
        summary[f"return_pre_{minutes}_pct"] = compute_return(price_pre, price_at)
        pre_mask = (pct_change.index < 0) & (pct_change.index >= -minutes)
        summary[f"volatility_pre_{minutes}_pct"] = compute_vol(pre_mask)
        summary[f"minutes_available_pre_{minutes}"] = int(
            ((close_series.index < 0) & (close_series.index >= -minutes)).sum()
        )
        summary[f"volume_pre_{minutes}_avg"] = compute_volume(
            (volume_series.index < 0) & (volume_series.index >= -minutes)
        )

    for minutes in post_windows:
        price_post = get_price(minutes)
        summary[f"close_post_{minutes}"] = price_post
        summary[f"return_post_{minutes}_pct"] = compute_return(price_at, price_post)
        post_mask = (pct_change.index > 0) & (pct_change.index <= minutes)
        summary[f"volatility_post_{minutes}_pct"] = compute_vol(post_mask)
        summary[f"minutes_available_post_{minutes}"] = int(
            ((close_series.index > 0) & (close_series.index <= minutes)).sum()
        )
        summary[f"volume_post_{minutes}_avg"] = compute_volume(
            (volume_series.index > 0) & (volume_series.index <= minutes)
        )

    price_before_event = summary.get("close_pre_1")
    if price_at is not None and price_before_event is not None:
        return_at = compute_return(price_before_event, price_at)
    else:
        return_at = None
    summary["return_at_pct"] = return_at
    summary["return_at_abs_pct"] = abs(return_at) if return_at is not None else None
    summary["volatility_at_pct"] = summary["return_at_abs_pct"]

    if 0 in volume_series.index:
        volume_at = volume_series.loc[0]
        if isinstance(volume_at, pd.Series):
            volume_at = volume_at.iloc[-1]
        summary["volume_at_avg"] = float(volume_at)
    else:
        summary["volume_at_avg"] = None

    summary["minutes_available_at"] = int((close_series.index == 0).sum())

    summary["close_pre_window"] = summary.get(f"close_pre_{pre_window}")
    summary["close_post_window"] = summary.get(f"close_post_{post_window}")
    summary["return_pre_pct"] = summary.get(f"return_pre_{pre_window}_pct")
    summary["return_post_pct"] = summary.get(f"return_post_{post_window}_pct")
    summary["volatility_pre_pct"] = summary.get(f"volatility_pre_{pre_window}_pct")
    summary["volatility_post_pct"] = summary.get(f"volatility_post_{post_window}_pct")
    summary["volume_pre_avg"] = summary.get(f"volume_pre_{pre_window}_avg")
    summary["volume_post_avg"] = summary.get(f"volume_post_{post_window}_avg")
    summary["minutes_available_pre"] = summary.get(
        f"minutes_available_pre_{pre_window}"
    )
    summary["minutes_available_post"] = summary.get(
        f"minutes_available_post_{post_window}"
    )

    joint_cols = [
        "joint_event_group_id",
        "joint_event_group_size",
        "joint_event_group_rank",
        "joint_event_group_weight",
        "joint_event_group_event_ids",
        "joint_event_group_event_names",
    ]
    for col in joint_cols:
        if col in group.columns:
            non_null = group[col].dropna()
            summary[col] = non_null.iloc[0] if not non_null.empty else None
        else:
            summary[col] = None

    size = summary.get("joint_event_group_size")
    if size is not None and not pd.isna(size):
        try:
            summary["joint_event_group_size"] = int(size)
        except (TypeError, ValueError):
            summary["joint_event_group_size"] = None
    weight = summary.get("joint_event_group_weight")
    if weight is None or pd.isna(weight):
        size_val = summary.get("joint_event_group_size")
        if size_val:
            weight = 1.0 / size_val
    summary["joint_event_group_weight"] = weight
    summary["joint_event_is_shared"] = (
        summary.get("joint_event_group_size") is not None
        and summary.get("joint_event_group_size") > 1
    )

    surprise_value = summary.get("surprise")
    revision_value = summary.get("revision")
    forecast_value = summary.get("forecast_value")
    previous_value = summary.get("previous_value")
    forecast_minus_previous = None
    if forecast_value is not None and previous_value is not None:
        forecast_minus_previous = float(forecast_value - previous_value)
    summary["forecast_minus_previous"] = forecast_minus_previous

    surprise_pct = relative_pct(surprise_value, forecast_value)
    revision_pct = relative_pct(revision_value, previous_value)
    forecast_minus_previous_pct = relative_pct(forecast_minus_previous, previous_value)

    summary["surprise_abs"] = (
        abs(surprise_value) if surprise_value is not None else None
    )
    summary["revision_abs"] = (
        abs(revision_value) if revision_value is not None else None
    )
    summary["forecast_minus_previous_abs"] = (
        abs(forecast_minus_previous) if forecast_minus_previous is not None else None
    )

    summary["surprise_pct"] = surprise_pct
    summary["revision_pct"] = revision_pct
    summary["forecast_minus_previous_pct"] = forecast_minus_previous_pct
    summary["surprise_pct_abs"] = (
        abs(surprise_pct) if surprise_pct is not None else None
    )
    summary["revision_pct_abs"] = (
        abs(revision_pct) if revision_pct is not None else None
    )
    summary["forecast_minus_previous_pct_abs"] = (
        abs(forecast_minus_previous_pct)
        if forecast_minus_previous_pct is not None
        else None
    )

    surprise_category = categorize_shock(surprise_value, surprise_pct)
    revision_category = categorize_shock(revision_value, revision_pct)
    forecast_prev_category = categorize_shock(
        forecast_minus_previous, forecast_minus_previous_pct
    )

    summary["surprise_category"] = surprise_category
    summary["revision_category"] = revision_category
    summary["forecast_prev_category"] = forecast_prev_category

    if forecast_prev_category and surprise_category:
        summary["scenario_expectation_vs_actual"] = (
            f"{forecast_prev_category}->{surprise_category}"
        )
    else:
        summary["scenario_expectation_vs_actual"] = None

    summary["scenario_actual_vs_previous"] = revision_category

    stage_returns = {
        "pre": summary.get("return_pre_pct"),
        "at": summary.get("return_at_pct"),
        "post": summary.get("return_post_pct"),
    }
    stage_vols = {
        "pre": summary.get("volatility_pre_pct"),
        "at": summary.get("volatility_at_pct"),
        "post": summary.get("volatility_post_pct"),
    }

    summary.setdefault("return_at_pct_share", None)
    summary.setdefault("return_post_pct_share", None)

    weight_val = summary.get("joint_event_group_weight")
    if weight_val is not None and not pd.isna(weight_val):
        for stage in ("at", "post"):
            stage_value = stage_returns.get(stage)
            if stage_value is not None:
                summary[f"return_{stage}_pct_share"] = stage_value * weight_val

    for stage, value in stage_returns.items():
        summary[f"return_{stage}_pct_per_surprise"] = normalize(value, surprise_pct)
        summary[f"return_{stage}_pct_per_revision"] = normalize(value, revision_pct)
        summary[f"return_{stage}_pct_per_forecast_prev"] = normalize(
            value, forecast_minus_previous_pct
        )
        summary[f"return_{stage}_pct_per_abs_surprise"] = normalize(
            value, surprise_pct, absolute=True
        )
        summary[f"return_{stage}_pct_per_abs_revision"] = normalize(
            value, revision_pct, absolute=True
        )

    for stage, value in stage_vols.items():
        summary[f"volatility_{stage}_pct_per_abs_surprise"] = normalize(
            value, surprise_pct, absolute=True
        )
        summary[f"volatility_{stage}_pct_per_abs_revision"] = normalize(
            value, revision_pct, absolute=True
        )

    return pd.Series(summary)


def process_year(df: pd.DataFrame, config: AlignmentConfig) -> pd.DataFrame:
    events = df[df["event_id"].notna()].copy()
    events["importance"] = events["importance"].astype(str).str.title()
    events = events[events["importance"].isin(config.importance_levels)]

    if events.empty:
        return pd.DataFrame()

    grouped = events.groupby("event_id", sort=False)
    rows = [
        summarise_event(group, config.pre_window, config.post_window)
        for _, group in grouped
    ]
    return pd.DataFrame(rows)


def run_alignment(
    config: AlignmentConfig,
    *,
    datasets_by_year: Optional[Mapping[int, pd.DataFrame]] = None,
) -> pd.DataFrame:
    frames: list[pd.DataFrame] = []
    for year in config.years:
        try:
            df_year = load_year(config.minutes_dir, year, datasets_by_year)
        except FileNotFoundError as exc:
            print(f"[WARN] {exc}")
            continue
        result = process_year(df_year, config)
        if result.empty:
            print(f"[INFO] No matching events for {year}")
            continue
        result["year"] = year
        frames.append(result)

    if not frames:
        raise SystemExit("No event-price alignment results produced.")

    combined = pd.concat(frames, ignore_index=True)
    combined = combined.sort_values(["event_time", "event_id"]).reset_index(drop=True)

    config.output_parquet.parent.mkdir(parents=True, exist_ok=True)
    combined.to_parquet(config.output_parquet, index=False)
    if config.output_csv is not None:
        config.output_csv.parent.mkdir(parents=True, exist_ok=True)
        combined.to_csv(config.output_csv, index=False)

    print(
        f"Saved event/price alignment summary with {len(combined)} rows -> {config.output_parquet}"
    )
    if config.output_csv is not None:
        print(f"  • CSV sample: {config.output_csv}")

    return combined


def parse_args() -> AlignmentConfig:
    parser = argparse.ArgumentParser(
        description="Summarise price behaviour around Medium/High economic events."
    )
    parser.add_argument(
        "--minutes-dir",
        type=Path,
        default=DEFAULT_MINUTES_DIR,
        help="Directory containing Stage A minute-event datasets.",
    )
    parser.add_argument(
        "--output-parquet",
        type=Path,
        default=DEFAULT_OUTPUT_PARQUET,
        help="Parquet file path for aggregated metrics.",
    )
    parser.add_argument(
        "--output-csv",
        type=Path,
        default=DEFAULT_OUTPUT_CSV,
        help="Optional CSV export path (omit via --no-csv).",
    )
    parser.add_argument("--no-csv", action="store_true", help="Skip CSV export.")
    parser.add_argument("--start-year", type=int, default=2020)
    parser.add_argument("--end-year", type=int, default=2020)
    parser.add_argument("--pre-window", type=int, default=1440)
    parser.add_argument("--post-window", type=int, default=1440)
    parser.add_argument(
        "--importance",
        nargs="*",
        default=list(IMPORTANT_LEVELS),
        help="Importance levels to include (default: Medium High).",
    )

    args = parser.parse_args()
    return AlignmentConfig(
        minutes_dir=args.minutes_dir,
        output_parquet=args.output_parquet,
        output_csv=None if args.no_csv else args.output_csv,
        start_year=args.start_year,
        end_year=args.end_year,
        pre_window=args.pre_window,
        post_window=args.post_window,
        importance_levels={level.title() for level in args.importance},
    )


if __name__ == "__main__":
    cfg = parse_args()
    run_alignment(cfg)
