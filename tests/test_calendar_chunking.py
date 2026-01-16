from datetime import datetime

from scripts.calendar.economic_calendar_fetcher import chunk_date_range


def test_chunk_date_range_weekday_only_four_day_window_shrinks_to_three_days():
    # 20-01-2026 is a Tuesday; 20..23 is 4 weekdays (Tue..Fri) and should shrink to 20..22.
    start = datetime(2026, 1, 20)
    end = datetime(2026, 1, 25)

    chunks = list(chunk_date_range(start, end, chunk_days=4))

    assert chunks[0] == (datetime(2026, 1, 20), datetime(2026, 1, 22))
    assert chunks[1][0] == datetime(2026, 1, 23)


def test_chunk_date_range_does_not_shrink_when_weekend_included():
    # 23..26 includes weekend, so no shrink; expect first chunk to remain 23..26.
    start = datetime(2026, 1, 23)
    end = datetime(2026, 1, 30)

    chunks = list(chunk_date_range(start, end, chunk_days=4))

    assert chunks[0] == (datetime(2026, 1, 23), datetime(2026, 1, 26))
