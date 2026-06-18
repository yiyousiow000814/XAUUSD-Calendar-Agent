from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time, timezone


WEEKEND_CLOSE_UTC = time(22, 0)
WEEKEND_REOPEN_UTC = time(22, 0)
MAX_WEEKEND_CONTEXT_AGE_SECONDS = 96 * 60 * 60
MAX_CLOCK_SKEW_SECONDS = 5


@dataclass(frozen=True)
class StaleQuoteClassification:
    classification: str
    reason: str
    age_seconds: float | None
    market_closed: bool


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def is_xauusd_weekend_closed(anchor_time: datetime) -> bool:
    anchor = _utc(anchor_time)
    weekday = anchor.weekday()
    current_time = anchor.time()
    if weekday == 5:
        return True
    if weekday == 6 and current_time < WEEKEND_REOPEN_UTC:
        return True
    if weekday == 4 and current_time >= WEEKEND_CLOSE_UTC:
        return True
    return False


def classify_xauusd_stale_quote(
    *,
    quote_time: datetime | None,
    anchor_time: datetime,
    stale_after_seconds: int,
) -> StaleQuoteClassification:
    if quote_time is None:
        return StaleQuoteClassification(
            classification="invalid_timestamp",
            reason="cTrader quote timestamp is missing or invalid.",
            age_seconds=None,
            market_closed=False,
        )

    anchor = _utc(anchor_time)
    quote = _utc(quote_time)
    age_seconds = (anchor - quote).total_seconds()
    if -MAX_CLOCK_SKEW_SECONDS <= age_seconds <= max(1, stale_after_seconds):
        return StaleQuoteClassification(
            classification="fresh",
            reason="cTrader quote is fresh.",
            age_seconds=age_seconds,
            market_closed=False,
        )
    if age_seconds < 0:
        return StaleQuoteClassification(
            classification="future_timestamp",
            reason="cTrader quote timestamp is ahead of local time; check system clock.",
            age_seconds=age_seconds,
            market_closed=False,
        )

    market_closed = is_xauusd_weekend_closed(anchor)
    if market_closed and age_seconds <= MAX_WEEKEND_CONTEXT_AGE_SECONDS:
        return StaleQuoteClassification(
            classification="market_closed",
            reason="XAUUSD is inside the weekend closed window; last cTrader quote is context only until the market reopens.",
            age_seconds=age_seconds,
            market_closed=True,
        )

    return StaleQuoteClassification(
        classification="feed_paused",
        reason="cTrader quote is stale while the market is expected to be open; live feed may be paused.",
        age_seconds=age_seconds,
        market_closed=False,
    )
