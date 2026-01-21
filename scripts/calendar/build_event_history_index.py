from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

from app.agent.event_history import build_event_canonical_id  # noqa: E402


def _load_year_rows(year_dir: Path, year: int) -> list[dict]:
    json_path = year_dir / f"{year}_calendar.json"
    if json_path.exists():
        with json_path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
        return payload if isinstance(payload, list) else []

    csv_path = year_dir / f"{year}_calendar.csv"
    if csv_path.exists():
        with csv_path.open("r", encoding="utf-8") as handle:
            reader = csv.DictReader(handle)
            return list(reader)

    return []


def _safe_text(value: object) -> str:
    if value is None:
        return ""
    text = str(value)
    return text.strip()


def _iter_years(
    calendar_dir: Path, start_year: int | None, end_year: int | None
) -> list[int]:
    years: list[int] = []
    for entry in calendar_dir.iterdir():
        if not entry.is_dir():
            continue
        try:
            year = int(entry.name)
        except ValueError:
            continue
        if start_year is not None and year < start_year:
            continue
        if end_year is not None and year > end_year:
            continue
        years.append(year)
    return sorted(years)


def build_index(
    calendar_dir: Path, output_dir: Path, start_year: int | None, end_year: int | None
) -> int:
    if not calendar_dir.exists():
        raise SystemExit(f"Calendar directory not found: {calendar_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)

    years = _iter_years(calendar_dir, start_year, end_year)
    if not years:
        raise SystemExit("No calendar year folders found.")

    rows_written = 0
    for year in years:
        year_dir = calendar_dir / str(year)
        rows = _load_year_rows(year_dir, year)
        output_path = output_dir / f"{year}_event_history_index.csv"
        with output_path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(
                ["EventId", "Date", "Time", "Actual", "Forecast", "Previous"]
            )
            for row in rows:
                if not isinstance(row, dict):
                    continue
                event = _safe_text(row.get("Event"))
                if not event:
                    continue
                cur = _safe_text(row.get("Cur."))
                event_id, _identity = build_event_canonical_id(cur, event)
                writer.writerow(
                    [
                        event_id,
                        _safe_text(row.get("Date")),
                        _safe_text(row.get("Time")),
                        _safe_text(row.get("Actual")),
                        _safe_text(row.get("Forecast")),
                        _safe_text(row.get("Previous")),
                    ]
                )
                rows_written += 1
    return rows_written


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build per-year event history index files for quick lookups."
    )
    parser.add_argument(
        "--calendar-dir",
        type=str,
        default="",
        help="Calendar directory (defaults to data/Economic_Calendar).",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="",
        help="Output directory (defaults to data/event_history_index).",
    )
    parser.add_argument("--start-year", type=int, default=None)
    parser.add_argument("--end-year", type=int, default=None)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    calendar_dir = Path(args.calendar_dir) if args.calendar_dir else None
    if calendar_dir and not calendar_dir.is_absolute():
        calendar_dir = REPO_ROOT / calendar_dir
    if not calendar_dir:
        calendar_dir = REPO_ROOT / "data" / "Economic_Calendar"

    output_dir = Path(args.output_dir) if args.output_dir else None
    if output_dir and not output_dir.is_absolute():
        output_dir = REPO_ROOT / output_dir
    if not output_dir:
        output_dir = REPO_ROOT / "data" / "event_history_index"

    rows_written = build_index(calendar_dir, output_dir, args.start_year, args.end_year)
    print(f"[INFO] Wrote {rows_written} history rows into {output_dir}")


if __name__ == "__main__":
    main()
