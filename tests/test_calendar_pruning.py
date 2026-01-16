import pandas as pd

from scripts.calendar import calendar_pruning


def test_prune_guard_skips_when_new_total_rows_missing_for_existing_day():
    existing = pd.DataFrame(
        [
            {"Date": "2026-01-16", "Imp.": "Holiday", "Event": "Some Holiday"},
            {"Date": "2026-01-17", "Imp.": "Low", "Event": "A"},
        ]
    )
    new = pd.DataFrame(
        [
            {"Date": "2026-01-17", "Imp.": "Low", "Event": "A"},
        ]
    )

    safe, skipped = calendar_pruning.compute_safe_prune_days(
        existing,
        new,
        "2026-01-16",
        "2026-01-17",
        guard_ratio=0.6,
        guard_min_new_nonholiday=5,
    )

    assert "2026-01-16" not in safe
    assert "2026-01-16" in skipped


def test_prune_guard_skips_when_new_non_holiday_below_threshold():
    existing = pd.DataFrame(
        [{"Date": "2026-01-16", "Imp.": "Medium", "Event": f"E{i}"} for i in range(10)]
    )
    new = pd.DataFrame(
        [{"Date": "2026-01-16", "Imp.": "Medium", "Event": f"N{i}"} for i in range(2)]
    )

    safe, skipped = calendar_pruning.compute_safe_prune_days(
        existing,
        new,
        "2026-01-16",
        "2026-01-16",
        guard_ratio=0.6,
        guard_min_new_nonholiday=5,
    )

    assert "2026-01-16" not in safe
    assert "2026-01-16" in skipped


def test_prune_guard_allows_when_new_non_holiday_meets_threshold():
    existing = pd.DataFrame(
        [{"Date": "2026-01-16", "Imp.": "Medium", "Event": f"E{i}"} for i in range(10)]
    )
    new = pd.DataFrame(
        [{"Date": "2026-01-16", "Imp.": "Medium", "Event": f"N{i}"} for i in range(8)]
    )

    safe, skipped = calendar_pruning.compute_safe_prune_days(
        existing,
        new,
        "2026-01-16",
        "2026-01-16",
        guard_ratio=0.6,
        guard_min_new_nonholiday=5,
    )

    assert "2026-01-16" in safe
    assert skipped == {}


def test_prune_guard_allows_when_new_equals_old_even_below_min_floor():
    existing = pd.DataFrame(
        [{"Date": "2026-01-24", "Imp.": "Low", "Event": f"E{i}"} for i in range(4)]
    )
    new = pd.DataFrame(
        [{"Date": "2026-01-24", "Imp.": "Low", "Event": f"N{i}"} for i in range(4)]
    )

    safe, skipped = calendar_pruning.compute_safe_prune_days(
        existing,
        new,
        "2026-01-24",
        "2026-01-24",
        guard_ratio=0.6,
        guard_min_new_nonholiday=5,
    )

    assert "2026-01-24" in safe
    assert skipped == {}
