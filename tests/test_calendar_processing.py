import pandas as pd

from scripts.calendar import calendar_processing as processing


def test_prune_calendar_frame_by_date_range_is_inclusive():
    df = pd.DataFrame(
        [
            {"Date": "2026-01-14", "Time": "09:00", "Cur.": "USD", "Event": "A"},
            {"Date": "2026-01-15", "Time": "09:00", "Cur.": "USD", "Event": "B"},
            {"Date": "2026-01-16", "Time": "09:00", "Cur.": "USD", "Event": "C"},
        ]
    )
    pruned = processing.prune_calendar_frame_by_date_range(
        df, start_date="2026-01-15", end_date="2026-01-15"
    )
    assert pruned["Event"].tolist() == ["A", "C"]


def test_merge_calendar_frames_prefers_new_over_existing_when_keys_match():
    existing = pd.DataFrame(
        [
            {
                "Date": "2026-01-15",
                "Day": "Thursday",
                "Time": "09:00",
                "Cur.": "KRW",
                "Imp.": "Low",
                "Event": "Bank of Korea Monetary Policy Board's Policy Setting Meeting Dates",
                "Actual": pd.NA,
                "Forecast": "111.11",
                "Previous": pd.NA,
            }
        ]
    )
    new = pd.DataFrame(
        [
            {
                "Date": "2026-01-15",
                "Day": "Thursday",
                "Time": "09:00",
                "Cur.": "KRW",
                "Imp.": "Low",
                "Event": "Bank of Korea Monetary Policy Board's Policy Setting Meeting Dates",
                "Actual": pd.NA,
                "Forecast": "222.22",
                "Previous": pd.NA,
            }
        ]
    )
    merged = processing.merge_calendar_frames(existing, new)
    assert merged.loc[0, "Forecast"] == "222.22"


def test_merge_calendar_frames_normalizes_empty_strings_to_na_for_value_fields():
    existing = pd.DataFrame(
        [
            {
                "Date": "2026-01-15",
                "Day": "Thursday",
                "Time": "09:00",
                "Cur.": "USD",
                "Imp.": "Low",
                "Event": "Some Event",
                "Actual": pd.NA,
                "Forecast": pd.NA,
                "Previous": pd.NA,
            }
        ]
    )
    new = pd.DataFrame(
        [
            {
                "Date": "2026-01-15",
                "Day": "Thursday",
                "Time": "09:00",
                "Cur.": "USD",
                "Imp.": "Low",
                "Event": "Some Event",
                "Actual": "",
                "Forecast": "",
                "Previous": "",
            }
        ]
    )
    merged = processing.merge_calendar_frames(existing, new)
    assert pd.isna(merged.loc[0, "Forecast"])
