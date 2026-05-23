from datetime import datetime
import json

from src.xauusd_market_agent.config import MarketAgentConfig
from src.xauusd_market_agent.live_pipeline import run_monitored_live_once
from src.xauusd_market_agent.provider_health import build_provider_health
from src.xauusd_market_agent.providers.provider_router import ProviderRouter
from src.xauusd_market_agent.timeline_store import TimelineStore


class StubLiveMarketProvider:
    def __init__(self, rows):
        self.rows = rows

    def fetch_latest(self, anchor_time):
        return self.rows, build_provider_health(
            source="cTrader",
            source_type="spot",
            data_mode="live_seen",
            is_available=True,
            data_timestamp=anchor_time.isoformat(),
            current_value=float(self.rows[-1]["close_price"]),
            previous_value=float(self.rows[0]["close_price"]),
            change_value=float(self.rows[-1]["close_price"]) - float(self.rows[0]["close_price"]),
            fetched_at=anchor_time.isoformat(),
        )

    def backfill(self, start, end):
        rows = []
        for row in self.rows:
            rows.append({**row, "data_mode": "backfilled"})
        return rows, build_provider_health(
            source="cTrader",
            source_type="spot",
            data_mode="backfilled",
            is_available=True,
            data_timestamp=end.isoformat(),
            current_value=float(rows[-1]["close_price"]),
            previous_value=float(rows[0]["close_price"]),
            change_value=float(rows[-1]["close_price"]) - float(rows[0]["close_price"]),
            fetched_at=end.isoformat(),
        )


class StubClosedMarketProvider:
    def fetch_latest(self, anchor_time):
        rows = [
            {
                "symbol": "XAUUSD",
                "data_timestamp": "2026-05-19T07:00:00+08:00",
                "open_price": 4500.0,
                "close_price": 4501.0,
                "source": "cTrader",
                "source_type": "spot",
                "data_mode": "stale",
                "is_stale": True,
            },
            {
                "symbol": "XAUUSD",
                "data_timestamp": "2026-05-19T07:15:00+08:00",
                "open_price": 4501.0,
                "close_price": 4479.0,
                "source": "cTrader",
                "source_type": "spot",
                "data_mode": "stale",
                "is_stale": True,
            },
        ]
        return rows, build_provider_health(
            source="cTrader",
            source_type="spot",
            data_mode="stale",
            is_available=True,
            is_stale=True,
            stale_reason="market may be closed",
            data_timestamp="2026-05-19T07:15:00+08:00",
            current_value=4479.0,
            previous_value=4501.0,
            change_value=-22.0,
        )


class StubLiveRelatedAssetsProvider:
    def fetch_latest(self, anchor_time):
        rows = [
            {
                "symbol": "dxy",
                "data_timestamp": anchor_time.isoformat(),
                "change_15m": 0.22,
                "change_value": 0.22,
                "change_unit": "percent",
                "source": "stub",
                "source_type": "proxy",
                "data_mode": "live_seen",
                "is_stale": False,
            },
            {
                "symbol": "us10y",
                "data_timestamp": anchor_time.isoformat(),
                "change_15m": 5.1,
                "change_value": 5.1,
                "change_unit": "bps",
                "source": "stub",
                "source_type": "proxy",
                "data_mode": "live_seen",
                "is_stale": False,
            },
            {
                "symbol": "us2y",
                "data_timestamp": anchor_time.isoformat(),
                "change_15m": 4.4,
                "change_value": 4.4,
                "change_unit": "bps",
                "source": "stub",
                "source_type": "proxy",
                "data_mode": "live_seen",
                "is_stale": False,
            },
        ]
        return rows, {
            "dxy": build_provider_health(
                source="DXY",
                source_type="proxy",
                data_mode="live_seen",
                is_available=True,
                current_value=0.22,
                change_value=0.22,
                change_unit="percent",
                data_timestamp=anchor_time.isoformat(),
            ),
            "us10y": build_provider_health(
                source="US10Y",
                source_type="proxy",
                data_mode="live_seen",
                is_available=True,
                current_value=5.1,
                change_value=5.1,
                change_unit="bps",
                data_timestamp=anchor_time.isoformat(),
            ),
            "us2y": build_provider_health(
                source="US2Y",
                source_type="proxy",
                data_mode="live_seen",
                is_available=True,
                current_value=4.4,
                change_value=4.4,
                change_unit="bps",
                data_timestamp=anchor_time.isoformat(),
            ),
        }

    def backfill(self, start, end):
        return self.fetch_latest(end)


def _live_price_rows() -> list[dict[str, object]]:
    return [
        {
            "symbol": "XAUUSD",
            "data_timestamp": "2026-05-19T07:00:00+08:00",
            "open_price": 4500.0,
            "close_price": 4501.0,
            "source": "cTrader",
            "source_type": "spot",
            "data_mode": "live_seen",
        },
        {
            "symbol": "XAUUSD",
            "data_timestamp": "2026-05-19T07:15:00+08:00",
            "open_price": 4501.0,
            "close_price": 4479.0,
            "source": "cTrader",
            "source_type": "spot",
            "data_mode": "live_seen",
        },
    ]


def _live_router(related_path=None) -> ProviderRouter:
    return ProviderRouter(
        market_provider=StubLiveMarketProvider(_live_price_rows()),
        related_assets_provider=StubLiveRelatedAssetsProvider(),
        csv_related_assets_path=related_path,
        yahoo_enabled=False,
    )


def _fresh_news(anchor_time: str = "2026-05-19T07:14:00+08:00") -> list[dict[str, object]]:
    return [
        {
            "published_at": anchor_time,
            "source": "Reuters",
            "title": "Treasury yields rise as dollar firms before Fed speakers",
            "impact_direction_on_gold": "bearish_gold",
            "matched_keywords": ["yields", "dollar", "fed"],
            "categories": ["macro"],
            "score": 0.8,
        }
    ]


def _closed_router(related_path=None) -> ProviderRouter:
    return ProviderRouter(
        market_provider=StubClosedMarketProvider(),
        related_assets_provider=StubLiveRelatedAssetsProvider(),
        csv_related_assets_path=related_path,
        yahoo_enabled=False,
    )


def test_run_monitored_live_once_writes_state_and_optional_alert(tmp_path) -> None:
    price_path = tmp_path / "prices.csv"
    price_path.write_text(
        "timestamp,open,high,low,close\n"
        "2026-05-19T07:00:00+08:00,4500,4502,4499,4501\n"
        "2026-05-19T07:15:00+08:00,4501,4503,4475,4479\n",
        encoding="utf-8",
    )
    related_path = tmp_path / "related_assets.json"
    related_path.write_text(
        json.dumps({"dxy_percent": 0.22, "us10y_bps": 5.1, "us2y_bps": 4.4}),
        encoding="utf-8",
    )
    year_dir = tmp_path / "calendar" / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text("[]", encoding="utf-8")

    cfg = MarketAgentConfig(
        repo_root=tmp_path,
        price_data_path=price_path,
        calendar_dir=tmp_path / "calendar",
        related_assets_path=related_path,
        rss_feeds=[],
        yahoo_enabled=False,
    )

    outcome = run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T07:15:00+08:00"),
        state_path=tmp_path / "state.json",
        alerts_path=tmp_path / "alerts.ndjson",
        cooldown_minutes=30,
        provider_router=_live_router(related_path),
    )

    assert outcome["analysis"]["main_driver"] == "yields"
    assert outcome["state_transition"]["is_new_state"] is True
    assert outcome["state_transition"]["state_change_reason"]
    assert outcome["state_transition"]["next_state"]["cause_status"] == "likely"
    assert (tmp_path / "state.json").exists()


def test_run_monitored_live_once_suppresses_market_closed_alert(tmp_path) -> None:
    related_path = tmp_path / "related_assets.json"
    related_path.write_text(
        json.dumps({"dxy_percent": 0.22, "us10y_bps": 5.1, "us2y_bps": 4.4}),
        encoding="utf-8",
    )
    year_dir = tmp_path / "calendar" / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text("[]", encoding="utf-8")

    cfg = MarketAgentConfig(
        repo_root=tmp_path,
        calendar_dir=tmp_path / "calendar",
        related_assets_path=related_path,
        rss_feeds=[],
        yahoo_enabled=False,
        telegram_enabled=True,
        telegram_bot_token="token",
        telegram_chat_id="chat",
    )

    outcome = run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T07:20:00+08:00"),
        state_path=tmp_path / "state.json",
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=tmp_path / "timeline.sqlite",
        cooldown_minutes=30,
        telegram_sink=FailingTelegramSink(),
        provider_router=_closed_router(related_path),
    )

    assert outcome["notification"]["should_notify"] is False
    assert outcome["notification"]["telegram"]["status"] == "disabled"
    assert not (tmp_path / "alerts.ndjson").exists()


def test_run_monitored_live_once_suppresses_backfilled_recovery_alert(tmp_path) -> None:
    related_path = tmp_path / "related_assets.json"
    related_path.write_text(
        json.dumps({"dxy_percent": 0.22, "us10y_bps": 5.1, "us2y_bps": 4.4}),
        encoding="utf-8",
    )
    year_dir = tmp_path / "calendar" / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text("[]", encoding="utf-8")
    timeline_path = tmp_path / "timeline.sqlite"
    timeline = TimelineStore(timeline_path)
    timeline.record_monitor_run(
        run_started_at="2026-05-19T04:00:00+08:00",
        run_type="live",
        data_mode="live_seen",
        backfill_required=False,
        last_successful_run_at=None,
        no_news_found=False,
        alert_suppressed_reason="",
    )
    telegram = CapturingTelegramSink()
    cfg = MarketAgentConfig(
        repo_root=tmp_path,
        calendar_dir=tmp_path / "calendar",
        related_assets_path=related_path,
        rss_feeds=[],
        yahoo_enabled=False,
        telegram_enabled=True,
        telegram_bot_token="token",
        telegram_chat_id="chat",
        backfill_gap_minutes=30,
    )

    outcome = run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T07:15:00+08:00"),
        state_path=tmp_path / "state.json",
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=timeline_path,
        cooldown_minutes=30,
        telegram_sink=telegram,
        provider_router=_live_router(related_path),
        news_headlines=_fresh_news(),
    )

    assert outcome["run_type"] == "recovery"
    assert outcome["backfill_required"] is True
    assert outcome["notification"]["should_notify"] is False
    assert outcome["analysis"]["summary"] == (
        "Historical recovery data was stored for replay and evidence only; "
        "it is not a current alert."
    )
    assert telegram.payloads == []
    assert not (tmp_path / "alerts.ndjson").exists()


class FailingTelegramSink:
    def send(self, payload):
        return {
            "sent": False,
            "status": "failed",
            "error": "telegram unavailable",
            "notification_level": payload.get("notification_level", ""),
        }


class CapturingTelegramSink:
    def __init__(self) -> None:
        self.payloads = []

    def send(self, payload):
        self.payloads.append(payload)
        return {
            "sent": True,
            "status": "sent",
            "error": "",
            "notification_level": payload.get("notification_level", ""),
        }


class BlockingReviewClient:
    def analyze(self, evidence_packet):
        return None

    def review_alert(self, payload):
        return {
            "decision": "block",
            "reason": "Alert claims a driver without enough accepted evidence.",
        }


class RewritingReviewClient:
    def analyze(self, evidence_packet):
        return None

    def review_alert(self, payload):
        return {
            "decision": "rewrite",
            "message": str(payload["message"]).replace("Summary:", "Summary: Reviewed."),
            "reason": "clearer",
        }


def test_run_monitored_live_once_records_telegram_failure_without_crashing(tmp_path) -> None:
    price_path = tmp_path / "prices.csv"
    price_path.write_text(
        "timestamp,open,high,low,close\n"
        "2026-05-19T07:00:00+08:00,4500,4502,4499,4501\n"
        "2026-05-19T07:15:00+08:00,4501,4503,4475,4479\n",
        encoding="utf-8",
    )
    related_path = tmp_path / "related_assets.json"
    related_path.write_text(
        json.dumps({"dxy_percent": 0.22, "us10y_bps": 5.1, "us2y_bps": 4.4}),
        encoding="utf-8",
    )
    year_dir = tmp_path / "calendar" / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text("[]", encoding="utf-8")

    cfg = MarketAgentConfig(
        repo_root=tmp_path,
        price_data_path=price_path,
        calendar_dir=tmp_path / "calendar",
        related_assets_path=related_path,
        rss_feeds=[],
        yahoo_enabled=False,
        telegram_enabled=True,
        telegram_bot_token="token",
        telegram_chat_id="chat",
    )

    outcome = run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T07:15:00+08:00"),
        state_path=tmp_path / "state.json",
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=tmp_path / "timeline.sqlite",
        cooldown_minutes=30,
        telegram_sink=FailingTelegramSink(),
        provider_router=_live_router(related_path),
        news_headlines=_fresh_news(),
    )

    assert outcome["notification"]["telegram"]["status"] == "failed"
    assert outcome["notification"]["telegram"]["error"] == "telegram unavailable"


def test_run_monitored_live_once_formats_telegram_alert(tmp_path) -> None:
    related_path = tmp_path / "related_assets.json"
    related_path.write_text(
        json.dumps({"dxy_percent": 0.22, "us10y_bps": 5.1, "us2y_bps": 4.4}),
        encoding="utf-8",
    )
    year_dir = tmp_path / "calendar" / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text("[]", encoding="utf-8")
    telegram = CapturingTelegramSink()
    cfg = MarketAgentConfig(
        repo_root=tmp_path,
        calendar_dir=tmp_path / "calendar",
        related_assets_path=related_path,
        rss_feeds=[],
        yahoo_enabled=False,
        telegram_enabled=True,
        telegram_bot_token="token",
        telegram_chat_id="chat",
    )

    outcome = run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T07:15:00+08:00"),
        state_path=tmp_path / "state.json",
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=tmp_path / "timeline.sqlite",
        cooldown_minutes=30,
        telegram_sink=telegram,
        provider_router=_live_router(related_path),
        news_headlines=_fresh_news(),
    )

    assert outcome["notification"]["should_notify"] is True
    message = telegram.payloads[0]["message"]
    assert message.startswith("XAUUSD Market Agent")
    assert "\nStatus: " in message
    assert "\nMove: " in message
    assert "\nDriver: " in message
    assert "\nEvidence: " in message
    assert "\nSummary: " in message
    assert "\nData: " in message


def test_run_monitored_live_once_llm_review_can_block_alert(tmp_path) -> None:
    related_path = tmp_path / "related_assets.json"
    related_path.write_text(
        json.dumps({"dxy_percent": 0.22, "us10y_bps": 5.1, "us2y_bps": 4.4}),
        encoding="utf-8",
    )
    year_dir = tmp_path / "calendar" / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text("[]", encoding="utf-8")
    telegram = CapturingTelegramSink()
    cfg = MarketAgentConfig(
        repo_root=tmp_path,
        calendar_dir=tmp_path / "calendar",
        related_assets_path=related_path,
        rss_feeds=[],
        yahoo_enabled=False,
        telegram_enabled=True,
        telegram_bot_token="token",
        telegram_chat_id="chat",
    )

    outcome = run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T07:15:00+08:00"),
        state_path=tmp_path / "state.json",
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=tmp_path / "timeline.sqlite",
        cooldown_minutes=30,
        telegram_sink=telegram,
        provider_router=_live_router(related_path),
        news_headlines=_fresh_news(),
        llm_client=BlockingReviewClient(),
    )

    assert outcome["notification"]["should_notify"] is False
    assert outcome["notification"]["reason"] == "Analysis result does not require notification."
    assert outcome["notification"]["alert_preflight"]["status"] == "blocked"
    assert telegram.payloads == []
    assert not (tmp_path / "alerts.ndjson").exists()


def test_run_monitored_live_once_llm_review_can_rewrite_alert(tmp_path) -> None:
    related_path = tmp_path / "related_assets.json"
    related_path.write_text(
        json.dumps({"dxy_percent": 0.22, "us10y_bps": 5.1, "us2y_bps": 4.4}),
        encoding="utf-8",
    )
    year_dir = tmp_path / "calendar" / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text("[]", encoding="utf-8")
    telegram = CapturingTelegramSink()
    cfg = MarketAgentConfig(
        repo_root=tmp_path,
        calendar_dir=tmp_path / "calendar",
        related_assets_path=related_path,
        rss_feeds=[],
        yahoo_enabled=False,
        telegram_enabled=True,
        telegram_bot_token="token",
        telegram_chat_id="chat",
    )

    outcome = run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T07:15:00+08:00"),
        state_path=tmp_path / "state.json",
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=tmp_path / "timeline.sqlite",
        cooldown_minutes=30,
        telegram_sink=telegram,
        provider_router=_live_router(related_path),
        news_headlines=_fresh_news(),
        llm_client=RewritingReviewClient(),
    )

    assert outcome["notification"]["should_notify"] is True
    assert outcome["notification"]["alert_preflight"]["status"] == "rewritten"
    assert "Summary: Reviewed." in telegram.payloads[0]["message"]


def test_run_monitored_live_once_records_semantic_timeline_event(tmp_path) -> None:
    price_path = tmp_path / "prices.csv"
    price_path.write_text(
        "timestamp,open,high,low,close\n"
        "2026-05-19T07:00:00+08:00,4500,4502,4499,4501\n"
        "2026-05-19T07:15:00+08:00,4501,4503,4475,4479\n",
        encoding="utf-8",
    )
    related_path = tmp_path / "related_assets.json"
    related_path.write_text(
        json.dumps({"dxy_percent": 0.22, "us10y_bps": 5.1, "us2y_bps": 4.4}),
        encoding="utf-8",
    )
    year_dir = tmp_path / "calendar" / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text("[]", encoding="utf-8")
    timeline_path = tmp_path / "timeline.sqlite"

    cfg = MarketAgentConfig(
        repo_root=tmp_path,
        price_data_path=price_path,
        calendar_dir=tmp_path / "calendar",
        related_assets_path=related_path,
        rss_feeds=[],
        yahoo_enabled=False,
    )

    run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T07:15:00+08:00"),
        state_path=tmp_path / "state.json",
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=timeline_path,
        cooldown_minutes=30,
        provider_router=_live_router(related_path),
    )

    timeline = TimelineStore(timeline_path).get_timeline(
        "2026-05-19T07:00:00+08:00",
        "2026-05-19T07:30:00+08:00",
    )

    assert timeline[0]["payload"]["semantic_type"] == "breakout"
    assert timeline[0]["payload"]["impact_percent"] < 0
    assert timeline[0]["payload"]["main_driver"] == "yields"
