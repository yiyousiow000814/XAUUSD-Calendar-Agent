from datetime import datetime
import json

from src.xauusd_market_agent.config import MarketAgentConfig
from src.xauusd_market_agent.live_pipeline import build_live_evidence_packet
from src.xauusd_market_agent.models import CrossAssetSnapshot, Headline, MarketMove, ScenarioFixture
from src.xauusd_market_agent.pipeline import build_rule_based_analysis


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
