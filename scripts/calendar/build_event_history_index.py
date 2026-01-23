from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
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
# If an event has historical actual values but a specific release remains missing
# its actual for too long, drop it from the clean index to avoid confusing charts.
_STALE_MISSING_ACTUAL_DAYS: Final[int] = 2

_MONTH_ORDER: Final[dict[str, int]] = {
    "jan": 1,
    "feb": 2,
    "mar": 3,
    "apr": 4,
    "may": 5,
    "jun": 6,
    "jul": 7,
    "aug": 8,
    "sep": 9,
    "oct": 10,
    "nov": 11,
    "dec": 12,
}
_MONTH_ALIASES: Final[dict[str, str]] = {
    "january": "jan",
    "february": "feb",
    "march": "mar",
    "april": "apr",
    "june": "jun",
    "july": "jul",
    "august": "aug",
    "sept": "sep",
    "september": "sep",
    "october": "oct",
    "november": "nov",
    "december": "dec",
}
_PERIOD_TOKEN_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:q[1-4]|h[1-2])$", re.IGNORECASE
)


def _normalize_period(value: str) -> str:
    token = value.strip()
    if not token:
        return ""
    lowered = token.lower().replace(".", "").strip()
    if lowered in _MONTH_ORDER:
        return lowered
    if lowered in _MONTH_ALIASES:
        return _MONTH_ALIASES[lowered]
    if _PERIOD_TOKEN_RE.match(lowered):
        return lowered.lower()
    return lowered


def _period_sort_value(
    period: str, reference_month: int | None = None
) -> tuple[int, int, str]:
    normalized = _normalize_period(period)
    month_idx = _MONTH_ORDER.get(normalized)
    if month_idx is not None:
        if reference_month and 1 <= reference_month <= 12:
            # When multiple releases share the same timestamp (backfills), order the
            # periods relative to the release month so (Dec) can come before (Jan).
            distance = (reference_month - month_idx) % 12
            return (0, -distance, normalized)
        return (0, month_idx, normalized)
    if normalized.startswith("q") and len(normalized) == 2 and normalized[1].isdigit():
        return (1, int(normalized[1]), normalized)
    if normalized.startswith("h") and len(normalized) == 2 and normalized[1].isdigit():
        return (2, int(normalized[1]), normalized)
    return (3, 0, normalized)


@dataclass
class HistoryRow:
    year: int
    event_id: str
    cur: str
    event: str
    period: str
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
    actual_effective: str = ""
    actual_revised_from: str = ""
    previous_revised_from: str = ""


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


def _values_match(left: str, right: str) -> bool:
    if _is_missing(left) and _is_missing(right):
        return True
    if _is_missing(left) or _is_missing(right):
        return False
    left_num = _parse_numeric(left)
    right_num = _parse_numeric(right)
    if left_num is not None and right_num is not None:
        return abs(left_num - right_num) <= 1e-9
    return left.strip() == right.strip()


def _history_sort_key(item: HistoryRow) -> tuple[datetime, tuple[int, int, str], str]:
    ref_month = item.sort_key.month if item.sort_key != datetime.min else None
    return (
        item.sort_key,
        _period_sort_value(item.period, reference_month=ref_month),
        item.event,
    )


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


def _year_from_date_text(value: str) -> int | None:
    text = value.strip()
    if not text:
        return None
    if len(text) >= 5 and text[:4].isdigit() and text[4] == "-":
        return int(text[:4])
    if len(text) >= 10 and text[2] == "-" and text[5] == "-" and text[6:10].isdigit():
        return int(text[6:10])
    return None


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
) -> tuple[dict[tuple[str, str, str, str], dict[str, str]], list[dict]]:
    """Load manual overrides from a CSV file.

    Expected columns: EventId, Date, Time, Period, Actual, Forecast, Previous, Reason
    """

    if not path.exists():
        return {}, []

    overrides: dict[tuple[str, str, str, str], dict[str, str]] = {}
    issues: list[dict] = []
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                event_id = _safe_text(row.get("EventId"))
                date_value = _safe_text(row.get("Date"))
                time_value = _safe_text(row.get("Time"))
                period_value = _normalize_period(_safe_text(row.get("Period")))
                if not event_id or not date_value:
                    continue
                key = (event_id, date_value, time_value, period_value)
                if key in overrides:
                    issues.append(
                        {
                            "issue": "manual_patch_duplicate_key",
                            "event_id": event_id,
                            "date": date_value,
                            "time": time_value,
                            "period": period_value,
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
        "version": 3,
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
            event_id, identity = build_event_canonical_id(cur, event)
            period_value = _normalize_period(identity.period)
            date_value = _safe_text(row.get("Date"))
            time_value = _safe_text(row.get("Time"))
            actual_value = _safe_text(row.get("Actual"))
            forecast_value = _safe_text(row.get("Forecast"))
            previous_value = _safe_text(row.get("Previous"))

            manual_key = (event_id, date_value, time_value, period_value)
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
                    period=period_value,
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
    existing_keys: set[tuple[str, str, str, str]] = set()
    grouped: dict[str, list[HistoryRow]] = {}
    for entry in entries:
        existing_keys.add((entry.event_id, entry.date, entry.time, entry.period))
        grouped.setdefault(entry.event_id, []).append(entry)
        if (
            entry.manual_override_actual
            or entry.manual_override_forecast
            or entry.manual_override_previous
        ):
            manual = manual_overrides.get(
                (entry.event_id, entry.date, entry.time, entry.period), {}
            )
            manual_applied.append(
                {
                    "patch": _MANUAL_OVERRIDE_PATCH,
                    "event_id": entry.event_id,
                    "cur": entry.cur,
                    "event": entry.event,
                    "period": entry.period,
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

    event_has_actual = {
        event_id: any(not _is_missing(entry.actual) for entry in group)
        for event_id, group in grouped.items()
    }

    for event_id, group in grouped.items():
        group.sort(key=_history_sort_key)
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
                        "period": entry.period,
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
                            "period": entry.period,
                            "date": entry.date,
                            "time": entry.time,
                            "previous_raw": entry.previous_raw,
                            "prior_actual": prior_actual,
                            "previous_effective": entry.previous_effective,
                        }
                    )
                else:
                    # Mismatches are usually revisions and are handled later when building the
                    # "effective" actual series. Keep the issues list focused on actionable
                    # problems (missing values / patches).
                    pass
            if not _is_missing(entry.actual):
                last_actual = entry.actual

    for manual_key, manual in manual_overrides.items():
        if manual_key in existing_keys:
            continue
        event_id, date_value, time_value, period_value = manual_key
        issues.append(
            {
                "issue": "manual_patch_missing_target",
                "event_id": event_id,
                "date": date_value,
                "time": time_value,
                "period": period_value,
                "overrides": {
                    k: v
                    for k, v in manual.items()
                    if k in {"Actual", "Forecast", "Previous"}
                },
                "reason": manual.get("Reason", ""),
            }
        )

    issues.extend(manual_issues)

    now_utc = datetime.now(timezone.utc).replace(tzinfo=None)
    stale_actual_cutoff = now_utc - timedelta(days=_STALE_MISSING_ACTUAL_DAYS)

    dropped_stale_missing_actual: set[tuple[str, str, str, str]] = set()
    filtered_grouped: dict[str, list[HistoryRow]] = {}
    for event_id, group in grouped.items():
        group_sorted = sorted(group, key=_history_sort_key)
        if not event_has_actual.get(event_id):
            filtered_grouped[event_id] = group_sorted
            continue

        newer_actual: HistoryRow | None = None
        for entry in reversed(group_sorted):
            if entry.sort_key == datetime.min:
                continue
            if not _is_missing(entry.actual):
                newer_actual = entry
                continue
            if (
                newer_actual
                and entry.sort_key < now_utc
                and entry.sort_key >= stale_actual_cutoff
            ):
                issues.append(
                    {
                        "issue": "missing_actual_with_newer_actual",
                        "event_id": entry.event_id,
                        "cur": entry.cur,
                        "event": entry.event,
                        "period": entry.period,
                        "date": entry.date,
                        "time": entry.time,
                        "newer_date": newer_actual.date,
                        "newer_time": newer_actual.time,
                    }
                )

        kept: list[HistoryRow] = []
        for entry in group_sorted:
            if not _is_missing(entry.actual):
                kept.append(entry)
                continue
            if entry.sort_key == datetime.min:
                kept.append(entry)
                continue
            if entry.sort_key >= stale_actual_cutoff:
                kept.append(entry)
                continue
            key = (entry.event_id, entry.date, entry.time, entry.period)
            dropped_stale_missing_actual.add(key)
            issues.append(
                {
                    "issue": "stale_missing_actual_dropped",
                    "event_id": entry.event_id,
                    "cur": entry.cur,
                    "event": entry.event,
                    "period": entry.period,
                    "date": entry.date,
                    "time": entry.time,
                    "cutoff": stale_actual_cutoff.strftime("%d-%m-%Y %H:%M"),
                }
            )
        filtered_grouped[event_id] = kept

    for event_id, group in filtered_grouped.items():
        # Reset per-run derived fields.
        for entry in group:
            entry.actual_effective = entry.actual
            entry.actual_revised_from = ""
            entry.previous_revised_from = ""

        # Detect revisions by comparing an older actual with the next release that has
        # an actual value (skip over releases that are missing actual).
        # - Graph uses `actual_effective` (revised value).
        # - Table surfaces revision info under the newer row's "Previous".
        for idx, current in enumerate(group):
            if _is_missing(current.actual):
                continue

            next_entry: HistoryRow | None = None
            for lookahead in range(idx + 1, len(group)):
                candidate_entry = group[lookahead]
                if _is_missing(candidate_entry.actual):
                    continue
                next_entry = candidate_entry
                break

            if next_entry is None:
                continue

            candidate = next_entry.previous_effective
            if not candidate or _is_missing(candidate):
                continue
            if _values_match(current.actual, candidate):
                continue
            current.actual_effective = candidate
            current.actual_revised_from = current.actual
            next_entry.previous_revised_from = current.actual

    by_year: dict[int, list[HistoryRow]] = {}
    for entry in entries:
        key = (entry.event_id, entry.date, entry.time, entry.period)
        if key in dropped_stale_missing_actual:
            continue
        by_year.setdefault(entry.year, []).append(entry)

    if write_index:
        for year in years:
            output_path = output_dir / f"{year}_event_history_index.csv"
            with output_path.open("w", encoding="utf-8", newline="") as handle:
                writer = csv.writer(handle)
                writer.writerow(
                    [
                        "EventId",
                        "Date",
                        "Time",
                        "Period",
                        "Actual",
                        "Forecast",
                        "Previous",
                    ]
                )
                for entry in sorted(
                    by_year.get(year, []),
                    key=_history_sort_key,
                ):
                    writer.writerow(
                        [
                            entry.event_id,
                            entry.date,
                            entry.time,
                            entry.period,
                            entry.actual,
                            entry.forecast,
                            entry.previous_effective,
                        ]
                    )

        legacy_clean_path = output_dir / _CLEAN_CSV_FILENAME
        try:
            legacy_clean_path.unlink(missing_ok=True)
        except OSError:
            pass

        clean_header = [
            "EventId",
            "Cur",
            "Event",
            "Period",
            "Date",
            "Time",
            "ActualRaw",
            "ActualEffective",
            "ActualRevisedFrom",
            "Forecast",
            "PreviousRaw",
            "Previous",
            "PreviousRevisedFrom",
        ]
        for year in years:
            clean_path = output_dir / f"{year}_{_CLEAN_CSV_FILENAME}"
            with clean_path.open("w", encoding="utf-8", newline="") as handle:
                writer = csv.writer(handle)
                writer.writerow(clean_header)
                for entry in sorted(by_year.get(year, []), key=_history_sort_key):
                    writer.writerow(
                        [
                            entry.event_id,
                            entry.cur,
                            entry.event,
                            entry.period,
                            entry.date,
                            entry.time,
                            entry.actual,
                            entry.actual_effective,
                            entry.actual_revised_from,
                            entry.forecast,
                            entry.previous_raw,
                            entry.previous_effective,
                            entry.previous_revised_from,
                        ]
                    )

        by_event_path = output_dir / _BY_EVENT_NDJSON_FILENAME
        by_event_index: dict[str, int] = {}
        with by_event_path.open("wb") as handle:
            for event_id in sorted(grouped.keys()):
                group = filtered_grouped.get(event_id, [])
                points: list[list[str]] = []
                for entry in group:
                    row = [
                        entry.date,
                        entry.time,
                        entry.actual_effective,
                        entry.forecast,
                        entry.previous_effective,
                        entry.actual,
                        entry.previous_raw,
                        entry.period,
                    ]
                    if entry.previous_revised_from:
                        # Insert before `period` so period stays at the end.
                        row.insert(-1, entry.previous_revised_from)
                    points.append(row)
                payload = {
                    "eventId": event_id,
                    "points": points,
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

        try:
            (output_dir / _MANUAL_APPLIED_CSV_FILENAME).unlink(missing_ok=True)
            (output_dir / _MANUAL_APPLIED_JSON_FILENAME).unlink(missing_ok=True)
            (output_dir / f"{_MANUAL_APPLIED_CSV_FILENAME}.misc").unlink(
                missing_ok=True
            )
        except OSError:
            pass

        manual_header = [
            "Patch",
            "EventId",
            "Period",
            "Date",
            "Time",
            "Overrides",
            "Reason",
        ]
        manual_by_year: dict[int, list[dict]] = {}
        manual_misc: list[dict] = []
        for patch in manual_applied:
            year = _year_from_date_text(str(patch.get("date", "")))
            if year is None:
                manual_misc.append(patch)
                continue
            manual_by_year.setdefault(year, []).append(patch)

        generated_at = datetime.now(timezone.utc).strftime("%d-%m-%Y %H:%M")
        for year, patches_for_year in sorted(manual_by_year.items()):
            manual_csv_path = output_dir / f"{year}_{_MANUAL_APPLIED_CSV_FILENAME}"
            with manual_csv_path.open("w", encoding="utf-8", newline="") as handle:
                writer = csv.writer(handle)
                writer.writerow(manual_header)
                for patch in patches_for_year:
                    writer.writerow(
                        [
                            patch.get("patch", ""),
                            patch.get("event_id", ""),
                            patch.get("period", ""),
                            patch.get("date", ""),
                            patch.get("time", ""),
                            json.dumps(patch.get("overrides", {}), ensure_ascii=False),
                            patch.get("reason", ""),
                        ]
                    )
            manual_json_path = output_dir / f"{year}_{_MANUAL_APPLIED_JSON_FILENAME}"
            manual_json_path.write_text(
                json.dumps(
                    {
                        "generated_at": generated_at,
                        "patches": patches_for_year,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )

        if manual_misc:
            manual_csv_path = output_dir / "event_history_manual_patch_applied_misc.csv"
            with manual_csv_path.open("w", encoding="utf-8", newline="") as handle:
                writer = csv.writer(handle)
                writer.writerow(manual_header)
                for patch in manual_misc:
                    writer.writerow(
                        [
                            patch.get("patch", ""),
                            patch.get("event_id", ""),
                            patch.get("period", ""),
                            patch.get("date", ""),
                            patch.get("time", ""),
                            json.dumps(patch.get("overrides", {}), ensure_ascii=False),
                            patch.get("reason", ""),
                        ]
                    )
            manual_json_path = (
                output_dir / "event_history_manual_patch_applied_misc.json"
            )
            manual_json_path.write_text(
                json.dumps(
                    {
                        "generated_at": generated_at,
                        "patches": manual_misc,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )

    try:
        (output_dir / "event_history_issues.json").unlink(missing_ok=True)
        (output_dir / "event_history_issues.csv").unlink(missing_ok=True)
        (output_dir / "event_history_previous_patch.json").unlink(missing_ok=True)
        (output_dir / "event_history_previous_patch.csv").unlink(missing_ok=True)
    except OSError:
        pass

    generated_at = datetime.now(timezone.utc).strftime("%d-%m-%Y %H:%M")

    issue_header = [
        "Issue",
        "EventId",
        "Cur",
        "Event",
        "Period",
        "Date",
        "Time",
        "PreviousRaw",
        "PriorActual",
        "PreviousEffective",
        "Details",
    ]
    issue_known_keys = {
        "issue",
        "event_id",
        "cur",
        "event",
        "period",
        "date",
        "time",
        "previous_raw",
        "prior_actual",
        "previous_effective",
    }
    issues_by_year: dict[int, list[dict]] = {}
    issues_misc: list[dict] = []
    for issue in issues:
        year = _year_from_date_text(str(issue.get("date", "")))
        if year is None:
            issues_misc.append(issue)
        else:
            issues_by_year.setdefault(year, []).append(issue)

    solved_issue_types = {
        _AUTO_PREVIOUS_FILL_PATCH,
        "stale_missing_actual_dropped",
    }

    def write_issue_files(stem: str, issue_rows: list[dict]) -> None:
        issues_path = output_dir / f"{stem}.json"
        issues_path.write_text(
            json.dumps(
                {
                    "generated_at": generated_at,
                    "issues": issue_rows,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        issues_csv_path = output_dir / f"{stem}.csv"
        with issues_csv_path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(issue_header)
            for issue in issue_rows:
                details = {
                    key: value
                    for key, value in issue.items()
                    if key not in issue_known_keys
                }
                writer.writerow(
                    [
                        issue.get("issue", ""),
                        issue.get("event_id", ""),
                        issue.get("cur", ""),
                        issue.get("event", ""),
                        issue.get("period", ""),
                        issue.get("date", ""),
                        issue.get("time", ""),
                        issue.get("previous_raw", ""),
                        issue.get("prior_actual", ""),
                        issue.get("previous_effective", ""),
                        json.dumps(details, ensure_ascii=False) if details else "",
                    ]
                )

    for year, issues_for_year in sorted(issues_by_year.items()):
        write_issue_files(f"{year}_event_history_issues", issues_for_year)
        open_issues = [
            issue
            for issue in issues_for_year
            if str(issue.get("issue", "")) not in solved_issue_types
        ]
        solved_issues = [
            issue
            for issue in issues_for_year
            if str(issue.get("issue", "")) in solved_issue_types
        ]
        write_issue_files(f"{year}_event_history_issues_open", open_issues)
        write_issue_files(f"{year}_event_history_issues_solved", solved_issues)

    if issues_misc:
        write_issue_files("event_history_issues_misc", issues_misc)
        open_misc = [
            issue
            for issue in issues_misc
            if str(issue.get("issue", "")) not in solved_issue_types
        ]
        solved_misc = [
            issue
            for issue in issues_misc
            if str(issue.get("issue", "")) in solved_issue_types
        ]
        write_issue_files("event_history_issues_misc_open", open_misc)
        write_issue_files("event_history_issues_misc_solved", solved_misc)

    patch_header = [
        "Patch",
        "EventId",
        "Cur",
        "Event",
        "Period",
        "Date",
        "Time",
        "PreviousRaw",
        "PriorActual",
        "PreviousEffective",
    ]
    patches_by_year: dict[int, list[dict]] = {}
    patches_misc: list[dict] = []
    for patch in patches:
        year = _year_from_date_text(str(patch.get("date", "")))
        if year is None:
            patches_misc.append(patch)
        else:
            patches_by_year.setdefault(year, []).append(patch)

    for year, patches_for_year in sorted(patches_by_year.items()):
        patches_path = output_dir / f"{year}_event_history_previous_patch.json"
        patches_path.write_text(
            json.dumps(
                {
                    "generated_at": generated_at,
                    "patches": patches_for_year,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        patches_csv_path = output_dir / f"{year}_event_history_previous_patch.csv"
        with patches_csv_path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(patch_header)
            for patch in patches_for_year:
                writer.writerow(
                    [
                        patch.get("patch", ""),
                        patch.get("event_id", ""),
                        patch.get("cur", ""),
                        patch.get("event", ""),
                        patch.get("period", ""),
                        patch.get("date", ""),
                        patch.get("time", ""),
                        patch.get("previous_raw", ""),
                        patch.get("prior_actual", ""),
                        patch.get("previous_effective", ""),
                    ]
                )

    if patches_misc:
        patches_path = output_dir / "event_history_previous_patch_misc.json"
        patches_path.write_text(
            json.dumps(
                {
                    "generated_at": generated_at,
                    "patches": patches_misc,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        patches_csv_path = output_dir / "event_history_previous_patch_misc.csv"
        with patches_csv_path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(patch_header)
            for patch in patches_misc:
                writer.writerow(
                    [
                        patch.get("patch", ""),
                        patch.get("event_id", ""),
                        patch.get("cur", ""),
                        patch.get("event", ""),
                        patch.get("period", ""),
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
