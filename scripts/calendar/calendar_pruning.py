import pandas as pd


def compute_safe_prune_days(
    existing_df: pd.DataFrame,
    new_df: pd.DataFrame,
    start_date: str,
    end_date: str,
    *,
    guard_ratio: float,
    guard_min_new_nonholiday: int,
) -> tuple[set[str], dict[str, str]]:
    """Compute day-level prune safety decisions for a fetched date window.

    Returns:
    - safe_prune_days: days (YYYY-MM-DD) safe to prune from existing before merge.
    - skipped: reasons keyed by day for days that are unsafe to prune.
    """
    window_days = pd.date_range(start_date, end_date).strftime("%Y-%m-%d")

    def total_counts(frame: pd.DataFrame) -> dict[str, int]:
        if frame.empty or "Date" not in frame.columns:
            return {}
        dates = frame["Date"].fillna("").astype(str)
        counts = dates.value_counts().to_dict()  # type: ignore[call-arg]
        return {str(k): int(v) for k, v in counts.items()}

    def non_holiday_counts(frame: pd.DataFrame) -> dict[str, int]:
        if frame.empty or "Date" not in frame.columns:
            return {}
        dates = frame["Date"].fillna("").astype(str)
        imp = frame.get("Imp.", pd.Series([""] * len(frame))).fillna("").astype(str)
        non_holiday = imp.str.strip().str.lower().ne("holiday")
        counts = dates[non_holiday].value_counts().to_dict()  # type: ignore[call-arg]
        return {str(k): int(v) for k, v in counts.items()}

    old_total_counts = total_counts(existing_df)
    new_total_counts = total_counts(new_df)
    old_non_holiday_counts = non_holiday_counts(existing_df)
    new_non_holiday_counts = non_holiday_counts(new_df)

    safe_prune_days: set[str] = set()
    skipped: dict[str, str] = {}
    for day in window_days:
        old_total = int(old_total_counts.get(day, 0))
        new_total = int(new_total_counts.get(day, 0))
        old_n = int(old_non_holiday_counts.get(day, 0))
        new_n = int(new_non_holiday_counts.get(day, 0))

        if old_total > 0 and new_total <= 0:
            skipped[day] = f"new_total_rows=0 but old_total_rows={old_total}."
            continue

        if old_n <= 0:
            # Holiday-only day (or no prior rows): prune only when the new window has
            # at least some rows for that day so we don't delete on empty upstream days.
            if new_total > 0:
                safe_prune_days.add(day)
            continue

        # If the new window has at least as many non-holiday rows as the existing
        # exports for this day, treat it as safe regardless of the global floor.
        # This avoids surprising skips when `old_n < guard_min_new_nonholiday`.
        if new_n >= old_n:
            safe_prune_days.add(day)
            continue

        # For small historical counts, the absolute floor should not exceed the
        # historical baseline; otherwise a day can never be "safe" unless the
        # upstream adds extra rows.
        min_expected = max(
            int(old_n * guard_ratio), min(guard_min_new_nonholiday, old_n)
        )
        if new_n < min_expected:
            skipped[day] = (
                f"new_non_holiday={new_n} < expected_min={min_expected} "
                f"(old_non_holiday={old_n})."
            )
            continue

        safe_prune_days.add(day)

    return safe_prune_days, skipped
