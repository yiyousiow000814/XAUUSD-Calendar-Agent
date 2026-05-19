from datetime import datetime

from src.xauusd_market_agent.backfill import BackfillManager
from src.xauusd_market_agent.providers.provider_router import ProviderRouter
from src.xauusd_market_agent.timeline_store import TimelineStore


class StubProvider:
    def fetch_latest(self, anchor_time):
        raise NotImplementedError

    def backfill(self, start, end):
        return [
            {
                "symbol": "XAUUSD",
                "data_timestamp": "2026-05-19T06:00:00+08:00",
                "open_price": 4500.0,
                "high_price": 4502.0,
                "low_price": 4499.0,
                "close_price": 4501.0,
                "source": "stub",
                "source_type": "futures_proxy",
                "data_mode": "backfilled",
                "is_stale": False,
                "stale_reason": "",
            },
            {
                "symbol": "XAUUSD",
                "data_timestamp": "2026-05-19T06:15:00+08:00",
                "open_price": 4501.0,
                "high_price": 4503.0,
                "low_price": 4478.0,
                "close_price": 4479.0,
                "source": "stub",
                "source_type": "futures_proxy",
                "data_mode": "backfilled",
                "is_stale": False,
                "stale_reason": "",
            },
            {
                "symbol": "XAUUSD",
                "data_timestamp": "2026-05-19T06:30:00+08:00",
                "open_price": 4479.0,
                "high_price": 4495.0,
                "low_price": 4476.0,
                "close_price": 4490.0,
                "source": "stub",
                "source_type": "futures_proxy",
                "data_mode": "backfilled",
                "is_stale": False,
                "stale_reason": "",
            },
        ], __import__("src.xauusd_market_agent.provider_health", fromlist=["build_provider_health"]).build_provider_health(
            source="XAUUSD",
            source_type="futures_proxy",
            data_mode="backfilled",
            current_value=4490.0,
            previous_value=4500.0,
            change_value=-0.22,
            change_unit="percent",
            data_timestamp="2026-05-19T06:30:00+08:00",
        )


class StubRelatedBackfill:
    def fetch_latest(self, anchor_time):
        raise NotImplementedError

    def backfill(self, start, end):
        health_builder = __import__("src.xauusd_market_agent.provider_health", fromlist=["build_provider_health"]).build_provider_health
        return [
            {"symbol": "dxy", "data_timestamp": "2026-05-19T06:15:00+08:00", "value": 104.2, "change_15m": 0.21, "change_30m": 0.22, "change_60m": 0.23, "change_value": 0.21, "change_unit": "percent", "source": "stub", "source_type": "proxy", "data_mode": "backfilled", "is_stale": False, "stale_reason": ""},
        ], {
            "dxy": health_builder(source="DXY", source_type="proxy", data_mode="backfilled", current_value=104.2, change_value=0.21, change_unit="percent", data_timestamp="2026-05-19T06:15:00+08:00"),
        }


class StubNewsBackfill:
    def fetch_latest(self, anchor_time):
        raise NotImplementedError

    def backfill(self, start, end):
        return [
            {"published_at": "2026-05-19T06:10:00+08:00", "first_seen_at": end.isoformat(), "backfilled_at": end.isoformat(), "is_backfilled": True, "source": "Reuters", "title": "Recovered Fed headline", "link": "", "relevance_reason": "Recovered", "impact_direction_on_gold": "bearish", "data_mode": "backfilled"},
        ], __import__("src.xauusd_market_agent.provider_health", fromlist=["build_provider_health"]).build_provider_health(
            source="News",
            source_type="rss_provider",
            data_mode="backfilled",
            current_value=1.0,
            data_timestamp="2026-05-19T06:10:00+08:00",
        )


class StubCalendarBackfill:
    def fetch_window(self, anchor_time):
        raise NotImplementedError

    def backfill(self, start, end):
        return [
            {"scheduled_at": "2026-05-19T06:00:00+08:00", "source": "ForexFactory", "title": "CPI m/m", "relevance_reason": "USD High impact", "impact_direction_on_gold": "unknown", "data_mode": "backfilled"},
        ], __import__("src.xauusd_market_agent.provider_health", fromlist=["build_provider_health"]).build_provider_health(
            source="Calendar",
            source_type="calendar_provider",
            data_mode="backfilled",
            current_value=1.0,
            data_timestamp="2026-05-19T06:00:00+08:00",
        )


def test_backfill_manager_calls_providers_and_recovery_is_storable(tmp_path) -> None:
    router = ProviderRouter(
        market_provider=StubProvider(),
        related_assets_provider=StubRelatedBackfill(),
        news_provider=StubNewsBackfill(),
        calendar_provider=StubCalendarBackfill(),
    )
    context = BackfillManager(router).recover_gap(
        datetime.fromisoformat("2026-05-19T06:00:00+08:00"),
        datetime.fromisoformat("2026-05-19T06:30:00+08:00"),
    )

    store = TimelineStore(tmp_path / "timeline.sqlite")
    run_id = store.record_monitor_run(
        run_started_at="2026-05-19T06:30:00+08:00",
        run_type="recovery",
        data_mode="backfilled",
        backfill_required=True,
        last_successful_run_at="2026-05-19T05:00:00+08:00",
        no_news_found=False,
        alert_suppressed_reason="",
    )
    store.record_market_price_bars(run_id, context.market_price_bars)
    store.record_related_asset_bars(run_id, context.related_asset_bars)
    store.record_news_items(run_id, context.news_rows)
    store.record_calendar_events(run_id, context.calendar_rows)
    for item in context.recovery_timeline_events:
        store.record_timeline_event(run_id, event_time=item["event_time"], event_type=item["event_type"], label=item["label"], payload=item["payload"])

    replay = store.get_market_replay("2026-05-19T06:00:00+08:00", "2026-05-19T06:30:00+08:00")

    assert len(context.market_price_bars) == 3
    assert context.related_asset_bars
    assert context.news_rows
    assert context.calendar_rows
    assert len(context.recovery_timeline_events) == 2
    assert "Recovered 3 XAUUSD bars" in context.recovery_summary
    assert "1 news items" in context.recovery_summary
    assert "1 calendar events" in context.recovery_summary
    assert context.news_rows[0]["first_seen_at"] == "2026-05-19T06:30:00+08:00"
    assert context.news_rows[0]["backfilled_at"] == "2026-05-19T06:30:00+08:00"
    assert context.news_rows[0]["data_mode"] == "backfilled"
    assert replay["price_series"]
    assert replay["news_items"]
    assert replay["calendar_events"]
    assert replay["timeline_events"][0]["payload"]["data_mode"] == "backfilled"
