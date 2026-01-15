import argparse
import json
import os
import sys
from pathlib import Path

import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from scripts.calendar import calendar_processing as processing  # noqa: E402

_REQUIRED_COLUMNS = [
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
_VALUE_COLUMNS = {"Actual", "Forecast", "Previous"}


def _canonicalize_token(value: object) -> object:
    """Canonicalize a scalar for JSON comparison.

    - Key-ish fields are kept as strings (missing -> "").
    - Value fields (Actual/Forecast/Previous) treat ""/NA/placeholders as missing (-> None).

    This lets the cleanup detect JSON-only drift such as "" vs null even when the
    Excel/CSV representation is already normalized.
    """
    if value is None:
        return None
    if isinstance(value, float) and pd.isna(value):
        return None
    if isinstance(value, (int, float)):
        if float(value).is_integer():
            return str(int(value))
        return format(float(value), "g")
    text = str(value).strip()
    if not text:
        return None
    if text.lower() in processing.MISSING_VALUE_TOKENS:
        return None
    return text


def _canonicalize_row(row: dict) -> dict:
    out: dict[str, object] = {}
    for col in _REQUIRED_COLUMNS:
        val = row.get(col, "")
        if col in _VALUE_COLUMNS:
            out[col] = _canonicalize_token(val)
        else:
            out[col] = (
                ""
                if val is None or (isinstance(val, float) and pd.isna(val))
                else str(val).strip()
            )
    return out


def _canonicalize_json_payload(payload: object) -> list[dict]:
    if not isinstance(payload, list):
        return []
    rows: list[dict] = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        rows.append(_canonicalize_row(item))
    return rows


def _json_has_noncanonical_missing(payload: object) -> bool:
    """Return True when existing JSON encodes missing values as ""/placeholders.

    Even if Excel/CSV re-reads treat these as missing, we want cleanup to rewrite
    exports so the JSON is stable (missing -> null).
    """
    if not isinstance(payload, list):
        return False
    for item in payload:
        if not isinstance(item, dict):
            continue
        for col in _VALUE_COLUMNS:
            raw = item.get(col)
            if raw is None:
                continue
            text = str(raw).strip()
            if not text:
                return True
            if text.lower() in processing.MISSING_VALUE_TOKENS:
                return True
    return False


def _canonicalize_df(df: pd.DataFrame) -> list[dict]:
    working = df.copy()
    for col in _REQUIRED_COLUMNS:
        if col not in working.columns:
            working[col] = "" if col not in _VALUE_COLUMNS else pd.NA
    working = working[_REQUIRED_COLUMNS]
    rows: list[dict] = []
    for record in working.to_dict(orient="records"):
        rows.append(_canonicalize_row(record))
    return rows


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
    working = df.copy()
    for col in _REQUIRED_COLUMNS:
        if col not in working.columns:
            working[col] = ""
    return working[_REQUIRED_COLUMNS]


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

    # Detect JSON-only drift such as "" vs null in value fields.
    json_path = year_dir / f"{year}_calendar.json"
    if not changed and json_path.exists():
        try:
            payload = json.loads(json_path.read_text(encoding="utf-8"))
        except Exception:
            payload = None
        changed = changed or _json_has_noncanonical_missing(payload)
        if not changed:
            existing_json = _canonicalize_json_payload(payload)
            merged_json = _canonicalize_df(merged)
            changed = changed or (existing_json != merged_json)

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
