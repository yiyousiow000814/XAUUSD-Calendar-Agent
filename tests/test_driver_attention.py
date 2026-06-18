from src.xauusd_market_agent.driver_attention import DriverAttentionManager
from src.xauusd_market_agent.evidence import build_evidence_gate_result
from src.xauusd_market_agent.fixtures import load_builtin_fixture
from src.xauusd_market_agent.models import CrossAssetSnapshot, Headline, MarketMove, ScenarioFixture
from src.xauusd_market_agent.provider_health import build_fixture_provider_health


def test_oil_monitored_but_dormant_by_default() -> None:
    fixture = load_builtin_fixture("unconfirmed_move")
    health = build_fixture_provider_health(fixture)
    evidence = build_evidence_gate_result(fixture, provider_health=health)

    snapshot = DriverAttentionManager().evaluate(
        fixture=fixture,
        provider_health=health,
        evidence_status=evidence.evidence_status,
    )

    assert snapshot.states["oil_inflation"].current_state == "dormant"


def test_oil_becomes_active_only_with_fresh_channel_confirmation() -> None:
    fixture = load_builtin_fixture("oil_inflation_pressure")
    health = build_fixture_provider_health(fixture)
    evidence = build_evidence_gate_result(fixture, provider_health=health)

    snapshot = DriverAttentionManager().evaluate(
        fixture=fixture,
        provider_health=health,
        evidence_status=evidence.evidence_status,
    )

    assert snapshot.states["oil_inflation"].current_state == "active"
    assert snapshot.states["oil_inflation"].evidence_refs
    assert any(
        token in snapshot.states["oil_inflation"].evidence_refs[0]["title"].lower()
        for token in ("oil", "crude", "brent", "wti")
    )


def test_active_geopolitics_keeps_representative_headline_refs() -> None:
    fixture = ScenarioFixture(
        scenario_id="geopolitics_with_headline",
        as_of_myt="13-06-2026 21:57",
        market=MarketMove(
            symbol="XAUUSD",
            from_price=4100.0,
            to_price=4122.5,
            move_percent=0.55,
            move_percent_15m=0.55,
            move_percent_1h=0.55,
            window_minutes=15,
            breaks=(),
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
                timestamp_myt="13-06-2026 21:57",
                source="US Top News and Analysis",
                title="Iran escalation keeps Hormuz risk in focus",
                relevance_reason="Geopolitical shock headline.",
                impact_direction_on_gold="bullish",
                tags=("iran", "hormuz", "geopolitics"),
            ),
        ),
    )
    health = build_fixture_provider_health(fixture)
    evidence = build_evidence_gate_result(fixture, provider_health=health)

    snapshot = DriverAttentionManager().evaluate(
        fixture=fixture,
        provider_health=health,
        evidence_status=evidence.evidence_status,
    )

    state = snapshot.states["geopolitics"]
    assert state.current_state == "active"
    assert state.evidence_refs
    assert state.evidence_refs[0]["kind"] == "news"
    assert state.evidence_refs[0]["title"] in {item.title for item in fixture.news}


def test_geopolitics_headline_without_market_confirmation_stays_watching() -> None:
    fixture = ScenarioFixture(
        scenario_id="geopolitics_headline_context_only",
        as_of_myt="13-06-2026 21:57",
        market=MarketMove(
            symbol="XAUUSD",
            from_price=4100.0,
            to_price=4104.0,
            move_percent=0.10,
            move_percent_15m=0.10,
            move_percent_1h=0.10,
            window_minutes=15,
            breaks=(),
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
                timestamp_myt="13-06-2026 21:57",
                source="US Top News and Analysis",
                title="Iran escalation keeps Hormuz risk in focus",
                relevance_reason="Geopolitical shock headline.",
                impact_direction_on_gold="bullish",
                tags=("iran", "hormuz", "geopolitics"),
            ),
        ),
    )
    health = build_fixture_provider_health(fixture)
    evidence = build_evidence_gate_result(fixture, provider_health=health)

    snapshot = DriverAttentionManager().evaluate(
        fixture=fixture,
        provider_health=health,
        evidence_status=evidence.evidence_status,
    )

    state = snapshot.states["geopolitics"]
    assert state.current_state == "watching"
    assert state.activation_reason == "Geopolitical headline exists, but cross-market confirmation is incomplete."
    assert state.evidence_refs


def test_geopolitics_headline_with_minor_price_move_stays_watching() -> None:
    fixture = ScenarioFixture(
        scenario_id="geopolitics_headline_minor_price_move",
        as_of_myt="13-06-2026 21:57",
        market=MarketMove(
            symbol="XAUUSD",
            from_price=4100.0,
            to_price=4113.12,
            move_percent=0.32,
            move_percent_15m=0.32,
            move_percent_1h=0.32,
            window_minutes=80,
            breaks=(),
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
                timestamp_myt="13-06-2026 21:57",
                source="US Top News and Analysis",
                title="Iran escalation keeps Hormuz risk in focus",
                relevance_reason="Geopolitical shock headline.",
                impact_direction_on_gold="bullish",
                tags=("iran", "hormuz", "geopolitics"),
            ),
        ),
    )
    health = build_fixture_provider_health(fixture)
    evidence = build_evidence_gate_result(fixture, provider_health=health)

    snapshot = DriverAttentionManager().evaluate(
        fixture=fixture,
        provider_health=health,
        evidence_status=evidence.evidence_status,
    )

    state = snapshot.states["geopolitics"]
    assert state.current_state == "watching"
    assert state.activation_reason == "Geopolitical headline exists, but cross-market confirmation is incomplete."
    assert state.evidence_refs


def test_warsh_headline_does_not_trigger_geopolitics_by_substring() -> None:
    fixture = ScenarioFixture(
        scenario_id="warsh_not_war",
        as_of_myt="13-06-2026 21:57",
        market=MarketMove(
            symbol="XAUUSD",
            from_price=4100.0,
            to_price=4120.0,
            move_percent=0.49,
            move_percent_15m=0.49,
            move_percent_1h=0.49,
            window_minutes=15,
            breaks=(),
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
                timestamp_myt="13-06-2026 05:11",
                source="US Top News and Analysis",
                title="Call Kevin Warsh the Fed chairman",
                relevance_reason="Fed leadership headline.",
                impact_direction_on_gold="unknown",
                tags=("rss", "fed"),
            ),
        ),
    )
    health = build_fixture_provider_health(fixture)
    evidence = build_evidence_gate_result(fixture, provider_health=health)

    snapshot = DriverAttentionManager().evaluate(
        fixture=fixture,
        provider_health=health,
        evidence_status=evidence.evidence_status,
    )

    assert snapshot.states["geopolitics"].current_state == "dormant"
    assert snapshot.states["geopolitics"].evidence_refs == ()


def test_micro_theme_starts_watching_then_emerging() -> None:
    manager = DriverAttentionManager()

    first = manager.evaluate_micro_theme(
        theme_id="shipping_route_disruption",
        headline_count=1,
        source_count=1,
        cross_asset_confirmation="confirming",
    )
    second = manager.evaluate_micro_theme(
        theme_id="shipping_route_disruption",
        headline_count=1,
        source_count=2,
        cross_asset_confirmation="confirming",
    )

    assert first["status"] == "watching"
    assert second["status"] == "emerging"


def test_driver_decays_to_cooling_then_retired_when_not_refreshed() -> None:
    manager = DriverAttentionManager()
    active_fixture = load_builtin_fixture("oil_inflation_pressure")
    active_health = build_fixture_provider_health(active_fixture)
    active_evidence = build_evidence_gate_result(active_fixture, provider_health=active_health)
    active_snapshot = manager.evaluate(
        fixture=active_fixture,
        provider_health=active_health,
        evidence_status=active_evidence.evidence_status,
    )

    cooling_fixture = load_builtin_fixture("unconfirmed_move")
    cooling_health = build_fixture_provider_health(cooling_fixture)
    cooling_evidence = build_evidence_gate_result(cooling_fixture, provider_health=cooling_health)
    cooling_snapshot = manager.evaluate(
        fixture=cooling_fixture,
        provider_health=cooling_health,
        evidence_status=cooling_evidence.evidence_status,
        previous_states=active_snapshot.states,
    )

    retired_fixture = ScenarioFixture(
        scenario_id="later_unconfirmed",
        as_of_myt="19-05-2026 12:30",
        market=MarketMove(
            symbol="XAUUSD",
            from_price=4500.0,
            to_price=4485.0,
            move_percent=-0.33,
            move_percent_15m=-0.33,
            move_percent_1h=-0.33,
            window_minutes=15,
            breaks=(),
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
        calendar_events=(),
        news=(),
        expected_llm_claim=None,
    )
    retired_health = build_fixture_provider_health(retired_fixture)
    retired_evidence = build_evidence_gate_result(retired_fixture, provider_health=retired_health)
    retired_snapshot = manager.evaluate(
        fixture=retired_fixture,
        provider_health=retired_health,
        evidence_status=retired_evidence.evidence_status,
        previous_states=cooling_snapshot.states,
    )

    assert cooling_snapshot.states["oil_inflation"].current_state == "cooling"
    assert retired_snapshot.states["oil_inflation"].current_state == "retired"
