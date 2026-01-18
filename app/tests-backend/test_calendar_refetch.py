from __future__ import annotations

from datetime import datetime

import pandas as pd

from scripts.calendar import economic_calendar_fetcher as fetcher


def _day_header(day: str) -> list[str]:
    dt = datetime.strptime(day, "%Y-%m-%d")
    return [dt.strftime("%A, %B %d, %Y")] + [""] * 6


def test_pagination_tail_days_from_first_page_includes_last_day_to_chunk_end():
    headers = ["Time", "Cur.", "Imp.", "Event", "Actual", "Forecast", "Previous"]
    first_page_rows = [
        _day_header("2026-01-15"),
        ["09:00", "USD", "Low", "A", "", "", ""],
        _day_header("2026-01-16"),
        ["09:00", "USD", "Low", "B", "", "", ""],
    ]
    chunk_end = datetime(2026, 1, 18)

    days = fetcher._pagination_tail_days_from_first_page(  # noqa: SLF001
        headers=headers, first_page_rows=first_page_rows, chunk_end=chunk_end
    )

    assert days == {"2026-01-16", "2026-01-17", "2026-01-18"}


def test_refetch_respects_max_days_cap(monkeypatch):
    monkeypatch.setenv("CALENDAR_REFETCH_ANOMALIES", "1")
    monkeypatch.setenv("CALENDAR_REFETCH_MAX_DAYS", "2")

    # Avoid touching disk for "existing" data.
    monkeypatch.setattr(
        fetcher,
        "_load_existing_year_dataframe",
        lambda year, expected_columns: pd.DataFrame(columns=expected_columns),
    )
    monkeypatch.setattr(fetcher.time, "sleep", lambda _: None)

    called: list[str] = []

    class DummyResponse:
        def __init__(self, payload: dict):
            self._payload = payload

        def json(self) -> dict:
            return self._payload

    def fake_post(session, payload, *, chunk_start, chunk_end):
        called.append(payload["dateFrom"])
        return DummyResponse({"data": payload["dateFrom"]})

    def fake_parse(html_snippet: str):
        day = html_snippet
        headers = ["Time", "Cur.", "Imp.", "Event", "Actual", "Forecast", "Previous"]
        return headers, [_day_header(day), ["09:00", "USD", "Low", "X", "", "", ""]]

    monkeypatch.setattr(fetcher, "_post_calendar_with_retries", fake_post)
    monkeypatch.setattr(fetcher, "parse_calendar_html", fake_parse)

    headers = ["Time", "Cur.", "Imp.", "Event", "Actual", "Forecast", "Previous"]
    data = [_day_header("2026-01-16"), ["09:00", "USD", "Low", "BASE", "", "", ""]]

    fetcher._refetch_anomalous_days(  # noqa: SLF001
        session=object(),  # not used by fake_post
        start_date=datetime(2026, 1, 16),
        end_date=datetime(2026, 1, 20),
        headers=headers,
        data=data,
        force_days={"2026-01-17", "2026-01-18", "2026-01-19"},
    )

    # Sorted force_days: 17,18,19; capped to 2.
    assert called == ["2026-01-17", "2026-01-18"]


def test_refetch_unlimited_when_max_days_zero(monkeypatch):
    monkeypatch.setenv("CALENDAR_REFETCH_ANOMALIES", "1")
    monkeypatch.setenv("CALENDAR_REFETCH_MAX_DAYS", "0")

    monkeypatch.setattr(
        fetcher,
        "_load_existing_year_dataframe",
        lambda year, expected_columns: pd.DataFrame(columns=expected_columns),
    )
    monkeypatch.setattr(fetcher.time, "sleep", lambda _: None)

    called: list[str] = []

    class DummyResponse:
        def __init__(self, payload: dict):
            self._payload = payload

        def json(self) -> dict:
            return self._payload

    def fake_post(session, payload, *, chunk_start, chunk_end):
        called.append(payload["dateFrom"])
        return DummyResponse({"data": payload["dateFrom"]})

    def fake_parse(html_snippet: str):
        day = html_snippet
        headers = ["Time", "Cur.", "Imp.", "Event", "Actual", "Forecast", "Previous"]
        return headers, [_day_header(day), ["09:00", "USD", "Low", "X", "", "", ""]]

    monkeypatch.setattr(fetcher, "_post_calendar_with_retries", fake_post)
    monkeypatch.setattr(fetcher, "parse_calendar_html", fake_parse)

    headers = ["Time", "Cur.", "Imp.", "Event", "Actual", "Forecast", "Previous"]
    data = [_day_header("2026-01-16"), ["09:00", "USD", "Low", "BASE", "", "", ""]]

    fetcher._refetch_anomalous_days(  # noqa: SLF001
        session=object(),
        start_date=datetime(2026, 1, 16),
        end_date=datetime(2026, 1, 20),
        headers=headers,
        data=data,
        force_days={"2026-01-17", "2026-01-18", "2026-01-19"},
    )

    assert called == ["2026-01-17", "2026-01-18", "2026-01-19"]
