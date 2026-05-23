from datetime import datetime
import json

from src.xauusd_market_agent.driver_attention import DriverAttentionManager
from src.xauusd_market_agent.evidence import build_evidence_gate_result
from src.xauusd_market_agent.live_pipeline import run_monitored_live_once
from src.xauusd_market_agent.models import CrossAssetSnapshot, Headline, MarketMove, ScenarioFixture
from src.xauusd_market_agent.config import MarketAgentConfig
from src.xauusd_market_agent.provider_health import build_fixture_provider_health, build_provider_health
from src.xauusd_market_agent.providers.provider_router import ProviderRouter
from src.xauusd_market_agent.timeline_store import TimelineStore


class StubLiveMarketProvider:
    def fetch_latest(self, anchor_time):
        rows = [
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
        return rows, build_provider_health(
            source="cTrader",
            source_type="spot",
            data_mode="live_seen",
            is_available=True,
            data_timestamp=anchor_time.isoformat(),
            current_value=4479.0,
            previous_value=4501.0,
            change_value=-22.0,
        )


def _fixture(*, news: tuple[Headline, ...], cross: CrossAssetSnapshot | None = None) -> ScenarioFixture:
    return ScenarioFixture(
        scenario_id="dynamic_theme_test",
        as_of_myt="19-05-2026 07:15",
        market=MarketMove(
            symbol="XAUUSD",
            from_price=4500.0,
            to_price=4482.0,
            move_percent=-0.4,
            move_percent_15m=-0.4,
            move_percent_1h=-0.4,
            window_minutes=15,
        ),
        cross_asset=cross
        or CrossAssetSnapshot(
            dxy_percent=0.0,
            us10y_bps=0.0,
            us2y_bps=0.0,
            wti_percent=0.0,
            brent_percent=0.0,
            vix_percent=0.0,
            spx_percent=0.0,
            nasdaq_percent=0.0,
        ),
        news=news,
    )


def _headline(title: str, source: str, *tags: str) -> Headline:
    return Headline(
        timestamp_myt="19-05-2026 07:10",
        source=source,
        title=title,
        relevance_reason="Test headline.",
        impact_direction_on_gold="unknown",
        tags=tags,
    )


def test_single_oil_related_theme_stays_observed_not_active() -> None:
    fixture = _fixture(
        news=(
            _headline(
                "Oil tanker supply disruption raises concern",
                "Reuters",
                "shipping_disruption",
            ),
        )
    )
    health = build_fixture_provider_health(fixture)
    evidence = build_evidence_gate_result(fixture, provider_health=health)
    attention = DriverAttentionManager().evaluate(
        fixture=fixture,
        provider_health=health,
        evidence_status=evidence.evidence_status,
    )

    theme_states = [state for state in attention.states.values() if state.driver_id.startswith("theme:")]

    assert theme_states
    assert theme_states[0].current_state in {"observed", "watching"}
    assert theme_states[0].current_state != "active"
    assert "oil_inflation" not in evidence.allowed_candidate_drivers


def test_repeated_new_theme_without_market_confirmation_is_emerging_only() -> None:
    fixture = _fixture(
        news=(
            _headline("Shipping disruption hits Red Sea routes", "Reuters", "shipping_disruption"),
            _headline("Shipping disruption raises freight risk", "Bloomberg", "shipping_disruption"),
        )
    )
    health = build_fixture_provider_health(fixture)
    evidence = build_evidence_gate_result(fixture, provider_health=health)
    attention = DriverAttentionManager().evaluate(
        fixture=fixture,
        provider_health=health,
        evidence_status=evidence.evidence_status,
    )

    theme = attention.states["theme:shipping_disruption"]

    assert theme.current_state == "emerging"
    assert theme.source_count == 2
    assert theme.related_news_count == 2
    assert theme.promotion_reason == "Repeated headlines across multiple sources."
    assert "theme:shipping_disruption" not in evidence.allowed_candidate_drivers


def test_repeated_new_theme_without_tags_groups_by_stable_phrase() -> None:
    fixture = _fixture(
        news=(
            _headline("Tariff risk hits risk assets", "Reuters"),
            _headline("Tariff risk lifts dollar demand", "Bloomberg"),
        )
    )
    health = build_fixture_provider_health(fixture)
    evidence = build_evidence_gate_result(fixture, provider_health=health)
    attention = DriverAttentionManager().evaluate(
        fixture=fixture,
        provider_health=health,
        evidence_status=evidence.evidence_status,
    )

    theme = attention.states["theme:tariff_risk"]

    assert theme.current_state == "emerging"
    assert theme.source_count == 2
    assert theme.related_news_count == 2
    assert "theme:tariff_risk" not in evidence.allowed_candidate_drivers


def test_repeated_new_theme_with_cross_asset_confirmation_can_be_active() -> None:
    fixture = _fixture(
        news=(
            _headline("Tariff risk hits risk assets", "Reuters", "tariff_risk"),
            _headline("Tariff risk lifts dollar demand", "Bloomberg", "tariff_risk"),
        ),
        cross=CrossAssetSnapshot(
            dxy_percent=0.25,
            us10y_bps=5.0,
            us2y_bps=0.0,
            wti_percent=0.0,
            brent_percent=0.0,
            vix_percent=0.0,
            spx_percent=-0.3,
            nasdaq_percent=-0.4,
        ),
    )
    health = build_fixture_provider_health(fixture)
    evidence = build_evidence_gate_result(fixture, provider_health=health)
    attention = DriverAttentionManager().evaluate(
        fixture=fixture,
        provider_health=health,
        evidence_status=evidence.evidence_status,
    )

    theme = attention.states["theme:tariff_risk"]

    assert theme.current_state == "active"
    assert "cross-asset confirmation" in theme.promotion_reason
    assert "dxy" in theme.requested_sensor_ids
    assert "us10y" in theme.requested_sensor_ids


def test_dynamic_theme_cools_when_headlines_disappear() -> None:
    first = _fixture(
        news=(
            _headline("Banking stress hits regional lenders", "Reuters", "banking_stress"),
            _headline("Banking stress drives funding concern", "Bloomberg", "banking_stress"),
        ),
        cross=CrossAssetSnapshot(
            dxy_percent=0.0,
            us10y_bps=0.0,
            us2y_bps=0.0,
            wti_percent=0.0,
            brent_percent=0.0,
            vix_percent=4.0,
            spx_percent=-1.0,
            nasdaq_percent=-1.2,
        ),
    )
    first_health = build_fixture_provider_health(first)
    first_evidence = build_evidence_gate_result(first, provider_health=first_health)
    manager = DriverAttentionManager()
    first_attention = manager.evaluate(
        fixture=first,
        provider_health=first_health,
        evidence_status=first_evidence.evidence_status,
    )
    second = _fixture(news=())
    second_health = build_fixture_provider_health(second)
    second_evidence = build_evidence_gate_result(second, provider_health=second_health)
    second_attention = manager.evaluate(
        fixture=second,
        provider_health=second_health,
        evidence_status=second_evidence.evidence_status,
        previous_states=first_attention.states,
    )

    theme = second_attention.states["theme:banking_stress"]

    assert theme.current_state in {"cooling", "retired"}
    assert "No fresh headlines" in theme.deactivation_reason


def test_dynamic_theme_persists_into_evidence_packet_and_replay(tmp_path) -> None:
    price_path = tmp_path / "prices.csv"
    price_path.write_text(
        "timestamp,open,high,low,close\n"
        "2026-05-19T07:00:00+08:00,4500,4502,4499,4501\n"
        "2026-05-19T07:15:00+08:00,4501,4503,4475,4479\n",
        encoding="utf-8",
    )
    related_path = tmp_path / "related_assets.json"
    related_path.write_text(
        json.dumps({"dxy_percent": 0.25, "us10y_bps": 5.0, "us2y_bps": 0.0}),
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
        news_headlines=[
            {
                "title": "Tariff risk hits risk assets",
                "source": "Reuters",
                "published_at": "2026-05-19T07:10:00+08:00",
                "categories": ["tariff_risk"],
            },
            {
                "title": "Tariff risk lifts dollar demand",
                "source": "Bloomberg",
                "published_at": "2026-05-19T07:12:00+08:00",
                "categories": ["tariff_risk"],
                },
            ],
            provider_router=ProviderRouter(
                market_provider=StubLiveMarketProvider(),
                csv_related_assets_path=related_path,
                csv_calendar_dir=tmp_path / "calendar",
                yahoo_enabled=False,
            ),
        )
    replay = TimelineStore(tmp_path / "timeline.sqlite").get_market_replay(
        "2026-05-19T07:00:00+08:00",
        "2026-05-19T07:30:00+08:00",
    )

    assert outcome["evidence_packet"]["dynamic_themes"][0]["theme_id"] == "theme:tariff_risk"
    assert outcome["evidence_packet"]["dynamic_themes"][0]["current_state"] == "active"
    assert any(
        item["driver_id"] == "theme:tariff_risk"
        for item in replay["driver_attention_timeline"]
    )
