from datetime import datetime
import json
import sqlite3
from types import SimpleNamespace

from src.xauusd_market_agent.config import MarketAgentConfig
import src.xauusd_market_agent.live_pipeline as live_pipeline
from src.xauusd_market_agent.live_pipeline import (
    _apply_display_summaries,
    _build_evidence_chain_status,
    _build_market_read,
    _ctrader_activity,
    _history_activity,
    _market_read_driver_evidence_titles,
    _market_read_driver_matched_titles,
    _safe_market_read_title,
    run_monitored_live_once,
)
from src.xauusd_market_agent.models import (
    CrossAssetSnapshot,
    EvidenceChainStatus,
    Headline,
    MarketMove,
    ProviderHealth,
    ScenarioFixture,
)
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


class SequentialLiveMarketProvider:
    def __init__(self, rows):
        self.rows = rows
        self.index = 0

    def fetch_latest(self, anchor_time):
        row = self.rows[min(self.index, len(self.rows) - 1)]
        self.index += 1
        return [row], build_provider_health(
            source="cTrader",
            source_type="spot",
            data_mode="live_seen",
            is_available=True,
            data_timestamp=str(row["data_timestamp"]),
            current_value=float(row["close_price"]),
            previous_value=float(row["close_price"]),
            change_value=0.0,
            fetched_at=anchor_time.isoformat(),
        )

    def backfill(self, start, end):
        return [], build_provider_health(
            source="cTrader",
            source_type="spot",
            data_mode="backfilled",
            is_available=False,
            data_timestamp=end.isoformat(),
            stale_reason="No backfill in sequential test provider.",
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


class StubUnavailableMarketProvider:
    def fetch_latest(self, anchor_time):
        return [], build_provider_health(
            source="XAUUSD",
            source_type="provider_interface",
            data_mode="unavailable",
            is_available=False,
            is_stale=False,
            stale_reason="Waiting for fresh cTrader live stream snapshot.",
            error="Waiting for fresh cTrader live stream snapshot.",
            data_timestamp=anchor_time.isoformat(),
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


class StubNeutralRelatedAssetsProvider:
    def fetch_latest(self, anchor_time):
        rows = []
        health = {}
        for symbol, source in (("dxy", "DXY"), ("us10y", "US10Y"), ("us2y", "US2Y")):
            rows.append(
                {
                    "symbol": symbol,
                    "data_timestamp": anchor_time.isoformat(),
                    "change_15m": 0.0,
                    "change_value": 0.0,
                    "change_unit": "bps" if symbol.startswith("us") else "percent",
                    "source": "stub",
                    "source_type": "proxy",
                    "data_mode": "live_seen",
                    "is_stale": False,
                }
            )
            health[symbol] = build_provider_health(
                source=source,
                source_type="proxy",
                data_mode="live_seen",
                is_available=True,
                current_value=0.0,
                change_value=0.0,
                change_unit="bps" if symbol.startswith("us") else "percent",
                data_timestamp=anchor_time.isoformat(),
            )
        return rows, health

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


def _neutral_live_router() -> ProviderRouter:
    return ProviderRouter(
        market_provider=StubLiveMarketProvider(
            [
                {
                    "symbol": "XAUUSD",
                    "data_timestamp": "2026-05-19T07:00:00+08:00",
                    "open_price": 4500.0,
                    "close_price": 4500.0,
                    "source": "cTrader",
                    "source_type": "spot",
                    "data_mode": "live_seen",
                },
                {
                    "symbol": "XAUUSD",
                    "data_timestamp": "2026-05-19T07:15:00+08:00",
                    "open_price": 4500.0,
                    "close_price": 4501.0,
                    "source": "cTrader",
                    "source_type": "spot",
                    "data_mode": "live_seen",
                },
            ]
        ),
        related_assets_provider=StubNeutralRelatedAssetsProvider(),
        yahoo_enabled=False,
    )


def _sequential_live_router(related_path=None) -> ProviderRouter:
    return ProviderRouter(
        market_provider=SequentialLiveMarketProvider(_live_price_rows()),
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


def _unavailable_router(related_path=None) -> ProviderRouter:
    return ProviderRouter(
        market_provider=StubUnavailableMarketProvider(),
        related_assets_provider=StubLiveRelatedAssetsProvider(),
        csv_related_assets_path=related_path,
        yahoo_enabled=False,
    )


def test_ctrader_activity_distinguishes_feed_paused_from_market_closed() -> None:
    feed_paused = build_provider_health(
        source="cTrader",
        source_type="spot",
        data_mode="stale",
        is_available=True,
        is_stale=True,
        current_value=4332.59,
        data_timestamp="2026-06-17T03:43:33+00:00",
        stale_reason="cTrader quote is stale while the market is expected to be open; live feed may be paused.",
        metadata={"market_closed": False, "stale_classification": "feed_paused"},
    )
    market_closed = build_provider_health(
        source="cTrader",
        source_type="spot",
        data_mode="stale",
        is_available=True,
        is_stale=True,
        current_value=4332.59,
        data_timestamp="2026-06-14T03:43:33+00:00",
        stale_reason="XAUUSD is inside the weekend closed window.",
        metadata={"market_closed": True, "stale_classification": "market_closed"},
    )

    paused_activity = _ctrader_activity(feed_paused)
    closed_activity = _ctrader_activity(market_closed)

    assert paused_activity["status"] == "stale"
    assert paused_activity["label"] == "cTrader not refreshing"
    assert "Market closed" not in paused_activity["label"]
    assert closed_activity["status"] == "market_closed"
    assert closed_activity["label"] == "Market closed"


def test_evidence_chain_distinguishes_stale_xauusd_from_market_closed() -> None:
    fixture = ScenarioFixture(
        scenario_id="feed_paused",
        as_of_myt="18-06-2026 06:10",
        market=MarketMove(
            symbol="XAUUSD",
            from_price=4256.5,
            to_price=4258.3,
            move_percent=0.04,
            move_percent_15m=0.04,
            move_percent_1h=0.04,
            window_minutes=15,
        ),
        cross_asset=CrossAssetSnapshot(
            dxy_percent=0.0,
            us10y_bps=0.0,
            us2y_bps=0.0,
            wti_percent=0.0,
            brent_percent=0.0,
            vix_percent=0.0,
            spx_percent=0.0,
            nasdaq_percent=0.0,
        ),
    )
    provider_health = {
        "xauusd": build_provider_health(
            source="cTrader",
            source_type="spot",
            data_mode="stale",
            is_available=True,
            is_stale=True,
            current_value=4258.3,
            stale_reason="cTrader quote is stale while the market is expected to be open; live feed may be paused.",
            metadata={"market_closed": False, "stale_classification": "feed_paused"},
        )
    }

    chain = _build_evidence_chain_status(
        fixture=fixture,
        provider_health=provider_health,
        evidence_status={"news": "relevant_news_found"},
        data_mode="stale",
        market_price_bar_count=1,
        related_asset_bar_count=3,
        news_row_count=1,
        calendar_row_count=1,
    )

    assert "stale_xauusd_spot" in chain.context_only_inputs
    assert "market_closed_last_xauusd_spot" not in chain.context_only_inputs
    assert "live quote is stale" in chain.reason


def test_evidence_chain_names_stale_cross_market_inputs_as_stale_not_unavailable() -> None:
    fixture = ScenarioFixture(
        scenario_id="partial_cross_market",
        as_of_myt="18-06-2026 06:10",
        market=MarketMove(
            symbol="XAUUSD",
            from_price=4256.5,
            to_price=4258.3,
            move_percent=0.04,
            move_percent_15m=0.04,
            move_percent_1h=0.04,
            window_minutes=15,
        ),
        cross_asset=CrossAssetSnapshot(
            dxy_percent=0.0,
            us10y_bps=0.0,
            us2y_bps=0.0,
            wti_percent=0.0,
            brent_percent=0.0,
            vix_percent=0.0,
            spx_percent=0.0,
            nasdaq_percent=0.0,
        ),
    )

    chain = _build_evidence_chain_status(
        fixture=fixture,
        provider_health={
            "xauusd": build_provider_health(
                source="cTrader",
                source_type="spot",
                data_mode="live_seen",
                is_available=True,
                is_stale=False,
                current_value=4258.3,
            )
        },
        evidence_status={
            "dxy": "stale",
            "us2y": "stale",
            "vix_equities": "unavailable",
            "news": "relevant_news_found",
        },
        data_mode="live_seen",
        market_price_bar_count=2,
        related_asset_bar_count=3,
        news_row_count=1,
        calendar_row_count=1,
    )

    assert chain.status == "partial"
    assert "dxy_stale" in chain.context_only_inputs
    assert "us2y_stale" in chain.context_only_inputs
    assert "vix_equities_unavailable" in chain.context_only_inputs
    assert "dxy_unavailable" not in chain.context_only_inputs


def test_history_activity_separates_xauusd_history_from_sensor_rows() -> None:
    activity = _history_activity(
        False,
        stored_rows=579,
        symbols=["XAUUSD", "DXY", "US10Y"],
        symbol_rows={"XAUUSD": 1, "DXY": 300, "US10Y": 278},
    )

    assert activity["storedRows"] == 579
    assert activity["xauusdRows"] == 1
    assert activity["sensorRows"] == 578
    assert activity["jobs"][1]["output"] == "1 XAUUSD row(s), 578 sensor row(s)"
    assert "needs another fresh bar" in activity["detail"]


def test_apply_display_summaries_uses_llm_output_without_losing_raw_rows() -> None:
    class SummaryClient:
        def summarize_display(self, payload):
            assert payload["evidence_packet"]["as_of_myt"]
            return {
                "news": [
                    {
                        "source_index": 0,
                        "summary_title": "Fed rates keep pressure on gold",
                        "summary": "Fed headline lifted yields; gold pressure stayed active.",
                        "impact_direction_on_gold": "bearish",
                    }
                ],
                "calendar": [
                    {
                        "source_index": 0,
                        "summary_title": "US Calendar Context",
                        "summary": "US calendar risk stayed in the evidence packet.",
                        "impact_direction_on_gold": "neutral",
                    }
                ],
                "related_assets": {
                    "dxy": [
                        {
                            "source_index": 0,
                            "summary": "DXY strength confirmed USD pressure on gold.",
                        }
                    ]
                },
            }

    runtime_context = {
        "news_rows": [{"title": "Long raw Fed headline", "source": "Reuters"}],
        "calendar_rows": [{"title": "Long raw calendar event", "source": "ForexFactory"}],
        "related_asset_bars": [{"symbol": "dxy", "change_15m": 0.22}],
    }
    packet = {"as_of_myt": "19-05-2026 08:05", "allowed_candidate_drivers": ["yields"]}
    analysis = {"main_driver": "yields", "summary": "Yields pressure."}

    _apply_display_summaries(SummaryClient(), runtime_context, packet, analysis)

    assert runtime_context["news_rows"][0]["title"] == "Long raw Fed headline"
    assert runtime_context["news_rows"][0]["summary_title"] == "Fed rates keep pressure on gold"
    assert runtime_context["news_rows"][0]["summary"] == "Fed headline lifted yields; gold pressure stayed active."
    assert runtime_context["news_rows"][0]["impact_direction_on_gold"] == "bearish"
    assert runtime_context["news_rows"][0]["impact_direction_source"] == "local_ai"
    assert runtime_context["calendar_rows"][0]["summary_title"] == "US Calendar Context"
    assert runtime_context["calendar_rows"][0]["impact_direction_on_gold"] == "neutral"
    assert runtime_context["related_asset_bars"][0]["summary"] == "DXY strength confirmed USD pressure on gold."
    assert runtime_context["display_summary_status"] == "summarized"


def test_apply_display_summaries_rejects_keyword_pile_news_title() -> None:
    class SummaryClient:
        def summarize_display(self, payload):
            return {
                "news": [
                    {
                        "source_index": 0,
                        "summary_title": "Trump peace deal Iran",
                        "summary": "Trump says a Sunday Iran deal could reopen Hormuz.",
                    }
                ]
            }

    runtime_context = {
        "news_rows": [
            {
                "title": "Trump says Iran deal will be signed Sunday, Strait of Hormuz to open immediately after",
                "source": "US Top News and Analysis",
            }
        ],
        "calendar_rows": [],
        "related_asset_bars": [],
    }
    packet = {"as_of_myt": "14-06-2026 08:05", "allowed_candidate_drivers": ["geopolitics"]}
    analysis = {"main_driver": "geopolitics", "summary": "Hormuz risk is being watched."}

    _apply_display_summaries(SummaryClient(), runtime_context, packet, analysis)

    assert "summary_title" not in runtime_context["news_rows"][0]
    assert runtime_context["news_rows"][0]["summary"] == "Trump says a Sunday Iran deal could reopen Hormuz."
    assert runtime_context["display_summary_status"] == "summarized"


def test_run_monitored_live_once_persists_display_summaries_to_timeline(tmp_path) -> None:
    class SummaryLLM:
        class Config:
            enabled = True
            model = "test-llm"
            display_summary_enabled = True

        config = Config()

        def __init__(self) -> None:
            self.telemetry: list[dict[str, object]] = []

        def analyze(self, evidence_packet):
            return {
                "bias": "bearish_gold",
                "main_driver": "yields",
                "secondary_driver": "usd",
                "cause_status": "likely",
                "confidence": "medium",
                "is_new_state": True,
                "is_continuation": False,
                "previous_state_invalidated": False,
                "should_notify": False,
                "notification_level": "none",
                "no_news_found": False,
                "allowed_candidate_drivers_used": ["yields", "usd"],
                "rejected_or_blocked_drivers_acknowledged": True,
                "timeline": [],
                "cross_asset_confirmation": {
                    "dxy": "confirming",
                    "us10y": "confirming",
                    "us2y": "confirming",
                    "oil": "not_confirming",
                    "vix_equities": "not_confirming",
                },
                "evidence_status": {
                    "dxy": "confirming",
                    "us10y": "confirming",
                    "us2y": "confirming",
                    "oil": "not_confirming",
                    "vix_equities": "not_confirming",
                    "news": "relevant_news_found",
                },
                "causal_chain": "Yields and USD pressure are confirmed.",
                "invalidation_conditions": [],
                "user_message": "Gold remains under pressure from yields and USD.",
            }

        def summarize_display(self, payload):
            self.telemetry.append({"task": "display_summary", "status": "ok", "model": "test-llm"})
            return {
                "news": [
                    {
                        "source_index": 0,
                        "summary_title": "Yields Lift Dollar",
                        "summary": "Yields and dollar strength keep bearish pressure on XAUUSD.",
                        "impact_direction_on_gold": "bearish",
                    }
                ],
            }

        def get_telemetry(self):
            return self.telemetry

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
        news_headlines=_fresh_news(),
        llm_client=SummaryLLM(),
    )

    with sqlite3.connect(timeline_path) as connection:
        news_payload = json.loads(
            connection.execute("SELECT payload_json FROM news_items ORDER BY id DESC LIMIT 1").fetchone()[0]
        )
        analysis_payload = json.loads(
            connection.execute("SELECT payload_json FROM analysis_results ORDER BY id DESC LIMIT 1").fetchone()[0]
        )

    assert news_payload["summary_title"] == "Yields Lift Dollar"
    assert news_payload["summary_source"] == "local_ai"
    assert news_payload["impact_direction_on_gold"] == "bearish"
    assert news_payload["impact_direction_source"] == "local_ai"
    assert analysis_payload["display_summary_status"] == "summarized"
    assert analysis_payload["llm_telemetry"][0]["task"] == "display_summary"


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
        timeline_store_path=tmp_path / "timeline.sqlite",
        yahoo_enabled=False,
    )

    outcome = run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T07:15:00+08:00"),
        state_path=tmp_path / "state.json",
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=tmp_path / "timeline.sqlite",
        cooldown_minutes=30,
        provider_router=_live_router(related_path),
    )

    assert outcome["analysis"]["main_driver"] == "yields"
    market_read = outcome["evidence_packet"]["market_read"]
    assert market_read["status"] == "current_read"
    assert market_read["driver"] == "yields"
    assert market_read["headline"]
    assert market_read["thesis"]
    assert market_read["coverage"]["sensors"]
    assert outcome["state_transition"]["is_new_state"] is True
    assert outcome["state_transition"]["state_change_reason"]
    assert outcome["state_transition"]["next_state"]["cause_status"] == "likely"
    assert (tmp_path / "state.json").exists()
    with sqlite3.connect(tmp_path / "timeline.sqlite") as connection:
        stored_payload = json.loads(
            connection.execute("SELECT payload_json FROM analysis_results ORDER BY id DESC LIMIT 1").fetchone()[0]
        )
        timeline_payload = json.loads(
            connection.execute("SELECT payload_json FROM timeline_events ORDER BY id DESC LIMIT 1").fetchone()[0]
        )
    assert stored_payload["market_read"]["driver"] == "yields"
    assert timeline_payload["market_read"]["driver"] == "yields"
    assert timeline_payload["summary_title"] == timeline_payload["market_read"]["headline"]
    assert timeline_payload["summary_title"] != "Unknown"


def test_unconfirmed_live_run_stores_market_read_title_in_timeline(tmp_path) -> None:
    year_dir = tmp_path / "calendar" / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text("[]", encoding="utf-8")
    timeline_path = tmp_path / "timeline.sqlite"
    cfg = MarketAgentConfig(
        repo_root=tmp_path,
        calendar_dir=tmp_path / "calendar",
        rss_feeds=[],
        timeline_store_path=timeline_path,
        yahoo_enabled=False,
    )

    outcome = run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T07:15:00+08:00"),
        state_path=tmp_path / "state.json",
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=timeline_path,
        cooldown_minutes=30,
        provider_router=_neutral_live_router(),
        news_headlines=[],
    )

    assert outcome["analysis"]["main_driver"] == "unknown"
    assert outcome["evidence_packet"]["market_read"]["headline"] != "Unknown"
    with sqlite3.connect(timeline_path) as connection:
        timeline_payload = json.loads(
            connection.execute("SELECT payload_json FROM timeline_events ORDER BY id DESC LIMIT 1").fetchone()[0]
        )

    assert timeline_payload["main_driver"] == "unknown"
    assert timeline_payload["market_read"]["status"] == "no_conclusion"
    assert timeline_payload["summary_title"] == timeline_payload["market_read"]["headline"]
    assert timeline_payload["summary_title"] != "Unknown"


def test_market_read_keeps_news_context_as_market_observation_when_trade_call_is_unconfirmed() -> None:
    fixture = ScenarioFixture(
        scenario_id="context_observation",
        as_of_myt="2026-06-18T10:00:00+08:00",
        market=MarketMove(
            symbol="XAUUSD",
            from_price=4100.0,
            to_price=4101.0,
            move_percent=0.02,
            move_percent_15m=0.02,
            move_percent_1h=0.02,
            window_minutes=15,
        ),
        cross_asset=CrossAssetSnapshot(
            dxy_percent=0.0,
            us10y_bps=0.0,
            us2y_bps=0.0,
            wti_percent=0.0,
            brent_percent=0.0,
            vix_percent=0.0,
            spx_percent=0.0,
            nasdaq_percent=0.0,
        ),
        news=(
            Headline(
                timestamp_myt="2026-06-18T09:45:00+08:00",
                source="Reuters",
                title="Fed officials keep rate-cut debate alive before gold tests resistance",
                relevance_reason="Fed/rates context for gold",
                impact_direction_on_gold="unknown",
                tags=("fed", "rates", "gold"),
            ),
        ),
        calendar_events=(
            Headline(
                timestamp_myt="2026-06-18T20:30:00+08:00",
                source="Economic Calendar",
                title="US Initial Jobless Claims",
                relevance_reason="USD high-impact calendar event",
                impact_direction_on_gold="unknown",
                tags=("usd", "labor"),
            ),
        ),
    )
    market_read = _build_market_read(
        fixture=fixture,
        provider_health={
            "xauusd": build_provider_health(
                source="cTrader",
                source_type="spot",
                data_mode="live_seen",
                is_available=True,
                data_timestamp="2026-06-18T10:00:00+08:00",
            )
        },
        attention_snapshot=None,
        analysis=SimpleNamespace(
            main_driver="unknown",
            cause_status="unconfirmed",
            confidence="low",
            bias="neutral",
            analysis_engine="llm_validated",
            llm_status="ok",
        ),
        chain_status=EvidenceChainStatus(
            status="partial",
            can_show_current_conclusion=True,
            reason="Evidence is reviewed but not confirming.",
            missing_required=[],
            usable_inputs=["news_context", "calendar_context", "live_xauusd_price", "xauusd_recent_history"],
            context_only_inputs=[],
        ),
        previous_state=SimpleNamespace(main_driver="unknown", current_bias="neutral"),
        evidence_status={"news": "relevant_news_found"},
    )

    assert market_read["status"] == "market_observation"
    assert market_read["headline"] == "Fed officials keep rate-cut debate alive before gold tests resistance"
    assert "trade call" in market_read["thesis"].lower()
    assert "US Initial Jobless Claims" in market_read["evidence"]["calendar"]
    assert market_read["watch_next"]
    analyst_read = market_read["analyst_read"]
    assert analyst_read["schema"] == "market_read.v1"
    assert analyst_read["conclusion_type"] == "market_observation"
    assert analyst_read["trade_call_ready"] is False
    assert "Fed officials keep rate-cut debate alive" in analyst_read["now"]
    assert any("Calendar: US Initial Jobless Claims" == item for item in analyst_read["next"])


def test_market_read_keeps_news_observation_when_recent_history_is_missing() -> None:
    fixture = ScenarioFixture(
        scenario_id="live_context_waiting_history",
        as_of_myt="2026-06-18T10:00:00+08:00",
        market=MarketMove(
            symbol="XAUUSD",
            from_price=4100.0,
            to_price=4096.0,
            move_percent=-0.1,
            move_percent_15m=-0.1,
            move_percent_1h=-0.1,
            window_minutes=15,
        ),
        cross_asset=CrossAssetSnapshot(
            dxy_percent=0.0,
            us10y_bps=0.0,
            us2y_bps=0.0,
            wti_percent=0.0,
            brent_percent=0.0,
            vix_percent=0.0,
            spx_percent=0.0,
            nasdaq_percent=0.0,
        ),
        news=(
            Headline(
                timestamp_myt="2026-06-18T09:45:00+08:00",
                source="Reuters",
                title="Fed keeps rates high while gold waits for price confirmation",
                relevance_reason="Fed/rates context for gold",
                impact_direction_on_gold="unknown",
                tags=("fed", "rates", "gold"),
            ),
        ),
    )

    market_read = _build_market_read(
        fixture=fixture,
        provider_health={
            "xauusd": build_provider_health(
                source="cTrader",
                source_type="spot",
                data_mode="live_seen",
                is_available=True,
                data_timestamp="2026-06-18T10:00:00+08:00",
            )
        },
        attention_snapshot=None,
        analysis=SimpleNamespace(
            main_driver="unknown",
            cause_status="unconfirmed",
            confidence="low",
            bias="neutral",
            analysis_engine="llm_validated",
            llm_status="validated",
        ),
        chain_status=EvidenceChainStatus(
            status="context_only",
            can_show_current_conclusion=False,
            reason="A current XAUUSD trade read needs recent price history.",
            missing_required=["xauusd_recent_history"],
            usable_inputs=["live_xauusd_spot", "news_context", "llm_validated"],
            context_only_inputs=["cross_market_sensors"],
        ),
        previous_state=SimpleNamespace(main_driver="unknown", current_bias="neutral"),
        evidence_status={"news": "relevant_news_found"},
    )

    assert market_read["status"] == "market_observation"
    assert market_read["headline"] == "Fed keeps rates high while gold waits for price confirmation"
    assert "not a trade call" in market_read["thesis"].lower()
    assert market_read["coverage"]["recent_history"] == "missing"
    assert market_read["analyst_read"]["conclusion_type"] == "market_observation"
    assert any("Missing required input: xauusd_recent_history" == item for item in market_read["analyst_read"]["risks"])


def test_market_read_keeps_news_observation_when_live_price_is_unavailable() -> None:
    fixture = ScenarioFixture(
        scenario_id="unavailable_price_news_context",
        as_of_myt="2026-06-18T10:00:00+08:00",
        market=MarketMove(
            symbol="XAUUSD",
            from_price=0.0,
            to_price=0.0,
            move_percent=0.0,
            move_percent_15m=0.0,
            move_percent_1h=0.0,
            window_minutes=15,
        ),
        cross_asset=CrossAssetSnapshot(
            dxy_percent=0.0,
            us10y_bps=0.0,
            us2y_bps=0.0,
            wti_percent=0.0,
            brent_percent=0.0,
            vix_percent=0.0,
            spx_percent=0.0,
            nasdaq_percent=0.0,
        ),
        news=(
            Headline(
                timestamp_myt="2026-06-18T09:45:00+08:00",
                source="Reuters",
                title="Fed speakers keep rate-cut debate alive before gold tests resistance",
                relevance_reason="Fed/rates context for gold",
                impact_direction_on_gold="unknown",
                tags=("fed", "rates", "gold"),
            ),
        ),
    )

    market_read = _build_market_read(
        fixture=fixture,
        provider_health={
            "xauusd": build_provider_health(
                source="cTrader",
                source_type="spot",
                data_mode="unavailable",
                is_available=False,
                data_timestamp=None,
            )
        },
        attention_snapshot=None,
        analysis=SimpleNamespace(
            main_driver="unknown",
            cause_status="unconfirmed",
            confidence="low",
            bias="neutral",
            analysis_engine="llm_validated",
            llm_status="validated",
        ),
        chain_status=EvidenceChainStatus(
            status="context_only",
            can_show_current_conclusion=False,
            reason="A current XAUUSD trade read needs fresh live price and recent price history.",
            missing_required=["live_xauusd", "xauusd_recent_history"],
            usable_inputs=["news_context", "llm_validated"],
            context_only_inputs=["cross_market_sensors"],
        ),
        previous_state=SimpleNamespace(main_driver="unknown", current_bias="neutral"),
        evidence_status={"news": "relevant_news_found"},
    )

    assert market_read["status"] == "market_observation"
    assert market_read["headline"] == "Fed speakers keep rate-cut debate alive before gold tests resistance"
    assert "not a trade call" in market_read["thesis"].lower()
    assert "next tradable read" in market_read["thesis"].lower()
    assert market_read["coverage"]["live_price"] == "stale_or_missing"
    assert market_read["watch_next"][0] == "fresh XAUUSD spot"
    assert "fresh XAUUSD spot" in " ".join(market_read["analyst_read"]["next"])


def test_short_ctrader_feed_gap_keeps_recent_price_context_as_market_observation(tmp_path) -> None:
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
    run_id = timeline.record_monitor_run(
        run_started_at="2026-05-19T07:14:00+08:00",
        run_type="live",
        data_mode="live_seen",
        backfill_required=False,
        last_successful_run_at=None,
        no_news_found=False,
        alert_suppressed_reason="",
    )
    timeline.record_market_price_bars(
        run_id,
        [
            {
                "symbol": "XAUUSD",
                "data_timestamp": "2026-05-19T07:14:00+08:00",
                "open_price": 4500.0,
                "close_price": 4498.0,
                "source": "cTrader",
                "source_type": "spot",
                "data_mode": "live_seen",
            }
        ],
    )
    cfg = MarketAgentConfig(
        repo_root=tmp_path,
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
        timeline_store_path=timeline_path,
        cooldown_minutes=30,
        provider_router=_unavailable_router(related_path),
        news_headlines=_fresh_news("2026-05-19T07:14:30+08:00"),
    )

    market_read = outcome["evidence_packet"]["market_read"]
    xauusd = outcome["evidence_packet"]["provider_health"]["xauusd"]
    assert xauusd["data_mode"] == "stale"
    assert xauusd["metadata"]["stale_classification"] == "feed_gap_context"
    assert market_read["status"] == "market_observation"
    assert market_read["headline"] == "Treasury yields rise as dollar firms before Fed speakers"
    assert "fresh XAUUSD quote" in market_read["thesis"]
    assert outcome["notification"]["should_notify"] is False


def test_run_monitored_live_once_preserves_running_loop_status(tmp_path) -> None:
    related_path = tmp_path / "related_assets.json"
    related_path.write_text(
        json.dumps({"dxy_percent": 0.22, "us10y_bps": 5.1, "us2y_bps": 4.4}),
        encoding="utf-8",
    )
    year_dir = tmp_path / "calendar" / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text("[]", encoding="utf-8")
    status_path = tmp_path / "monitor_status.json"
    status_path.write_text(
        json.dumps(
            {
                "running": True,
                "autoStart": True,
                "phase": "collecting_inputs",
                "pid": 12345,
                "nextRunAt": "2026-05-19T07:16:00+08:00",
            }
        ),
        encoding="utf-8",
    )
    cfg = MarketAgentConfig(
        repo_root=tmp_path,
        calendar_dir=tmp_path / "calendar",
        related_assets_path=related_path,
        rss_feeds=[],
        yahoo_enabled=False,
        monitor_status_path=status_path,
    )

    run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T07:15:00+08:00"),
        state_path=tmp_path / "state.json",
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=tmp_path / "timeline.sqlite",
        cooldown_minutes=30,
        provider_router=_live_router(related_path),
        status_path=status_path,
    )

    status = json.loads(status_path.read_text(encoding="utf-8"))
    assert status["running"] is True
    assert status["autoStart"] is True
    assert status["phase"] == "run_completed"
    assert isinstance(status["pid"], int)
    assert status["message"] == "Monitor pass completed; the loop remains active."


def test_run_monitored_live_once_uses_stored_live_bars_as_recent_history(tmp_path, monkeypatch) -> None:
    related_path = tmp_path / "related_assets.json"
    related_path.write_text(
        json.dumps({"dxy_percent": 0.22, "us10y_bps": 5.1, "us2y_bps": 4.4}),
        encoding="utf-8",
    )
    year_dir = tmp_path / "calendar" / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text("[]", encoding="utf-8")
    timeline_path = tmp_path / "timeline.sqlite"
    router = _sequential_live_router(related_path)
    status_updates: list[dict[str, object]] = []
    original_write_status = live_pipeline._write_monitor_status

    def capture_status(path, **updates):
        status_updates.append(dict(updates))
        return original_write_status(path, **updates)

    monkeypatch.setattr(live_pipeline, "_write_monitor_status", capture_status)
    cfg = MarketAgentConfig(
        repo_root=tmp_path,
        calendar_dir=tmp_path / "calendar",
        related_assets_path=related_path,
        rss_feeds=[],
        yahoo_enabled=False,
    )

    first = run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T07:00:00+08:00"),
        state_path=tmp_path / "state.json",
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=timeline_path,
        cooldown_minutes=30,
        provider_router=router,
        news_headlines=_fresh_news("2026-05-19T06:59:00+08:00"),
    )
    second = run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T07:15:00+08:00"),
        state_path=tmp_path / "state.json",
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=timeline_path,
        cooldown_minutes=30,
        provider_router=router,
        news_headlines=_fresh_news(),
    )

    assert first["evidence_packet"]["evidence_chain_status"]["can_show_current_conclusion"] is False
    assert first["evidence_packet"]["evidence_chain_status"]["missing_required"] == ["xauusd_recent_history"]
    assert second["evidence_packet"]["evidence_chain_status"]["can_show_current_conclusion"] is True
    assert "xauusd_recent_history" not in second["evidence_packet"]["evidence_chain_status"]["missing_required"]
    assert second["analysis"]["main_driver"] == "yields"
    with TimelineStore(timeline_path)._connect() as connection:
        stored_market_rows = connection.execute("SELECT COUNT(*) FROM market_price_bars").fetchone()[0]
    assert stored_market_rows == 2
    alert_gate_updates = [item for item in status_updates if item.get("phase") == "alert_gate"]
    second_alert_gate = alert_gate_updates[-1]
    summary = second_alert_gate["activity"]["summary"]  # type: ignore[index]
    assert summary["symbolRows"]["XAUUSD"] == 2  # type: ignore[index]


def test_run_monitored_live_once_warms_recent_history_from_stored_bars_after_restart(tmp_path) -> None:
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
    prior_run_id = timeline.record_monitor_run(
        run_started_at="2026-05-19T05:00:00+08:00",
        run_type="live",
        data_mode="live_seen",
        backfill_required=False,
        last_successful_run_at=None,
        no_news_found=False,
        alert_suppressed_reason="",
    )
    timeline.record_market_price_bars(
        prior_run_id,
        [
            {
                "symbol": "XAUUSD",
                "data_timestamp": "2026-05-19T05:00:00+08:00",
                "open_price": 4500.0,
                "close_price": 4501.0,
                "source": "cTrader",
                "source_type": "spot",
                "data_mode": "live_seen",
            }
        ],
    )
    router = ProviderRouter(
        market_provider=StubLiveMarketProvider(
            [
                {
                    "symbol": "XAUUSD",
                    "data_timestamp": "2026-05-19T06:30:00+08:00",
                    "open_price": 4501.0,
                    "close_price": 4479.0,
                    "source": "cTrader",
                    "source_type": "spot",
                    "data_mode": "live_seen",
                }
            ]
        ),
        related_assets_provider=StubLiveRelatedAssetsProvider(),
        csv_related_assets_path=related_path,
        yahoo_enabled=False,
    )
    cfg = MarketAgentConfig(
        repo_root=tmp_path,
        calendar_dir=tmp_path / "calendar",
        related_assets_path=related_path,
        rss_feeds=[],
        yahoo_enabled=False,
    )

    outcome = run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T06:30:00+08:00"),
        state_path=tmp_path / "state.json",
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=timeline_path,
        cooldown_minutes=30,
        provider_router=router,
        news_headlines=_fresh_news("2026-05-19T06:29:00+08:00"),
    )

    chain = outcome["evidence_packet"]["evidence_chain_status"]
    assert "xauusd_recent_history" not in chain["missing_required"]
    assert "xauusd_recent_history" in chain["usable_inputs"]
    assert outcome["evidence_packet"]["market_move"]["from_price"] == 4501.0
    assert outcome["evidence_packet"]["market_move"]["to_price"] == 4479.0
    assert outcome["evidence_packet"]["market_move"]["window_minutes"] == 15


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
    assert outcome["analysis"]["summary"] == (
        "XAUUSD market is closed; news, calendar, and cross-market context keep updating, "
        "and the next trade read resumes when fresh XAUUSD price action returns."
    )


def test_market_read_counts_market_closed_sensors_as_context() -> None:
    sensor_keys = ("dxy", "us10y", "us2y", "wti", "brent", "vix", "spx", "nasdaq")
    provider_health = {
        "xauusd": ProviderHealth(
            source="cTrader",
            source_type="spot",
            fetched_at="2026-06-14T19:30:00+08:00",
            data_timestamp="2026-06-14T09:32:28+08:00",
            data_mode="stale",
            is_available=True,
            is_stale=True,
            stale_reason="XAUUSD is inside the weekend closed window; last cTrader quote is context only until the market reopens.",
        ),
        **{
            key: ProviderHealth(
                source=key,
                source_type="market_sensor",
                fetched_at="2026-06-14T19:30:00+08:00",
                data_timestamp="2026-06-13T05:00:00+08:00",
                data_mode="live_seen",
                is_available=True,
                is_stale=True,
                stale_reason="Latest chart point is older than freshness threshold.",
            )
            for key in sensor_keys
        },
    }
    chain_status = EvidenceChainStatus(
        status="context_only",
        can_show_current_conclusion=False,
        reason="Market closed.",
        missing_required=["live_xauusd_spot", "xauusd_recent_history"],
        usable_inputs=["news_context", "calendar_context"],
        context_only_inputs=["market_closed_last_xauusd_spot", "cross_market_sensors"],
        llm_status="validated",
    )
    fixture = ScenarioFixture(
        scenario_id="market_closed",
        as_of_myt="14-06-2026 19:30",
        market=MarketMove(
            symbol="XAUUSD",
            from_price=4310.0,
            to_price=4311.0,
            move_percent=0.02,
            move_percent_15m=0.02,
            move_percent_1h=0.02,
            window_minutes=15,
        ),
        cross_asset=CrossAssetSnapshot(
            dxy_percent=0.0,
            us10y_bps=0.0,
            us2y_bps=0.0,
            wti_percent=0.0,
            brent_percent=0.0,
            vix_percent=0.0,
            spx_percent=0.0,
            nasdaq_percent=0.0,
        ),
        news=(
            Headline(
                timestamp_myt="14-06-2026 18:30",
                source="Reuters",
                title="Iran risk remains active while gold is closed",
                relevance_reason="Geopolitical context.",
                impact_direction_on_gold="unknown",
            ),
        ),
    )

    market_read = _build_market_read(
        fixture=fixture,
        provider_health=provider_health,
        attention_snapshot=None,
        analysis=None,
        chain_status=chain_status,
        previous_state=SimpleNamespace(main_driver="", current_bias=""),
        evidence_status={key: "market_closed_context" for key in sensor_keys},
    )

    assert market_read["coverage"]["sensors"] == "0 fresh / 8 context"

    aggregate_market_read = _build_market_read(
        fixture=fixture,
        provider_health=provider_health,
        attention_snapshot=None,
        analysis=None,
        chain_status=chain_status,
        previous_state=SimpleNamespace(main_driver="", current_bias=""),
        evidence_status={
            "dxy": "market_closed_context",
            "us10y": "market_closed_context",
            "us2y": "market_closed_context",
            "oil": "market_closed_context",
            "vix_equities": "market_closed_context",
        },
    )

    assert aggregate_market_read["coverage"]["sensors"] == "0 fresh / 8 context"


def test_context_only_news_review_is_stored_as_replay_context_not_trade_result(tmp_path) -> None:
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
        calendar_dir=tmp_path / "calendar",
        related_assets_path=related_path,
        rss_feeds=[],
        yahoo_enabled=False,
    )

    outcome = run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-23T07:20:00+08:00"),
        state_path=tmp_path / "state.json",
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=timeline_path,
        cooldown_minutes=30,
        provider_router=_closed_router(related_path),
        news_headlines=_fresh_news("2026-05-23T07:19:00+08:00"),
    )

    assert outcome["evidence_packet"]["evidence_chain_status"]["can_show_current_conclusion"] is False
    assert outcome["notification"]["should_notify"] is False
    with sqlite3.connect(timeline_path) as connection:
        analysis_rows = connection.execute("SELECT COUNT(*) FROM analysis_results").fetchone()[0]
        timeline_rows = connection.execute("SELECT COUNT(*) FROM timeline_events").fetchone()[0]
        timeline_payload = json.loads(
            connection.execute("SELECT event_type, label, payload_json FROM timeline_events").fetchone()[2]
        )
        alert_rows = connection.execute("SELECT COUNT(*) FROM alerts").fetchone()[0]

    assert analysis_rows == 1
    assert timeline_rows == 1
    assert timeline_payload["semantic_type"] == "context_review"
    assert timeline_payload["trade_conclusion"] is False
    assert timeline_payload["news_count"] == 1
    assert timeline_payload["calendar_count"] == 0
    assert alert_rows == 1


def test_duplicate_context_only_review_does_not_add_replay_noise(tmp_path) -> None:
    related_path = tmp_path / "related_assets.json"
    related_path.write_text(
        json.dumps({"dxy_percent": 0.22, "us10y_bps": 5.1, "us2y_bps": 4.4}),
        encoding="utf-8",
    )
    year_dir = tmp_path / "calendar" / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text("[]", encoding="utf-8")
    timeline_path = tmp_path / "timeline.sqlite"
    state_path = tmp_path / "state.json"
    cfg = MarketAgentConfig(
        repo_root=tmp_path,
        calendar_dir=tmp_path / "calendar",
        related_assets_path=related_path,
        rss_feeds=[],
        yahoo_enabled=False,
    )
    news_rows = _fresh_news("2026-05-23T07:19:00+08:00")

    run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-23T07:20:00+08:00"),
        state_path=state_path,
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=timeline_path,
        cooldown_minutes=30,
        provider_router=_closed_router(related_path),
        news_headlines=news_rows,
    )
    run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-23T07:21:00+08:00"),
        state_path=state_path,
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=timeline_path,
        cooldown_minutes=30,
        provider_router=_closed_router(related_path),
        news_headlines=news_rows,
    )

    with sqlite3.connect(timeline_path) as connection:
        analysis_rows = connection.execute("SELECT COUNT(*) FROM analysis_results").fetchone()[0]
        timeline_rows = connection.execute("SELECT COUNT(*) FROM timeline_events").fetchone()[0]

    assert analysis_rows == 2
    assert timeline_rows == 1


def test_market_read_prioritizes_top_driver_evidence_refs() -> None:
    snapshot = SimpleNamespace(
        driver_attention_summary={"top_driver": "geopolitics"},
        states={
            "geopolitics": SimpleNamespace(
                evidence_refs=(
                    {"title": "Iran escalation keeps Hormuz risk in focus"},
                    {"title": "U.S.-Iran deal talks keep safe-haven risk active"},
                )
            )
        },
    )

    assert _market_read_driver_evidence_titles(attention_snapshot=snapshot, driver="unknown") == [
        "Iran escalation keeps Hormuz risk in focus",
        "U.S.-Iran deal talks keep safe-haven risk active",
    ]


def test_market_read_driver_evidence_titles_prefers_market_relevant_refs() -> None:
    snapshot = SimpleNamespace(
        driver_attention_summary={"top_driver": "fed_rates"},
        states={
            "fed_rates": SimpleNamespace(
                evidence_refs=(
                    {"title": "I’m 20, and I’ll be watching Kevin Warsh and the Fed today. Here’s why you should, too."},
                    {"title": "2-year Treasury yield rockets higher as Fed officials signal possible hike this year"},
                )
            )
        },
    )

    assert _market_read_driver_evidence_titles(attention_snapshot=snapshot, driver="unknown")[0] == (
        "2-year Treasury yield rockets higher as Fed officials signal possible hike this year"
    )


def test_market_read_keyword_fallback_does_not_match_warsh_as_war() -> None:
    news = (
        SimpleNamespace(
            title="Call Kevin Warsh the Fed chairman",
            tags=("fed",),
            relevance_reason="Fed leadership headline.",
        ),
        SimpleNamespace(
            title="Iran escalation keeps Hormuz risk in focus",
            tags=("iran", "hormuz"),
            relevance_reason="Geopolitical shock headline.",
        ),
    )

    assert _market_read_driver_matched_titles(items=news, driver="geopolitics") == [
        "Iran escalation keeps Hormuz risk in focus"
    ]


def test_market_read_title_cleanup_keeps_complete_readable_title() -> None:
    assert (
        _safe_market_read_title(
            "Fed holds interest rates steady: Here's what that means for credit cards, savings rates, mortgages and car loans"
        )
        == "Fed holds interest rates steady"
    )
    assert (
        _safe_market_read_title("From supply shock to oil glut: IEA flags scale of demand destruction caused by Iran war")
        == "From supply shock to oil glut: IEA flags scale of demand destruction caused by Iran war"
    )
    title = _safe_market_read_title(
        "Oil prices fall nearly 4% after U.S. Energy Secretary says Hormuz ship traffic is increasing",
        limit=72,
    )
    assert title == "Oil prices fall nearly 4% after U.S. Energy Secretary says Hormuz ship"
    assert title.endswith("ship")


def test_market_read_latest_titles_prefers_market_story_over_personal_finance() -> None:
    news = (
        SimpleNamespace(
            title="I’m 20, and I’ll be watching Kevin Warsh and the Fed today. Here’s why you should, too.",
            tags=("fed",),
            relevance_reason="Fed leadership explainer.",
        ),
        SimpleNamespace(
            title="2-year Treasury yield rockets higher as Fed officials signal possible hike this year",
            tags=("fed", "rates", "treasury"),
            relevance_reason="Rates context for gold.",
        ),
        SimpleNamespace(
            title="Fed holds interest rates steady: Here's what that means for credit cards and mortgages",
            tags=("fed", "rates"),
            relevance_reason="Consumer finance explainer.",
        ),
    )

    assert _market_read_driver_matched_titles(items=news, driver="fed_rates")[0] == (
        "2-year Treasury yield rockets higher as Fed officials signal possible hike this year"
    )


def test_context_only_run_does_not_overwrite_persisted_market_state(tmp_path) -> None:
    related_path = tmp_path / "related_assets.json"
    related_path.write_text(
        json.dumps({"dxy_percent": 0.22, "us10y_bps": 5.1, "us2y_bps": 4.4}),
        encoding="utf-8",
    )
    year_dir = tmp_path / "calendar" / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text("[]", encoding="utf-8")
    state_path = tmp_path / "state.json"
    timeline_path = tmp_path / "timeline.sqlite"
    cfg = MarketAgentConfig(
        repo_root=tmp_path,
        calendar_dir=tmp_path / "calendar",
        related_assets_path=related_path,
        rss_feeds=[],
        yahoo_enabled=False,
    )

    first = run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T07:15:00+08:00"),
        state_path=state_path,
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=timeline_path,
        cooldown_minutes=30,
        provider_router=_live_router(related_path),
        news_headlines=_fresh_news(),
    )
    persisted = json.loads(state_path.read_text(encoding="utf-8"))
    assert first["evidence_packet"]["evidence_chain_status"]["can_show_current_conclusion"] is True
    assert persisted["current_bias"] == "bearish_gold"
    assert persisted["main_driver"] == "yields"

    second = run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T07:20:00+08:00"),
        state_path=state_path,
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=timeline_path,
        cooldown_minutes=30,
        provider_router=_closed_router(related_path),
        news_headlines=_fresh_news("2026-05-19T07:19:00+08:00"),
    )
    after_context_only = json.loads(state_path.read_text(encoding="utf-8"))

    assert second["evidence_packet"]["evidence_chain_status"]["can_show_current_conclusion"] is False
    assert second["analysis"]["main_driver"] == "unknown"
    assert after_context_only["current_bias"] == "bearish_gold"
    assert after_context_only["main_driver"] == "yields"
    with TimelineStore(timeline_path)._connect() as connection:
        transition = json.loads(
            connection.execute(
                "SELECT payload_json FROM state_transitions ORDER BY monitor_run_id DESC LIMIT 1"
            ).fetchone()[0]
        )
    assert transition["state_persisted"] is False


def test_run_monitored_live_once_keeps_live_decision_while_backfilling_history(tmp_path) -> None:
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

    assert outcome["run_type"] == "live"
    assert outcome["backfill_required"] is True
    assert outcome["evidence_packet"]["data_mode"] == "live_seen"
    assert outcome["analysis"]["summary"] != (
        "Historical recovery data was stored for replay and evidence only; "
        "it is not a current alert."
    )

    timeline_rows = TimelineStore(timeline_path).get_timeline(
        "2026-05-19T04:00:00+08:00",
        "2026-05-19T07:30:00+08:00",
    )
    recovery_rows = [row for row in timeline_rows if row["event_type"] == "recovery_summary"]
    assert recovery_rows
    assert recovery_rows[0]["payload"]["data_mode"] == "backfilled"
    if telegram.payloads:
        assert telegram.payloads[0]["data_mode"] == "live_seen"


class FailingTelegramSink:
    def send(self, payload):
        return {
            "sent": False,
            "status": "failed",
            "error": "telegram unavailable",
            "notification_level": payload.get("notification_level", ""),
        }


class RaisingTelegramSink:
    def send(self, payload):
        raise RuntimeError("telegram bridge crashed")


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


class AlertReviewClientBase:
    class Config:
        enabled = True
        model = "test-llm"

    config = Config()

    def __init__(self) -> None:
        self.alert_packets = []

    def analyze(self, evidence_packet):
        return None

    def get_telemetry(self):
        return []


class BlockingReviewClient(AlertReviewClientBase):
    def review_alert(self, payload):
        self.alert_packets.append(payload)
        return {
            "decision": "block",
            "reason": "Alert claims a driver without enough accepted evidence.",
        }


class RewritingReviewClient(AlertReviewClientBase):
    def review_alert(self, payload):
        self.alert_packets.append(payload)
        return {
            "decision": "rewrite",
            "message": str(payload["message"]).replace("Summary:", "Summary: Reviewed."),
            "reason": "clearer",
        }


class ApprovingReviewClient(AlertReviewClientBase):
    def review_alert(self, payload):
        self.alert_packets.append(payload)
        return {"decision": "approve", "reason": "supported"}


class RepairableCauseReviewClient(AlertReviewClientBase):
    def __init__(self) -> None:
        super().__init__()
        self.calls: list[bool] = []

    def analyze(self, evidence_packet, repair: bool = False):
        self.calls.append(repair)
        if not repair:
            return {"main_driver": "yields"}
        return {
            "bias": "bearish_gold",
            "main_driver": "yields",
            "secondary_driver": "usd",
            "cause_status": "likely",
            "confidence": "medium",
            "is_new_state": True,
            "is_continuation": False,
            "previous_state_invalidated": False,
            "should_notify": False,
            "notification_level": "none",
            "no_news_found": False,
            "allowed_candidate_drivers_used": ["yields", "usd"],
            "rejected_or_blocked_drivers_acknowledged": True,
            "timeline": [],
            "cross_asset_confirmation": {
                "dxy": "confirming",
                "us10y": "confirming",
                "us2y": "confirming",
                "oil": "not_confirming",
                "vix_equities": "not_confirming",
            },
            "evidence_status": {
                "dxy": "confirming",
                "us10y": "confirming",
                "us2y": "confirming",
                "oil": "not_confirming",
                "vix_equities": "not_confirming",
                "news": "relevant_news_found",
            },
            "causal_chain": "Yields and USD confirm the move.",
            "invalidation_conditions": [],
            "user_message": "Yields and USD confirm the move.",
            "summary": "Yields and USD confirm the move.",
        }


class DisabledReviewClient(ApprovingReviewClient):
    class Config:
        enabled = False
        model = "test-llm"

    config = Config()


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
        llm_client=ApprovingReviewClient(),
        telegram_sink=FailingTelegramSink(),
        provider_router=_live_router(related_path),
        news_headlines=_fresh_news(),
    )

    assert outcome["notification"]["telegram"]["status"] == "failed"
    assert outcome["notification"]["telegram"]["error"] == "telegram unavailable"
    with TimelineStore(tmp_path / "timeline.sqlite")._connect() as connection:
        alert_payload = json.loads(connection.execute("SELECT payload_json FROM alerts").fetchone()[0])
    assert alert_payload["message"].startswith("XAUUSD Market Agent")
    assert alert_payload["main_driver"] == outcome["analysis"]["main_driver"]
    assert alert_payload["telegram"]["status"] == "failed"
    assert alert_payload["telegram"]["error"] == "telegram unavailable"


def test_run_monitored_live_once_records_telegram_exception_without_losing_alert_audit(tmp_path) -> None:
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
        telegram_enabled=True,
        telegram_bot_token="token",
        telegram_chat_id="chat",
    )

    outcome = run_monitored_live_once(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T07:15:00+08:00"),
        state_path=tmp_path / "state.json",
        alerts_path=tmp_path / "alerts.ndjson",
        timeline_store_path=timeline_path,
        cooldown_minutes=30,
        llm_client=ApprovingReviewClient(),
        telegram_sink=RaisingTelegramSink(),
        provider_router=_live_router(related_path),
        news_headlines=_fresh_news(),
    )

    assert outcome["notification"]["telegram"]["status"] == "failed"
    assert outcome["notification"]["telegram"]["error"] == "telegram bridge crashed"
    with TimelineStore(timeline_path)._connect() as connection:
        alert_payload = json.loads(connection.execute("SELECT payload_json FROM alerts").fetchone()[0])
    assert alert_payload["message"].startswith("XAUUSD Market Agent")
    assert alert_payload["telegram"]["status"] == "failed"
    assert alert_payload["telegram"]["error"] == "telegram bridge crashed"


def test_run_monitored_live_once_repairs_invalid_llm_json_before_fallback(tmp_path) -> None:
    related_path = tmp_path / "related_assets.json"
    related_path.write_text(
        json.dumps({"dxy_percent": 0.22, "us10y_bps": 5.1, "us2y_bps": 4.4}),
        encoding="utf-8",
    )
    year_dir = tmp_path / "calendar" / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text("[]", encoding="utf-8")
    llm = RepairableCauseReviewClient()
    cfg = MarketAgentConfig(
        repo_root=tmp_path,
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
        timeline_store_path=tmp_path / "timeline.sqlite",
        cooldown_minutes=30,
        llm_client=llm,
        provider_router=_live_router(related_path),
        news_headlines=_fresh_news(),
    )

    assert llm.calls == [False, True]
    assert outcome["analysis"]["analysis_engine"] == "llm_validated"
    assert outcome["analysis"]["llm_status"] == "validated"
    assert outcome["analysis"]["main_driver"] == "yields"


def test_run_monitored_live_once_formats_telegram_alert(tmp_path) -> None:
    related_path = tmp_path / "related_assets.json"
    related_path.write_text(
        json.dumps({"dxy_percent": 0.22, "us10y_bps": 5.1, "us2y_bps": 4.4}),
        encoding="utf-8",
    )
    year_dir = tmp_path / "calendar" / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text("[]", encoding="utf-8")
    timeline_path = tmp_path / "timeline.sqlite"
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
        timeline_store_path=timeline_path,
        cooldown_minutes=30,
        llm_client=ApprovingReviewClient(),
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
    with TimelineStore(timeline_path)._connect() as connection:
        alert_payload = json.loads(connection.execute("SELECT payload_json FROM alerts").fetchone()[0])
    assert alert_payload["message"] == message
    assert alert_payload["main_driver"] == outcome["analysis"]["main_driver"]
    assert alert_payload["telegram"]["status"] == "sent"


def test_run_monitored_live_once_blocks_telegram_without_ai_alert_review(tmp_path) -> None:
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
        llm_client=DisabledReviewClient(),
        telegram_sink=telegram,
        provider_router=_live_router(related_path),
        news_headlines=_fresh_news(),
    )

    assert outcome["notification"]["should_notify"] is False
    assert outcome["notification"]["alert_preflight"]["status"] == "blocked"
    assert "Local AI alert review is disabled" in outcome["notification"]["alert_preflight"]["reason"]
    assert telegram.payloads == []


def test_run_monitored_live_once_dedupes_repeated_telegram_alert(tmp_path) -> None:
    related_path = tmp_path / "related_assets.json"
    related_path.write_text(
        json.dumps({"dxy_percent": 0.22, "us10y_bps": 5.1, "us2y_bps": 4.4}),
        encoding="utf-8",
    )
    year_dir = tmp_path / "calendar" / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text("[]", encoding="utf-8")
    timeline_path = tmp_path / "timeline.sqlite"
    alerts_path = tmp_path / "alerts.ndjson"
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
    common = {
        "config": cfg,
        "alerts_path": alerts_path,
        "timeline_store_path": timeline_path,
        "cooldown_minutes": 30,
        "llm_client": ApprovingReviewClient(),
        "telegram_sink": telegram,
        "provider_router": _live_router(related_path),
        "news_headlines": _fresh_news(),
    }

    first = run_monitored_live_once(
        anchor_time=datetime.fromisoformat("2026-05-19T07:15:00+08:00"),
        state_path=tmp_path / "state.json",
        **common,
    )
    second = run_monitored_live_once(
        anchor_time=datetime.fromisoformat("2026-05-19T07:20:00+08:00"),
        state_path=tmp_path / "state-after-crash.json",
        **common,
    )

    assert first["notification"]["should_notify"] is True
    assert second["notification"]["should_notify"] is False
    assert second["notification"]["reason"] == "Duplicate Telegram alert suppressed by notification ledger."
    assert len(telegram.payloads) == 1


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
    store = TimelineStore(tmp_path / "timeline.sqlite", calendar_dir=tmp_path / "calendar")
    replay = store.get_market_replay(
        "2026-05-19T00:00:00+08:00",
        "2026-05-19T23:59:59+08:00",
    )
    assert replay["alerts"] == []
    assert replay["suppressed_alerts"]
    assert replay["suppressed_alerts"][0]["reason"] == "Analysis result does not require notification."


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
