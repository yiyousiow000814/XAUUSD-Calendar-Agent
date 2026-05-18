from datetime import datetime
import json

from src.xauusd_market_agent.config import MarketAgentConfig
from src.xauusd_market_agent.live_pipeline import build_live_evidence_packet


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
