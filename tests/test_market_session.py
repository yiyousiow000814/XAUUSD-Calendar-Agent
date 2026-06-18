from datetime import datetime, timedelta

from src.xauusd_market_agent.market_session import classify_xauusd_stale_quote


def test_small_ctrader_clock_skew_is_still_fresh() -> None:
    anchor = datetime.fromisoformat("2026-06-11T18:55:59+08:00")
    quote = anchor + timedelta(milliseconds=650)

    status = classify_xauusd_stale_quote(
        quote_time=quote,
        anchor_time=anchor,
        stale_after_seconds=20,
    )

    assert status.classification == "fresh"
    assert status.market_closed is False

