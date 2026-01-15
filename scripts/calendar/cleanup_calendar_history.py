import argparse
import os
import sys
from pathlib import Path

import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from scripts.calendar import calendar_processing as processing  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Clean up historical Economic_Calendar exports without refetching."
    )
    parser.add_argument(
        "--start-year",
        type=int,
        help="First year (inclusive) to clean.",
    )
    parser.add_argument(
        "--end-year",
        type=int,
        help="Last year (inclusive) to clean.",
    )
    parser.add_argument(
        "--calendar-dir",
        type=str,
        default="",
        help="Calendar output directory (defaults to env CALENDAR_OUTPUT_DIR or data/Economic_Calendar).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report changes without rewriting files.",
    )
    return parser.parse_args()


def _load_year_df(year_dir: Path, year: int) -> pd.DataFrame | None:
    excel_path = year_dir / f"{year}_calendar.xlsx"
    csv_path = year_dir / f"{year}_calendar.csv"

    if excel_path.exists():
        return pd.read_excel(excel_path, sheet_name="Data")

    if csv_path.exists():
        return pd.read_csv(csv_path)

    return None


def _ensure_key_columns(df: pd.DataFrame) -> pd.DataFrame:
    required = [
        "Date",
        "Day",
        "Time",
        "Cur.",
        "Imp.",
        "Event",
        "Actual",
        "Forecast",
        "Previous",
    ]
    working = df.copy()
    for col in required:
        if col not in working.columns:
            working[col] = ""
    return working[required]


def clean_year(calendar_dir: Path, year: int, *, dry_run: bool) -> bool:
    year_dir = calendar_dir / str(year)
    if not year_dir.exists():
        print(f"[SKIP] Year directory missing: {year_dir}")
        return False

    existing_df = _load_year_df(year_dir, year)
    if existing_df is None or existing_df.empty:
        print(f"[SKIP] Year {year}: no data to clean.")
        return False

    existing_df = _ensure_key_columns(existing_df)
    merged = processing.merge_calendar_frames(
        existing_df, pd.DataFrame(columns=existing_df.columns)
    )

    before = len(existing_df)
    after = len(merged)
    changed = before != after or not existing_df.fillna("").astype(str).equals(
        merged.reindex(columns=existing_df.columns).fillna("").astype(str)
    )

    print(f"[INFO] Year {year}: rows {before} -> {after}, changed={changed}")
    if not changed or dry_run:
        return changed

    excel_path = year_dir / f"{year}_calendar.xlsx"
    processing.write_calendar_outputs(merged, excel_path)
    return True


def main() -> None:
    args = parse_args()
    calendar_dir_raw = (args.calendar_dir or "").strip()
    if not calendar_dir_raw:
        calendar_dir_raw = (os.getenv("CALENDAR_OUTPUT_DIR") or "").strip()
    if not calendar_dir_raw:
        calendar_dir = REPO_ROOT / "data" / "Economic_Calendar"
    else:
        calendar_dir = Path(calendar_dir_raw)
        if not calendar_dir.is_absolute():
            calendar_dir = REPO_ROOT / calendar_dir

    available_years: list[int] = []
    if calendar_dir.exists():
        for entry in calendar_dir.iterdir():
            if not entry.is_dir():
                continue
            if not entry.name.isdigit():
                continue
            available_years.append(int(entry.name))

    if not available_years:
        raise SystemExit(f"No year directories found under {calendar_dir}")

    start_year = (
        args.start_year if args.start_year is not None else min(available_years)
    )
    end_year = args.end_year if args.end_year is not None else max(available_years)
    if end_year < start_year:
        raise SystemExit("end-year must be >= start-year")

    print(f"[INFO] Cleaning year range: {start_year}..{end_year}")

    any_changed = False
    for year in range(start_year, end_year + 1):
        changed = clean_year(calendar_dir, year, dry_run=args.dry_run)
        any_changed = any_changed or changed

    if args.dry_run:
        print(f"[INFO] Dry-run complete. any_changed={any_changed}")
        return

    if any_changed:
        print("[SUCCESS] Cleanup complete.")
    else:
        print("[INFO] No changes needed.")


if __name__ == "__main__":
    main()
