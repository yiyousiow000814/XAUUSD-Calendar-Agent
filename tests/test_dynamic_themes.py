from dataclasses import asdict
from datetime import datetime
import json

from src.xauusd_market_agent.driver_attention import DriverAttentionManager
from src.xauusd_market_agent.evidence import build_evidence_gate_result
from src.xauusd_market_agent.live_pipeline import run_monitored_live_once
from src.xauusd_market_agent.models import CrossAssetSnapshot, DriverAttentionState, Headline, MarketMove, ScenarioFixture
from src.xauusd_market_agent.pipeline import build_llm_evidence_packet
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


class StubLiveRelatedAssetsProvider:
    def fetch_latest(self, anchor_time):
        rows = [
            {
                "symbol": "dxy",
                "data_timestamp": anchor_time.isoformat(),
                "change_15m": 0.25,
                "change_value": 0.25,
                "change_unit": "percent",
                "source": "stub",
                "source_type": "proxy",
                "data_mode": "live_seen",
                "is_stale": False,
            },
            {
                "symbol": "us10y",
                "data_timestamp": anchor_time.isoformat(),
                "change_15m": 5.0,
                "change_value": 5.0,
                "change_unit": "bps",
                "source": "stub",
                "source_type": "proxy",
                "data_mode": "live_seen",
                "is_stale": False,
            },
        ]
        health = {
            "dxy": build_provider_health(
                source="DXY",
                source_type="proxy",
                data_mode="live_seen",
                is_available=True,
                is_stale=False,
                current_value=0.25,
                change_value=0.25,
                change_unit="percent",
                data_timestamp=anchor_time.isoformat(),
            ),
            "us10y": build_provider_health(
                source="US10Y",
                source_type="proxy",
                data_mode="live_seen",
                is_available=True,
                is_stale=False,
                current_value=5.0,
                change_value=5.0,
                change_unit="bps",
                data_timestamp=anchor_time.isoformat(),
            ),
            "us2y": build_provider_health(
                source="US2Y",
                source_type="provider_interface",
                data_mode="unavailable",
                is_available=False,
                stale_reason="No reliable free US2Y source configured.",
                data_timestamp=anchor_time.isoformat(),
            ),
        }
        return rows, health

    def backfill(self, start, end):
        return self.fetch_latest(end)


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


def test_filtered_personal_finance_headlines_do_not_create_dynamic_themes() -> None:
    fixture = _fixture(
        news=(
            _headline(
                "My husband took out a Parent PLUS loan without telling me",
                "MarketWatch",
                "filtered",
                "no_market_agent_keyword",
            ),
            _headline(
                "My friend earns more than me but wants me to pay for vacation",
                "MarketWatch",
                "filtered",
                "no_market_agent_keyword",
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

    theme_ids = [driver_id for driver_id in attention.states if driver_id.startswith("theme:")]

    assert theme_ids == []


def test_retired_dynamic_themes_do_not_enter_current_evidence_packet() -> None:
    fixture = _fixture(news=())
    health = build_fixture_provider_health(fixture)
    previous_theme = DriverAttentionState(
        driver_id="theme:husband_took",
        label="Husband Took",
        category="theme",
        current_state="retired",
        priority="micro_theme",
        relevance_score=0.0,
        activation_reason="",
        deactivation_reason="No fresh headlines or market follow-through for this dynamic theme.",
        first_activated_at="31-05-2026 16:28",
        last_confirmed_at="",
        last_evidence_at="31-05-2026 16:28",
        decay_deadline="2026-05-31T17:13:00+08:00",
        linked_assets=("news", "xauusd"),
        required_evidence_gates=("news",),
        optional_evidence_gates=("news", "xauusd"),
        current_evidence_summary="1 headline(s) from 1 source(s).",
        current_counter_evidence="Theme has no fresh supporting evidence in the current run.",
        confidence="low",
        source_count=1,
        related_news_count=1,
        related_calendar_events=0,
        notes="Dynamic theme discovered from current headlines.",
        data_mode="stale",
        theme_id="theme:husband_took",
        lifecycle="retired",
        source_terms=("husband took", "parent plus"),
        related_sensor_ids=("news", "xauusd"),
        requested_sensor_ids=("news", "xauusd"),
        rejection_reason="Single-source or one-off headline; not enough evidence.",
    )
    evidence = build_evidence_gate_result(fixture, provider_health=health)
    attention = DriverAttentionManager().evaluate(
        fixture=fixture,
        provider_health=health,
        evidence_status=evidence.evidence_status,
        previous_states={"theme:husband_took": previous_theme},
    )
    packet = build_llm_evidence_packet(
        fixture,
        provider_health=health,
        attention_snapshot=attention,
    )

    assert all(theme["theme_id"] != "theme:husband_took" for theme in packet["dynamic_themes"])
    assert all(row["driver_id"] != "theme:husband_took" for row in packet["dormant_driver_states"])


def test_dynamic_theme_without_current_evidence_does_not_stay_active_in_packet() -> None:
    fixture = _fixture(news=())
    health = build_fixture_provider_health(fixture)
    previous_theme = DriverAttentionState(
        driver_id="theme:fed",
        label="Fed",
        category="theme",
        current_state="active",
        priority="micro_theme",
        relevance_score=0.76,
        activation_reason="Repeated headlines across multiple sources.",
        deactivation_reason="",
        first_activated_at="19-05-2026 06:15",
        last_confirmed_at="19-05-2026 06:30",
        last_evidence_at="19-05-2026 06:30",
        decay_deadline="2026-05-19T08:00:00+08:00",
        linked_assets=("news", "xauusd"),
        required_evidence_gates=("news",),
        optional_evidence_gates=("news", "xauusd"),
        current_evidence_summary="4 headline(s) from 3 source(s).",
        current_counter_evidence="",
        confidence="medium",
        source_count=3,
        related_news_count=4,
        related_calendar_events=0,
        notes="Dynamic theme discovered from current headlines.",
        data_mode="live_seen",
        theme_id="theme:fed",
        lifecycle="active",
        source_terms=("fed", "fomc"),
        related_sensor_ids=("news", "xauusd"),
        requested_sensor_ids=("news", "xauusd"),
        promotion_reason="Repeated headlines across multiple sources.",
        rejection_reason="",
    )
    evidence = build_evidence_gate_result(fixture, provider_health=health)
    attention = DriverAttentionManager().evaluate(
        fixture=fixture,
        provider_health=health,
        evidence_status=evidence.evidence_status,
        previous_states={"theme:fed": previous_theme},
    )
    packet = build_llm_evidence_packet(
        fixture,
        provider_health=health,
        attention_snapshot=attention,
    )

    assert all(row["driver_id"] != "theme:fed" for row in packet["active_driver_states"])
    assert all(theme["theme_id"] != "theme:fed" for theme in packet["dynamic_themes"])


def test_replay_filters_retired_dynamic_theme_noise(tmp_path) -> None:
    store = TimelineStore(tmp_path / "timeline.sqlite")
    run_id = store.record_monitor_run(
        run_started_at="2026-05-19T07:15:00+08:00",
        run_type="live",
        data_mode="live_seen",
        backfill_required=False,
        last_successful_run_at=None,
        no_news_found=False,
        alert_suppressed_reason="",
    )
    active_theme = DriverAttentionState(
        driver_id="theme:tariff_risk",
        label="Tariff Risk",
        category="theme",
        current_state="active",
        priority="micro_theme",
        relevance_score=0.76,
        activation_reason="Repeated headlines.",
        deactivation_reason="",
        first_activated_at="19-05-2026 07:10",
        last_confirmed_at="19-05-2026 07:15",
        last_evidence_at="19-05-2026 07:15",
        decay_deadline="2026-05-19T08:00:00+08:00",
        linked_assets=("news", "xauusd"),
        required_evidence_gates=("news",),
        optional_evidence_gates=("news", "xauusd"),
        current_evidence_summary="2 headline(s).",
        current_counter_evidence="",
        confidence="medium",
        source_count=2,
        related_news_count=2,
        related_calendar_events=0,
        notes="Dynamic theme discovered from current headlines.",
        data_mode="live_seen",
        theme_id="theme:tariff_risk",
        lifecycle="active",
        source_terms=("tariff risk",),
        related_sensor_ids=("news", "xauusd"),
        requested_sensor_ids=("news", "xauusd"),
        promotion_reason="Repeated headlines.",
        rejection_reason="",
    )
    retired_theme = DriverAttentionState(
        **{
            **asdict(active_theme),
            "driver_id": "theme:old_noise",
            "theme_id": "theme:old_noise",
            "label": "Old Noise",
            "current_state": "retired",
            "relevance_score": 0.0,
            "lifecycle": "retired",
        }
    )
    store.record_driver_attention_states(
        run_id,
        {
            active_theme.driver_id: asdict(active_theme),
            retired_theme.driver_id: asdict(retired_theme),
        },
    )

    replay = store.get_market_replay(
        "2026-05-19T07:00:00+08:00",
        "2026-05-19T07:30:00+08:00",
    )
    driver_ids = [row["driver_id"] for row in replay["driver_attention_timeline"]]

    assert "theme:tariff_risk" in driver_ids
    assert "theme:old_noise" not in driver_ids


def test_replay_filters_dynamic_theme_retired_later_in_window(tmp_path) -> None:
    store = TimelineStore(tmp_path / "timeline.sqlite")
    first_run_id = store.record_monitor_run(
        run_started_at="2026-05-19T07:05:00+08:00",
        run_type="live",
        data_mode="live_seen",
        backfill_required=False,
        last_successful_run_at=None,
        no_news_found=False,
        alert_suppressed_reason="",
    )
    retired_run_id = store.record_monitor_run(
        run_started_at="2026-05-19T07:20:00+08:00",
        run_type="live",
        data_mode="live_seen",
        backfill_required=False,
        last_successful_run_at=None,
        no_news_found=False,
        alert_suppressed_reason="",
    )
    observed_theme = DriverAttentionState(
        driver_id="theme:old_noise",
        label="Old Noise",
        category="theme",
        current_state="observed",
        priority="micro_theme",
        relevance_score=0.25,
        activation_reason="Single weak headline.",
        deactivation_reason="",
        first_activated_at="19-05-2026 07:05",
        last_confirmed_at="19-05-2026 07:05",
        last_evidence_at="19-05-2026 07:05",
        decay_deadline="2026-05-19T08:00:00+08:00",
        linked_assets=("news",),
        required_evidence_gates=("news",),
        optional_evidence_gates=("news",),
        current_evidence_summary="1 headline.",
        current_counter_evidence="",
        confidence="low",
        source_count=1,
        related_news_count=1,
        related_calendar_events=0,
        notes="Weak dynamic theme.",
        data_mode="live_seen",
        theme_id="theme:old_noise",
        lifecycle="observed",
        source_terms=("old noise",),
        related_sensor_ids=("news",),
        requested_sensor_ids=("news",),
        promotion_reason="",
        rejection_reason="",
    )
    retired_theme = DriverAttentionState(
        **{
            **asdict(observed_theme),
            "current_state": "retired",
            "relevance_score": 0.0,
            "lifecycle": "retired",
            "deactivation_reason": "No current evidence.",
        }
    )
    store.record_driver_attention_states(first_run_id, {observed_theme.driver_id: asdict(observed_theme)})
    store.record_driver_attention_states(retired_run_id, {retired_theme.driver_id: asdict(retired_theme)})

    early_replay = store.get_market_replay(
        "2026-05-19T07:00:00+08:00",
        "2026-05-19T07:10:00+08:00",
    )
    full_replay = store.get_market_replay(
        "2026-05-19T07:00:00+08:00",
        "2026-05-19T07:30:00+08:00",
    )

    assert any(row["driver_id"] == "theme:old_noise" for row in early_replay["driver_attention_timeline"])
    assert all(row["driver_id"] != "theme:old_noise" for row in full_replay["driver_attention_timeline"])


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
                related_assets_provider=StubLiveRelatedAssetsProvider(),
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
