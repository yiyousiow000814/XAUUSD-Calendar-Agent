from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Final

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT))

# isort: off
from app.agent.event_history import build_event_canonical_id  # noqa: E402

# isort: on

_MISSING_TOKENS = {"", "--", "-", "\u2014", "tba", "n/a", "na", "null"}
_AUTO_PREVIOUS_FILL_PATCH: Final[str] = "previous_missing_filled"
_MANUAL_OVERRIDE_PATCH: Final[str] = "manual_override"
_DEFAULT_MANUAL_PATCH_FILENAME: Final[str] = "event_history_manual_patch.csv"
_BY_EVENT_NDJSON_FILENAME: Final[str] = "event_history_by_event.ndjson"
_BY_EVENT_INDEX_FILENAME: Final[str] = "event_history_by_event.index.json"
_CLEAN_CSV_FILENAME: Final[str] = "event_history_clean.csv"
_MANUAL_APPLIED_CSV_FILENAME: Final[str] = "event_history_manual_patch_applied.csv"
_MANUAL_APPLIED_JSON_FILENAME: Final[str] = "event_history_manual_patch_applied.json"


@dataclass
class HistoryRow:
    year: int
    event_id: str
    cur: str
    event: str
    date: str
    time: str
    actual: str
    forecast: str
    previous_raw: str
    previous_effective: str
    sort_key: datetime
    manual_override_actual: bool = False
    manual_override_forecast: bool = False
    manual_override_previous: bool = False


def _is_missing(value: str | None) -> bool:
    if value is None:
        return True
    return value.strip().lower() in _MISSING_TOKENS


def _parse_numeric(value: str) -> float | None:
    # Accept the first numeric token and ignore revision markers like "(rev.)" or "*".
    text = (
        value.strip()
        .replace("−", "-")  # normalize unicode minus
        .lower()
        .replace(",", "")
        .replace("%", "")
        .replace(" ", "")
    )
    if not text:
        return None

    match = re.search(r"([+-]?\d+(?:\.\d+)?)([kmb])?", text, re.IGNORECASE)
    if not match:
        return None

    multiplier = 1.0
    suffix = (match.group(2) or "").lower()
    if suffix == "k":
        multiplier = 1_000.0
    elif suffix == "m":
        multiplier = 1_000_000.0
    elif suffix == "b":
        multiplier = 1_000_000_000.0

    try:
        return float(match.group(1)) * multiplier
    except ValueError:
        return None


def _parse_history_datetime(date_value: str, time_value: str) -> datetime:
    date_text = date_value.strip()
    time_text = time_value.strip()
    for fmt in ("%d-%m-%Y", "%Y-%m-%d"):
        try:
            date_part = datetime.strptime(date_text, fmt)
            break
        except ValueError:
            date_part = None
    if not date_part:
        return datetime.min
    if time_text and ":" in time_text:
        try:
            time_part = datetime.strptime(time_text, "%H:%M")
            return datetime(
                date_part.year,
                date_part.month,
                date_part.day,
                time_part.hour,
                time_part.minute,
            )
        except ValueError:
            pass
    return datetime(date_part.year, date_part.month, date_part.day)


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


def _load_manual_overrides(
    path: Path,
) -> tuple[dict[tuple[str, str, str], dict[str, str]], list[dict]]:
    """Load manual overrides from a CSV file.

    Expected columns: EventId, Date, Time, Actual, Forecast, Previous, Reason
    """

    if not path.exists():
        return {}, []

    overrides: dict[tuple[str, str, str], dict[str, str]] = {}
    issues: list[dict] = []
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                event_id = _safe_text(row.get("EventId"))
                date_value = _safe_text(row.get("Date"))
                time_value = _safe_text(row.get("Time"))
                if not event_id or not date_value:
                    continue
                key = (event_id, date_value, time_value)
                if key in overrides:
                    issues.append(
                        {
                            "issue": "manual_patch_duplicate_key",
                            "event_id": event_id,
                            "date": date_value,
                            "time": time_value,
                        }
                    )
                    continue

                override: dict[str, str] = {}
                for field in ("Actual", "Forecast", "Previous"):
                    value = row.get(field)
                    if value is None:
                        continue
                    text = str(value).strip()
                    if text == "":
                        continue
                    override[field] = text
                if not override:
                    continue

                override["Reason"] = _safe_text(row.get("Reason"))
                overrides[key] = override
    except (OSError, csv.Error) as exc:
        issues.append(
            {
                "issue": "manual_patch_read_failed",
                "path": str(path),
                "error": str(exc),
            }
        )
        return {}, issues

    return overrides, issues


def _write_ndjson_index(
    index_path: Path, index: dict[str, int], *, generated_at: str
) -> None:
    payload = {
        "generated_at": generated_at,
        "version": 1,
        "index": index,
    }
    index_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


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
    calendar_dir: Path,
    output_dir: Path,
    start_year: int | None,
    end_year: int | None,
    *,
    write_index: bool = True,
) -> tuple[int, int, int]:
    if not calendar_dir.exists():
        raise SystemExit(f"Calendar directory not found: {calendar_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)

    manual_patch_path = output_dir / _DEFAULT_MANUAL_PATCH_FILENAME
    manual_overrides, manual_issues = _load_manual_overrides(manual_patch_path)

    years = _iter_years(calendar_dir, start_year, end_year)
    if not years:
        raise SystemExit("No calendar year folders found.")

    rows_written = 0
    entries: list[HistoryRow] = []
    for year in years:
        year_dir = calendar_dir / str(year)
        rows = _load_year_rows(year_dir, year)
        for row in rows:
            if not isinstance(row, dict):
                continue
            event = _safe_text(row.get("Event"))
            if not event:
                continue
            cur = _safe_text(row.get("Cur."))
            event_id, _identity = build_event_canonical_id(cur, event)
            date_value = _safe_text(row.get("Date"))
            time_value = _safe_text(row.get("Time"))
            actual_value = _safe_text(row.get("Actual"))
            forecast_value = _safe_text(row.get("Forecast"))
            previous_value = _safe_text(row.get("Previous"))

            manual_key = (event_id, date_value, time_value)
            manual = manual_overrides.get(manual_key)
            manual_override_actual = False
            manual_override_forecast = False
            manual_override_previous = False
            if manual:
                if "Actual" in manual:
                    actual_value = manual["Actual"]
                    manual_override_actual = True
                if "Forecast" in manual:
                    forecast_value = manual["Forecast"]
                    manual_override_forecast = True
                if "Previous" in manual:
                    previous_value = manual["Previous"]
                    manual_override_previous = True
            entries.append(
                HistoryRow(
                    year=year,
                    event_id=event_id,
                    cur=cur,
                    event=event,
                    date=date_value,
                    time=time_value,
                    actual=actual_value,
                    forecast=forecast_value,
                    previous_raw=previous_value,
                    previous_effective=previous_value,
                    manual_override_actual=manual_override_actual,
                    manual_override_forecast=manual_override_forecast,
                    manual_override_previous=manual_override_previous,
                    sort_key=_parse_history_datetime(date_value, time_value),
                )
            )
            rows_written += 1

    issues: list[dict] = []
    patches: list[dict] = []
    manual_applied: list[dict] = []
    existing_keys: set[tuple[str, str, str]] = set()
    grouped: dict[str, list[HistoryRow]] = {}
    for entry in entries:
        existing_keys.add((entry.event_id, entry.date, entry.time))
        grouped.setdefault(entry.event_id, []).append(entry)
        if (
            entry.manual_override_actual
            or entry.manual_override_forecast
            or entry.manual_override_previous
        ):
            manual = manual_overrides.get((entry.event_id, entry.date, entry.time), {})
            manual_applied.append(
                {
                    "patch": _MANUAL_OVERRIDE_PATCH,
                    "event_id": entry.event_id,
                    "cur": entry.cur,
                    "event": entry.event,
                    "date": entry.date,
                    "time": entry.time,
                    "overrides": {
                        k: v
                        for k, v in manual.items()
                        if k in {"Actual", "Forecast", "Previous"}
                    },
                    "reason": manual.get("Reason", ""),
                }
            )

    for event_id, group in grouped.items():
        group.sort(key=lambda item: item.sort_key)
        last_actual: str | None = None
        for entry in group:
            prior_actual = last_actual
            if prior_actual and not _is_missing(prior_actual):
                if (
                    _is_missing(entry.previous_raw)
                    and not entry.manual_override_previous
                ):
                    entry.previous_effective = prior_actual
                    patch = {
                        "patch": _AUTO_PREVIOUS_FILL_PATCH,
                        "event_id": event_id,
                        "cur": entry.cur,
                        "event": entry.event,
                        "date": entry.date,
                        "time": entry.time,
                        "previous_raw": entry.previous_raw,
                        "prior_actual": prior_actual,
                        "previous_effective": entry.previous_effective,
                    }
                    patches.append(patch)
                    issues.append(
                        {
                            "issue": _AUTO_PREVIOUS_FILL_PATCH,
                            "event_id": event_id,
                            "cur": entry.cur,
                            "event": entry.event,
                            "date": entry.date,
                            "time": entry.time,
                            "previous_raw": entry.previous_raw,
                            "prior_actual": prior_actual,
                            "previous_effective": entry.previous_effective,
                        }
                    )
                else:
                    prev_num = _parse_numeric(entry.previous_raw)
                    prior_num = _parse_numeric(prior_actual)
                    mismatch = False
                    if prev_num is not None and prior_num is not None:
                        mismatch = abs(prev_num - prior_num) > 1e-9
                    elif entry.previous_raw.strip() != prior_actual.strip():
                        mismatch = True
                    if mismatch:
                        issues.append(
                            {
                                "issue": "previous_mismatch",
                                "event_id": event_id,
                                "cur": entry.cur,
                                "event": entry.event,
                                "date": entry.date,
                                "time": entry.time,
                                "previous_raw": entry.previous_raw,
                                "prior_actual": prior_actual,
                                "previous_effective": entry.previous_effective,
                            }
                        )
            if not _is_missing(entry.actual):
                last_actual = entry.actual

    for manual_key, manual in manual_overrides.items():
        if manual_key in existing_keys:
            continue
        event_id, date_value, time_value = manual_key
        issues.append(
            {
                "issue": "manual_patch_missing_target",
                "event_id": event_id,
                "date": date_value,
                "time": time_value,
                "overrides": {
                    k: v
                    for k, v in manual.items()
                    if k in {"Actual", "Forecast", "Previous"}
                },
                "reason": manual.get("Reason", ""),
            }
        )

    issues.extend(manual_issues)

    by_year: dict[int, list[HistoryRow]] = {}
    for entry in entries:
        by_year.setdefault(entry.year, []).append(entry)

    if write_index:
        for year in years:
            output_path = output_dir / f"{year}_event_history_index.csv"
            with output_path.open("w", encoding="utf-8", newline="") as handle:
                writer = csv.writer(handle)
                writer.writerow(
                    ["EventId", "Date", "Time", "Actual", "Forecast", "Previous"]
                )
                for entry in by_year.get(year, []):
                    writer.writerow(
                        [
                            entry.event_id,
                            entry.date,
                            entry.time,
                            entry.actual,
                            entry.forecast,
                            entry.previous_effective,
                        ]
                    )

        clean_path = output_dir / _CLEAN_CSV_FILENAME
        with clean_path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(
                [
                    "EventId",
                    "Cur",
                    "Event",
                    "Date",
                    "Time",
                    "Actual",
                    "Forecast",
                    "PreviousRaw",
                    "Previous",
                ]
            )
            for entry in sorted(
                entries, key=lambda item: (item.event_id, item.sort_key)
            ):
                writer.writerow(
                    [
                        entry.event_id,
                        entry.cur,
                        entry.event,
                        entry.date,
                        entry.time,
                        entry.actual,
                        entry.forecast,
                        entry.previous_raw,
                        entry.previous_effective,
                    ]
                )

        by_event_path = output_dir / _BY_EVENT_NDJSON_FILENAME
        by_event_index: dict[str, int] = {}
        with by_event_path.open("wb") as handle:
            for event_id in sorted(grouped.keys()):
                group = sorted(grouped[event_id], key=lambda item: item.sort_key)
                payload = {
                    "eventId": event_id,
                    "points": [
                        [
                            entry.date,
                            entry.time,
                            entry.actual,
                            entry.forecast,
                            entry.previous_effective,
                        ]
                        for entry in group
                    ],
                }
                by_event_index[event_id] = int(handle.tell())
                handle.write(
                    (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
                )
        _write_ndjson_index(
            output_dir / _BY_EVENT_INDEX_FILENAME,
            by_event_index,
            generated_at=datetime.now(timezone.utc).strftime("%d-%m-%Y %H:%M"),
        )

        manual_csv_path = output_dir / _MANUAL_APPLIED_CSV_FILENAME
        with manual_csv_path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(["Patch", "EventId", "Date", "Time", "Overrides", "Reason"])
            for patch in manual_applied:
                writer.writerow(
                    [
                        patch.get("patch", ""),
                        patch.get("event_id", ""),
                        patch.get("date", ""),
                        patch.get("time", ""),
                        json.dumps(patch.get("overrides", {}), ensure_ascii=False),
                        patch.get("reason", ""),
                    ]
                )

        manual_json_path = output_dir / _MANUAL_APPLIED_JSON_FILENAME
        manual_json_path.write_text(
            json.dumps(
                {
                    "generated_at": datetime.now(timezone.utc).strftime(
                        "%d-%m-%Y %H:%M"
                    ),
                    "patches": manual_applied,
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

    issues_path = output_dir / "event_history_issues.json"
    issues_path.write_text(
        json.dumps(
            {
                "generated_at": datetime.now(timezone.utc).strftime("%d-%m-%Y %H:%M"),
                "issues": issues,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    issues_csv_path = output_dir / "event_history_issues.csv"
    with issues_csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "Issue",
                "EventId",
                "Cur",
                "Event",
                "Date",
                "Time",
                "PreviousRaw",
                "PriorActual",
                "PreviousEffective",
                "Details",
            ]
        )
        for issue in issues:
            known_keys = {
                "issue",
                "event_id",
                "cur",
                "event",
                "date",
                "time",
                "previous_raw",
                "prior_actual",
                "previous_effective",
            }
            details = {
                key: value for key, value in issue.items() if key not in known_keys
            }
            writer.writerow(
                [
                    issue.get("issue", ""),
                    issue.get("event_id", ""),
                    issue.get("cur", ""),
                    issue.get("event", ""),
                    issue.get("date", ""),
                    issue.get("time", ""),
                    issue.get("previous_raw", ""),
                    issue.get("prior_actual", ""),
                    issue.get("previous_effective", ""),
                    json.dumps(details, ensure_ascii=False) if details else "",
                ]
            )

    patches_path = output_dir / "event_history_previous_patch.json"
    patches_path.write_text(
        json.dumps(
            {
                "generated_at": datetime.now(timezone.utc).strftime("%d-%m-%Y %H:%M"),
                "patches": patches,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    patches_csv_path = output_dir / "event_history_previous_patch.csv"
    with patches_csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "Patch",
                "EventId",
                "Cur",
                "Event",
                "Date",
                "Time",
                "PreviousRaw",
                "PriorActual",
                "PreviousEffective",
            ]
        )
        for patch in patches:
            writer.writerow(
                [
                    patch.get("patch", ""),
                    patch.get("event_id", ""),
                    patch.get("cur", ""),
                    patch.get("event", ""),
                    patch.get("date", ""),
                    patch.get("time", ""),
                    patch.get("previous_raw", ""),
                    patch.get("prior_actual", ""),
                    patch.get("previous_effective", ""),
                ]
            )

    return rows_written, len(issues), len(patches)


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

    rows_written, issue_count, patch_count = build_index(
        calendar_dir, output_dir, args.start_year, args.end_year
    )
    print(f"[INFO] Wrote {rows_written} history rows into {output_dir}")
    print(f"[INFO] Wrote {issue_count} issues into {output_dir}")
    print(f"[INFO] Wrote {patch_count} patches into {output_dir}")


if __name__ == "__main__":
    main()
