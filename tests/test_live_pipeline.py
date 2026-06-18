from datetime import datetime
import json

from src.xauusd_market_agent.config import MarketAgentConfig
from src.xauusd_market_agent.live_pipeline import _write_monitor_status, build_live_evidence_packet
from src.xauusd_market_agent.models import CrossAssetSnapshot, Headline, MarketMove, ScenarioFixture
from src.xauusd_market_agent.pipeline import build_rule_based_analysis
from src.xauusd_market_agent.provider_health import build_fixture_provider_health, build_provider_health


def test_monitor_status_clears_stale_next_run_during_active_iteration(tmp_path) -> None:
    status_path = tmp_path / "market_agent_monitor_status.json"
    _write_monitor_status(
        status_path,
        running=True,
        phase="idle_between_runs",
        nextRunAt="2026-06-14T16:10:00+08:00",
    )

    _write_monitor_status(status_path, running=True, phase="collecting_inputs")

    active_payload = json.loads(status_path.read_text(encoding="utf-8"))
    assert active_payload["phase"] == "collecting_inputs"
    assert active_payload["nextRunAt"] is None

    _write_monitor_status(
        status_path,
        running=True,
        phase="idle_between_runs",
        nextRunAt="2026-06-14T16:11:00+08:00",
    )

    idle_payload = json.loads(status_path.read_text(encoding="utf-8"))
    assert idle_payload["phase"] == "idle_between_runs"
    assert idle_payload["nextRunAt"] == "2026-06-14T16:11:00+08:00"


def test_build_live_evidence_packet_uses_provider_outputs(tmp_path) -> None:
    price_path = tmp_path / "prices.csv"
    price_path.write_text(
        "timestamp,open,high,low,close\n"
        "2026-05-19T07:00:00+08:00,4500,4502,4499,4501\n"
        "2026-05-19T07:15:00+08:00,4501,4503,4490,4491\n",
        encoding="utf-8",
    )

    year_dir = tmp_path / "calendar" / "2026"
    year_dir.mkdir(parents=True)
    (year_dir / "2026_calendar.json").write_text(
        json.dumps(
            [
                {"Date": "2026-05-19", "Time": "07:00", "Currency": "USD", "Event": "CPI", "Imp.": "High"}
            ]
        ),
        encoding="utf-8",
    )

    cfg = MarketAgentConfig(
        repo_root=tmp_path,
        price_data_path=price_path,
        calendar_dir=tmp_path / "calendar",
        rss_feeds=[],
        yahoo_enabled=False,
    )
    packet = build_live_evidence_packet(
        config=cfg,
        anchor_time=datetime.fromisoformat("2026-05-19T07:15:00+08:00"),
        news_headlines=[
            {"title": "Recent Fed headline", "source": "Reuters", "published_at": "2026-05-19T07:05:00+08:00"}
        ],
    )

    assert packet["market_move"]["symbol"] == "XAUUSD"
    assert "allowed_candidate_drivers" in packet
    assert packet["calendar_events"][0]["title"] == "CPI"


def test_rule_analysis_preserves_relevant_news_status_when_price_move_is_missing() -> None:
    fixture = ScenarioFixture(
        scenario_id="missing_price_with_news",
        as_of_myt="31-05-2026 16:28",
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
                timestamp_myt="31-05-2026 14:12",
                source="Federal Reserve",
                title="Fed governor discusses inflation risks",
                relevance_reason="Fed headline is relevant to gold.",
                impact_direction_on_gold="unknown",
                tags=("fed",),
            ),
        ),
    )

    analysis = build_rule_based_analysis(fixture)

    assert analysis.no_news_found is False
    assert analysis.evidence_status["news"] == "relevant_news_found"


def test_rule_analysis_uses_geopolitical_news_when_cross_assets_are_stale() -> None:
    fixture = ScenarioFixture(
        scenario_id="geo_news_with_stale_cross_assets",
        as_of_myt="11-06-2026 11:50",
        market=MarketMove(
            symbol="XAUUSD",
            from_price=4070.0,
            to_price=4090.0,
            move_percent=0.49,
            move_percent_15m=0.49,
            move_percent_1h=0.49,
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
                timestamp_myt="11-06-2026 11:38",
                source="US Top News and Analysis",
                title="Kuwait closes airspace, Israel warns of launches from Lebanon after U.S strikes in Iran",
                relevance_reason="Geopolitical shock headline.",
                impact_direction_on_gold="bullish",
                tags=("iran", "israel", "lebanon", "strikes"),
            ),
        ),
    )
    health = build_fixture_provider_health(fixture)
    for key in ("dxy", "us10y", "wti", "brent", "vix", "spx", "nasdaq"):
        current = health[key]
        health[key] = build_provider_health(
            source=current.source,
            source_type=current.source_type,
            data_mode="live_seen",
            is_available=True,
            is_stale=True,
            stale_reason="Latest chart point is older than freshness threshold.",
        )
    health["us2y"] = build_provider_health(
        source="US2Y",
        source_type="related_asset",
        data_mode="unavailable",
        is_available=False,
        stale_reason="No reliable free US2Y Yahoo proxy is configured.",
    )

    analysis = build_rule_based_analysis(fixture, provider_health=health)

    assert analysis.main_driver == "geopolitics"
    assert analysis.cause_status == "confirmed"
    assert analysis.no_news_found is False


def test_rule_analysis_handles_usd_as_main_driver() -> None:
    fixture = ScenarioFixture(
        scenario_id="usd_driver_only",
        as_of_myt="12-06-2026 16:15",
        market=MarketMove(
            symbol="XAUUSD",
            from_price=4100.0,
            to_price=4078.0,
            move_percent=-0.54,
            move_percent_15m=-0.54,
            move_percent_1h=-0.54,
            window_minutes=15,
        ),
        cross_asset=CrossAssetSnapshot(
            dxy_percent=0.35,
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
                timestamp_myt="12-06-2026 16:05",
                source="MarketWatch",
                title="Dollar firms as traders price a stronger USD path",
                relevance_reason="USD headline is relevant to gold.",
                impact_direction_on_gold="bearish",
                tags=("usd", "dollar"),
            ),
        ),
    )

    analysis = build_rule_based_analysis(fixture, provider_health=build_fixture_provider_health(fixture))

    assert analysis.main_driver == "usd"
    assert analysis.cause_status == "confirmed"
    assert analysis.user_message == "A firmer dollar is pressuring gold."
