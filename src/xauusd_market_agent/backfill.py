from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from .providers.provider_router import ProviderRouter


@dataclass(frozen=True)
class BackfillContext:
    market_price_bars: list[dict[str, Any]]
    related_asset_bars: list[dict[str, Any]]
    news_rows: list[dict[str, Any]]
    calendar_rows: list[dict[str, Any]]
    provider_health: dict[str, Any]
    recovery_summary: str
    recovery_timeline_events: list[dict[str, Any]]


def _parse_ts(raw: str) -> datetime:
    return datetime.fromisoformat(raw)


def _price_segments(market_price_bars: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if len(market_price_bars) < 2:
        return []
    rows = sorted(market_price_bars, key=lambda item: item["data_timestamp"])
    segments: list[dict[str, Any]] = []
    segment_start = rows[0]
    last_direction = 0
    for idx in range(1, len(rows)):
        previous = rows[idx - 1]
        current = rows[idx]
        prev_close = float(previous["close_price"])
        curr_close = float(current["close_price"])
        direction = 1 if curr_close > prev_close else -1 if curr_close < prev_close else 0
        if last_direction == 0:
            last_direction = direction
            continue
        if direction != 0 and direction != last_direction:
            segments.append(
                {
                    "start": segment_start["data_timestamp"],
                    "end": previous["data_timestamp"],
                    "from_price": segment_start["open_price"] or segment_start["close_price"],
                    "to_price": previous["close_price"],
                }
            )
            segment_start = previous
            last_direction = direction
    segments.append(
        {
            "start": segment_start["data_timestamp"],
            "end": rows[-1]["data_timestamp"],
            "from_price": segment_start["open_price"] or segment_start["close_price"],
            "to_price": rows[-1]["close_price"],
        }
    )
    enriched: list[dict[str, Any]] = []
    for segment in segments:
        from_price = float(segment["from_price"])
        to_price = float(segment["to_price"])
        enriched.append(
            {
                **segment,
                "move_percent": 0.0 if from_price == 0 else ((to_price - from_price) / from_price) * 100.0,
            }
        )
    return enriched


def _segment_semantic_type(segment: dict[str, Any]) -> str:
    move = abs(float(segment.get("move_percent", 0.0)))
    if move >= 0.35:
        return "breakout"
    if move <= 0.12:
        return "range"
    return "recovery"


class BackfillManager:
    def __init__(self, provider_router: ProviderRouter) -> None:
        self.provider_router = provider_router

    def recover_gap(self, start: datetime, end: datetime) -> BackfillContext:
        market_rows, market_health = self.provider_router.backfill_market_context(start, end)
        related_rows, related_health = self.provider_router.backfill_related_assets(start, end)
        news_rows, news_health = self.provider_router.backfill_news(start, end)
        calendar_rows, calendar_health = self.provider_router.backfill_calendar(start, end)

        segments = _price_segments(market_rows)
        summary_parts = [
            f"Recovered {len(market_rows)} XAUUSD bars",
            f"{len(related_rows)} related-asset rows",
            f"{len(news_rows)} news items",
            f"{len(calendar_rows)} calendar events",
            f"from {start.isoformat()} to {end.isoformat()}",
        ]
        recovery_events = [
            {
                "event_time": segment["end"],
                "event_type": "recovery_analysis",
                "label": "reconstructed_move",
                "payload": {
                    "data_mode": "backfilled",
                    "semantic_type": _segment_semantic_type(segment),
                    "impact_percent": segment["move_percent"],
                    "direction": "up" if segment["move_percent"] > 0 else "down" if segment["move_percent"] < 0 else "flat",
                    "duration_minutes": 0,
                    "segment": segment,
                },
            }
            for segment in segments
        ]
        if not recovery_events:
            recovery_events.append(
                {
                    "event_time": end.isoformat(),
                    "event_type": "recovery_analysis",
                    "label": "backfill",
                    "payload": {
                        "data_mode": "backfilled",
                        "semantic_type": "range",
                        "impact_percent": 0.0,
                        "direction": "flat",
                        "segment_count": 0,
                    },
                }
            )
        return BackfillContext(
            market_price_bars=market_rows,
            related_asset_bars=related_rows,
            news_rows=news_rows,
            calendar_rows=calendar_rows,
            provider_health={
                "xauusd": market_health,
                **related_health,
                "news": news_health,
                "calendar": calendar_health,
            },
            recovery_summary=", ".join(summary_parts) + ".",
            recovery_timeline_events=recovery_events,
        )
