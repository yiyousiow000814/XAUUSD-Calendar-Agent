"""Build minute-level datasets by merging price data with economic events.

Stage A of the roadmap ("Price × Event Integration Pipeline") needs a reproducible way to align
XAUUSD minute-level prices and the economic calendar. This script loads minute-level price data
(default: UTC+8) and yearly economic calendar data, then generates one merged feature set per year
for downstream steps such as window decomposition, event attribution, and news integration

Example::

    python scripts/calendar/workflow/calendar_price_pipeline.py \
        --price-path data/XAUUSD_1m_data/preprocessed_minutes.parquet \
        --calendar-dir data/Economic_Calendar \
        --output-dir data/calendar_outputs/minute_event_datasets \
        --start-year 2020 --end-year 2020 \
        --currencies USD --importance Medium High \
        --pre-window 1440 --post-window 1440

The output directory is written per year (use `--no-parquet` / `--csv` / `--no-xlsx` to control outputs;
CSV is disabled by default):

- `data/calendar_outputs/minute_event_datasets/<year>/xauusd_minutes_with_events.parquet`
- Same-name `.csv` / `.xlsx`
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional, Sequence

import pandas as pd

TZ_NAME = "Asia/Shanghai"
TIME_COLUMNS = {"Date", "Time"}
IGNORED_TIMES = {"All Day", "Tentative", None, ""}


def _derive_joint_event_metadata(event_df: pd.DataFrame) -> pd.DataFrame:
    """Build per-event metadata describing simultaneous releases."""

    if event_df.empty or "event_id" not in event_df.columns:
        return pd.DataFrame(
            columns=[
                "event_id",
                "joint_event_group_id",
                "joint_event_group_size",
                "joint_event_group_rank",
                "joint_event_group_weight",
                "joint_event_group_event_ids",
                "joint_event_group_event_names",
            ]
        )

    required = {"event_id", "event_time", "event_name", "minutes_from_event"}
    missing = required - set(event_df.columns)
    if missing:
        raise ValueError(f"Event dataframe missing required columns: {missing}")

    reference_rows = event_df[event_df["minutes_from_event"] == 0][
        ["event_id", "event_time", "event_name"]
    ]
    if reference_rows.empty:
        return pd.DataFrame(
            columns=[
                "event_id",
                "joint_event_group_id",
                "joint_event_group_size",
                "joint_event_group_rank",
                "joint_event_group_weight",
                "joint_event_group_event_ids",
                "joint_event_group_event_names",
            ]
        )

    records: list[dict[str, object]] = []
    for event_time, group in reference_rows.groupby("event_time"):
        group_sorted = group.sort_values("event_name")
        event_ids = tuple(group_sorted["event_id"].astype(str))
        event_names = tuple(group_sorted["event_name"].astype(str))
        group_size = len(event_ids)
        weight = 1.0 / group_size if group_size else float("nan")
        group_id = f"{event_time.isoformat()}__{'|'.join(event_ids)}"

        for rank, (event_id, event_name) in enumerate(
            zip(event_ids, event_names), start=1
        ):
            records.append(
                {
                    "event_id": event_id,
                    "joint_event_group_id": group_id,
                    "joint_event_group_size": group_size,
                    "joint_event_group_rank": rank,
                    "joint_event_group_weight": weight,
                    "joint_event_group_event_ids": ";".join(event_ids),
                    "joint_event_group_event_names": ";".join(event_names),
                }
            )

    return pd.DataFrame.from_records(records)


@dataclass
class CalendarPriceConfig:
    """Configuration container for the merge pipeline."""

    price_path: Path
    calendar_dir: Path
    output_dir: Path
    start_year: int
    end_year: int
    pre_window: int = 60
    post_window: int = 60
    currencies: tuple[str, ...] = ("USD",)
    importance_levels: tuple[str, ...] = ("Medium", "High")
    write_parquet: bool = True
    write_csv: bool = False
    write_xlsx: bool = True

    def __post_init__(self) -> None:
        self.price_path = Path(self.price_path)
        self.calendar_dir = Path(self.calendar_dir)
        self.output_dir = Path(self.output_dir)
        if self.start_year > self.end_year:
            raise ValueError("start_year must be <= end_year")
        self.currencies = tuple(
            cur.upper() for cur in self.currencies if cur and cur.upper() != "ALL"
        ) or ("ALL",)
        self.importance_levels = tuple(
            level.title() for level in self.importance_levels
        )


@dataclass
class PipelineResult:
    """Return value for :func:`run_pipeline`."""

    generated_paths: list[Path]
    datasets_by_year: Dict[int, pd.DataFrame]


def _load_price_minutes(price_path: Path) -> pd.DataFrame:
    """Load minute-level price data and ensure timestamps are tz-aware."""

    if price_path.suffix == ".parquet":
        df = pd.read_parquet(price_path)
    else:
        df = pd.read_csv(price_path)
    if "timestamp" not in df.columns:
        raise ValueError("Price data must contain a 'timestamp' column")
    ts = pd.to_datetime(df["timestamp"], errors="coerce")
    if ts.isna().any():
        raise ValueError("Found invalid timestamps in price data")
    if ts.dt.tz is None:
        ts = ts.dt.tz_localize(TZ_NAME)
    else:
        ts = ts.dt.tz_convert(TZ_NAME)
    df["timestamp"] = ts
    df = df.sort_values("timestamp").reset_index(drop=True)
    return df


def _read_calendar_file(path: Path) -> pd.DataFrame:
    """Load a yearly economic calendar file into a DataFrame."""

    if not path.exists():
        raise FileNotFoundError(path)
    if path.suffix == ".json":
        with path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        df = pd.DataFrame(data)
    elif path.suffix == ".csv":
        df = pd.read_csv(path)
    else:
        raise ValueError(f"Unsupported calendar file format: {path.suffix}")
    missing_cols = TIME_COLUMNS - set(df.columns)
    if missing_cols:
        raise ValueError(f"Calendar file missing columns: {missing_cols}")
    return df


def _slugify(text: str) -> str:
    slug = re.sub(r"[^0-9A-Za-z]+", "-", text.strip())
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug.lower()


def _parse_numeric(value: Optional[str]) -> Optional[float]:
    if value is None:
        return None
    value = str(value).strip()
    if not value or value in {"-", "N/A", "n/a"}:
        return None
    multiplier = 1.0
    if value.endswith("%"):
        multiplier = 0.01
        value = value[:-1]
    suffix_multiplier = {"k": 1_000, "m": 1_000_000, "b": 1_000_000_000}
    if value and value[-1].lower() in suffix_multiplier:
        multiplier *= suffix_multiplier[value[-1].lower()]
        value = value[:-1]
    value = value.replace(",", "")
    try:
        return float(value) * multiplier
    except ValueError:
        return None


def _event_timestamp(date_str: str, time_str: str) -> Optional[pd.Timestamp]:
    if time_str in IGNORED_TIMES:
        return None
    match = re.match(r"^(\d{2}):(\d{2})", time_str)
    if not match:
        return None
    timestamp = pd.Timestamp(f"{date_str} {match.group(0)}", tz=TZ_NAME)
    return timestamp


def build_calendar_features(
    calendar_path: Path,
    *,
    importance: Sequence[str],
    currencies: Sequence[str],
    pre_window: int,
    post_window: int,
    window_start: pd.Timestamp,
    window_end: pd.Timestamp,
) -> pd.DataFrame:
    """Expand a calendar file into minute-level event labels."""

    calendar_df = _read_calendar_file(calendar_path)
    renamed = calendar_df.rename(
        columns={
            "Cur.": "currency",
            "Imp.": "importance",
            "Event": "event_name",
            "Actual": "actual_raw",
            "Forecast": "forecast_raw",
            "Previous": "previous_raw",
        }
    )
    renamed["importance"] = renamed["importance"].fillna("").str.title()
    renamed["currency"] = renamed["currency"].fillna("").str.upper()

    if currencies and currencies != ("ALL",):
        renamed = renamed[renamed["currency"].isin(currencies)]
    if importance:
        renamed = renamed[renamed["importance"].isin(importance)]

    event_rows: list[dict[str, object]] = []
    window_min = window_start - pd.Timedelta(minutes=pre_window)
    window_max = window_end + pd.Timedelta(minutes=post_window)

    for row in renamed.itertuples(index=False):
        event_ts = _event_timestamp(row.Date, row.Time)
        if event_ts is None:
            continue
        if event_ts < window_min or event_ts > window_max:
            continue
        actual_val = _parse_numeric(getattr(row, "actual_raw", None))
        forecast_val = _parse_numeric(getattr(row, "forecast_raw", None))
        previous_val = _parse_numeric(getattr(row, "previous_raw", None))
        surprise = (
            actual_val - forecast_val
            if actual_val is not None and forecast_val is not None
            else None
        )
        revision = (
            actual_val - previous_val
            if actual_val is not None and previous_val is not None
            else None
        )
        event_id = f"{event_ts.strftime('%Y%m%d%H%M')}_{_slugify(row.event_name)}"
        window = pd.date_range(
            event_ts - pd.Timedelta(minutes=pre_window),
            event_ts + pd.Timedelta(minutes=post_window),
            freq="min",
        )
        for ts in window:
            stage = "pre"
            offset = int((ts - event_ts).total_seconds() // 60)
            if offset == 0:
                stage = "at"
            elif offset > 0:
                stage = "post"
            event_rows.append(
                {
                    "timestamp": ts,
                    "event_id": event_id,
                    "event_stage": stage,
                    "minutes_from_event": offset,
                    "event_time": event_ts,
                    "event_name": row.event_name,
                    "currency": row.currency,
                    "importance": row.importance,
                    "actual_value": actual_val,
                    "forecast_value": forecast_val,
                    "previous_value": previous_val,
                    "surprise": surprise,
                    "revision": revision,
                }
            )

    if not event_rows:
        return pd.DataFrame(
            columns=[
                "timestamp",
                "event_id",
                "event_stage",
                "minutes_from_event",
                "event_time",
                "event_name",
                "currency",
                "importance",
                "actual_value",
                "forecast_value",
                "previous_value",
                "surprise",
                "revision",
            ]
        )

    event_df = pd.DataFrame(event_rows)
    timestamps = pd.to_datetime(
        event_df["timestamp"]
    )  # already tz-aware from date_range
    if timestamps.dt.tz is None:
        timestamps = timestamps.dt.tz_localize(TZ_NAME)
    event_df["timestamp"] = timestamps
    return event_df


def _prepare_dataframe_for_export(df: pd.DataFrame) -> pd.DataFrame:
    """Return a copy with timezone-aware datetimes converted for file exports."""

    export_df = df.copy(deep=False)
    time_columns = [
        col for col in ("timestamp", "event_time") if col in export_df.columns
    ]
    for col in time_columns:
        if pd.api.types.is_datetime64_any_dtype(export_df[col]):
            series = export_df[col]
            if getattr(series.dt, "tz", None) is not None:
                export_df[col] = series.dt.tz_convert(None)
    return export_df


def merge_price_and_events(
    price_df: pd.DataFrame, event_df: pd.DataFrame
) -> pd.DataFrame:
    """Align price minutes with event annotations."""

    if event_df.empty:
        merged = price_df.copy()
        merged["event_id"] = pd.NA
        merged["event_stage"] = pd.NA
        merged["minutes_from_event"] = pd.NA
        merged["event_time"] = pd.NaT
        merged["event_name"] = pd.NA
        merged["currency"] = pd.NA
        merged["importance"] = pd.NA
        merged["actual_value"] = pd.NA
        merged["forecast_value"] = pd.NA
        merged["previous_value"] = pd.NA
        merged["surprise"] = pd.NA
        merged["revision"] = pd.NA
        merged["event_count"] = 0
        merged["has_event"] = False
        return merged

    merged = price_df.merge(event_df, on="timestamp", how="left")
    event_count = (
        event_df.groupby("timestamp")["event_id"].nunique().rename("event_count")
    )
    merged = merged.merge(event_count, on="timestamp", how="left")
    merged["event_count"] = merged["event_count"].fillna(0).astype(int)
    merged["has_event"] = merged["event_id"].notna()

    joint_meta = _derive_joint_event_metadata(event_df)
    joint_columns = [
        "joint_event_group_id",
        "joint_event_group_size",
        "joint_event_group_rank",
        "joint_event_group_weight",
        "joint_event_group_event_ids",
        "joint_event_group_event_names",
    ]
    if not joint_meta.empty:
        merged = merged.merge(joint_meta, on="event_id", how="left")
    else:
        for col in joint_columns:
            merged[col] = pd.NA

    return merged.sort_values("timestamp").reset_index(drop=True)


def _calendar_file_for_year(calendar_dir: Path, year: int) -> Optional[Path]:
    base = calendar_dir / str(year) / f"{year}_calendar"
    for ext in (".json", ".csv"):
        candidate = base.with_suffix(ext)
        if candidate.exists():
            return candidate
    return None


def run_pipeline(config: CalendarPriceConfig) -> PipelineResult:
    """Execute the pipeline and return written paths plus in-memory datasets."""

    price_df = _load_price_minutes(config.price_path)

    output_paths: list[Path] = []
    datasets_by_year: Dict[int, pd.DataFrame] = {}
    total_minutes = 0
    total_events = 0

    persist_outputs = config.write_parquet or config.write_csv or config.write_xlsx

    for year in range(config.start_year, config.end_year + 1):
        calendar_file = _calendar_file_for_year(config.calendar_dir, year)
        if calendar_file is None:
            print(f"[warn] calendar file missing for {year}")
            continue

        year_start = pd.Timestamp(f"{year}-01-01 00:00", tz=TZ_NAME)
        year_end = pd.Timestamp(f"{year}-12-31 23:59", tz=TZ_NAME)
        price_window_start = year_start - pd.Timedelta(minutes=config.pre_window)
        price_window_end = year_end + pd.Timedelta(minutes=config.post_window)

        price_mask = (price_df["timestamp"] >= price_window_start) & (
            price_df["timestamp"] <= price_window_end
        )
        if not price_mask.any():
            print(f"[warn] price data missing for {year}")
            continue

        price_slice = price_df.loc[price_mask].reset_index(drop=True)
        events_df = build_calendar_features(
            calendar_file,
            importance=config.importance_levels,
            currencies=config.currencies,
            pre_window=config.pre_window,
            post_window=config.post_window,
            window_start=year_start,
            window_end=year_end,
        )

        merged = merge_price_and_events(price_slice, events_df)
        datasets_by_year[year] = merged

        total_minutes += len(price_slice)
        total_events += events_df["event_id"].nunique() if not events_df.empty else 0

        if not persist_outputs:
            continue

        year_dir = config.output_dir / str(year)
        year_dir.mkdir(parents=True, exist_ok=True)

        if config.write_parquet:
            parquet_path = year_dir / "xauusd_minutes_with_events.parquet"
            merged.to_parquet(parquet_path, index=False)
            output_paths.append(parquet_path)

        if config.write_csv or config.write_xlsx:
            export_df = _prepare_dataframe_for_export(merged)

            if config.write_csv:
                csv_path = year_dir / "xauusd_minutes_with_events.csv"
                export_df.to_csv(csv_path, index=False)
                output_paths.append(csv_path)

            if config.write_xlsx:
                sample_df = export_df.head(5000).reset_index(drop=True)
                xlsx_path = year_dir / "xauusd_minutes_with_events_sample.xlsx"
                sample_df.to_excel(xlsx_path, index=False)
                output_paths.append(xlsx_path)

    if output_paths:
        print(
            "Generated feature sets covering {years} -> {out}".format(
                years=f"{config.start_year}-{config.end_year}",
                out=config.output_dir,
            )
        )
        for path_out in output_paths:
            print(f"  • {path_out}")
    else:
        print(
            "Processed {years} entirely in memory without writing Stage A outputs.".format(
                years=f"{config.start_year}-{config.end_year}"
            )
        )

    print(f"Total minutes processed: {total_minutes:,}")
    print(f"Total unique events: {total_events:,}")

    if not output_paths and not datasets_by_year:
        raise SystemExit("No datasets were produced; check calendar/price coverage.")

    return PipelineResult(
        generated_paths=output_paths, datasets_by_year=datasets_by_year
    )


def _parse_args(argv: Optional[Sequence[str]] = None) -> CalendarPriceConfig:
    parser = argparse.ArgumentParser(
        description="Build minute-level features by merging price data and economic calendar events.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--price-path",
        type=Path,
        required=True,
        help="Path to the minute-level price file (Parquet or CSV).",
    )
    parser.add_argument(
        "--calendar-dir",
        type=Path,
        required=True,
        help="Directory containing yearly calendar exports.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="Directory where per-year merged datasets will be written.",
    )
    parser.add_argument("--start-year", type=int, default=2020)
    parser.add_argument("--end-year", type=int, default=2020)
    parser.add_argument(
        "--pre-window",
        type=int,
        default=1440,
        help="Minutes to include before the event timestamp.",
    )
    parser.add_argument(
        "--post-window",
        type=int,
        default=1440,
        help="Minutes to include after the event timestamp.",
    )
    parser.add_argument(
        "--currencies",
        nargs="*",
        default=("USD",),
        help="Currencies to retain (ALL keeps everything).",
    )
    parser.add_argument(
        "--importance",
        nargs="*",
        default=("Medium", "High"),
        help="Importance levels to retain.",
    )
    parser.add_argument(
        "--no-parquet", action="store_true", help="Skip writing per-year parquet files."
    )
    parser.add_argument(
        "--csv",
        action="store_true",
        help="Write per-year CSV files alongside the parquet outputs.",
    )
    parser.add_argument(
        "--no-csv",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--no-xlsx", action="store_true", help="Skip writing per-year XLSX samples."
    )
    args = parser.parse_args(argv)
    return CalendarPriceConfig(
        price_path=args.price_path,
        calendar_dir=args.calendar_dir,
        output_dir=args.output_dir,
        start_year=args.start_year,
        end_year=args.end_year,
        pre_window=args.pre_window,
        post_window=args.post_window,
        currencies=tuple(args.currencies),
        importance_levels=tuple(args.importance),
        write_parquet=not args.no_parquet,
        write_csv=args.csv and not args.no_csv,
        write_xlsx=not args.no_xlsx,
    )


def main(argv: Optional[Sequence[str]] = None) -> None:
    config = _parse_args(argv)
    run_pipeline(config)


if __name__ == "__main__":
    main()
