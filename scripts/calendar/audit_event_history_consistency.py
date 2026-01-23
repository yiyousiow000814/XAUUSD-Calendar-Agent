from __future__ import annotations

import argparse
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

# isort: off
import build_event_history_index as history_index  # noqa: E402

# isort: on


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Audit event history consistency and generate patch/issue reports "
            "without rewriting the index files."
        )
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
        calendar_dir = history_index.REPO_ROOT / calendar_dir
    if not calendar_dir:
        calendar_dir = history_index.REPO_ROOT / "data" / "Economic_Calendar"

    output_dir = Path(args.output_dir) if args.output_dir else None
    if output_dir and not output_dir.is_absolute():
        output_dir = history_index.REPO_ROOT / output_dir
    if not output_dir:
        output_dir = history_index.REPO_ROOT / "data" / "event_history_index"

    rows_written, issue_count, patch_count = history_index.build_index(
        calendar_dir, output_dir, args.start_year, args.end_year, write_index=False
    )
    print(f"[INFO] Audited {rows_written} history rows in {calendar_dir}")
    print(f"[INFO] Wrote {issue_count} issues into {output_dir}")
    print(f"[INFO] Wrote {patch_count} patches into {output_dir}")


if __name__ == "__main__":
    main()
