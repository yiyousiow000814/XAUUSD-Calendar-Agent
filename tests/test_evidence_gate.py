from src.xauusd_market_agent.evidence import build_evidence_gate_result
from src.xauusd_market_agent.fixtures import load_builtin_fixture
from src.xauusd_market_agent.models import CrossAssetSnapshot, Headline, MarketMove, ScenarioFixture
from src.xauusd_market_agent.provider_health import build_fixture_provider_health, build_provider_health


def test_yield_pressure_scenario_allows_usd_and_yields() -> None:
    result = build_evidence_gate_result(load_builtin_fixture("yield_pressure_confirmed"))

    assert "usd" in result.allowed_candidate_drivers
    assert "yields" in result.allowed_candidate_drivers
    assert "geopolitics" in result.blocked_drivers


def test_unconfirmed_scenario_blocks_macro_drivers() -> None:
    result = build_evidence_gate_result(load_builtin_fixture("unconfirmed_move"))

    assert result.allowed_candidate_drivers == ["technical_liquidation", "unknown"]
    assert "usd" in result.blocked_drivers
    assert "yields" in result.blocked_drivers


def test_oil_move_alone_stays_background_without_channel_confirmation() -> None:
    fixture = load_builtin_fixture("oil_inflation_pressure")
    health = build_fixture_provider_health(fixture)
    health["us10y"] = build_provider_health(
        source="US10Y",
        source_type="related_asset",
        data_mode="unavailable",
        is_available=False,
        error="No yield data.",
    )
    health["us2y"] = build_provider_health(
        source="US2Y",
        source_type="related_asset",
        data_mode="unavailable",
        is_available=False,
        error="No yield data.",
    )

    result = build_evidence_gate_result(fixture, provider_health=health)

    assert "oil_inflation" not in result.allowed_candidate_drivers
    assert result.evidence_status["oil"] in {"not_confirming", "neutral", "confirming"}


def test_fed_headline_without_yield_confirmation_stays_context_only() -> None:
    fixture = ScenarioFixture(
        scenario_id="fed_headline_without_yield_confirmation",
        as_of_myt="12-06-2026 22:57",
        market=MarketMove(
            symbol="XAUUSD",
            from_price=4188.73,
            to_price=4204.67,
            move_percent=0.38,
            move_percent_15m=0.21,
            move_percent_1h=0.38,
            window_minutes=70,
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
                timestamp_myt="12-06-2026 22:40",
                source="MarketWatch.com - Top Stories",
                title="Fed rate debate stays in focus before next inflation print",
                relevance_reason="Fed headline.",
                impact_direction_on_gold="neutral",
                tags=("fed", "rates"),
            ),
        ),
    )

    result = build_evidence_gate_result(fixture)

    assert "fed_rates" not in result.allowed_candidate_drivers
    assert "fed_rates" in result.blocked_drivers
    assert "missing or stale" not in result.blocked_drivers["fed_rates"]
    assert "not market-confirmed" in result.blocked_drivers["fed_rates"]
    assert result.evidence_status["us10y"] == "not_confirming"
    assert result.evidence_status["us2y"] == "not_confirming"


def test_fresh_neutral_yields_are_not_reported_as_missing_or_stale() -> None:
    fixture = ScenarioFixture(
        scenario_id="fresh_neutral_yields",
        as_of_myt="17-06-2026 14:14",
        market=MarketMove(
            symbol="XAUUSD",
            from_price=4329.2,
            to_price=4328.31,
            move_percent=-0.02,
            move_percent_15m=-0.02,
            move_percent_1h=-0.02,
            window_minutes=20,
        ),
        cross_asset=CrossAssetSnapshot(
            dxy_percent=0.03,
            us10y_bps=0.0,
            us2y_bps=0.0,
            wti_percent=0.25,
            brent_percent=0.28,
            vix_percent=0.0,
            spx_percent=0.0,
            nasdaq_percent=0.0,
        ),
        news=(
            Headline(
                timestamp_myt="17-06-2026 03:12",
                source="US Top News and Analysis",
                title="Fed Chair Warsh expected to withhold dot from central bank interest rate outlook",
                relevance_reason="Fed headline.",
                impact_direction_on_gold="unknown",
                tags=("fed", "rates"),
            ),
        ),
    )

    result = build_evidence_gate_result(fixture)

    assert result.evidence_status["us10y"] == "not_confirming"
    assert result.evidence_status["us2y"] == "not_confirming"
    assert "fresh but not confirming" in result.blocked_drivers["yields"]
    assert "missing or stale" not in result.blocked_drivers["yields"]


def test_oil_geopolitical_headline_without_oil_confirmation_does_not_allow_oil_inflation() -> None:
    fixture = ScenarioFixture(
        scenario_id="oil_geo_headline_without_oil_confirmation",
        as_of_myt="12-06-2026 22:57",
        market=MarketMove(
            symbol="XAUUSD",
            from_price=4188.73,
            to_price=4204.67,
            move_percent=0.38,
            move_percent_15m=0.21,
            move_percent_1h=0.38,
            window_minutes=70,
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
                timestamp_myt="12-06-2026 22:42",
                source="US Top News and Analysis",
                title="Oil tanker traffic through Hormuz remains uncertain after Iran warning",
                relevance_reason="Oil and geopolitical headline.",
                impact_direction_on_gold="bullish",
                tags=("oil", "hormuz", "iran"),
            ),
        ),
    )

    result = build_evidence_gate_result(fixture)

    assert "oil_inflation" not in result.allowed_candidate_drivers
    assert "oil_inflation" in result.blocked_drivers
    assert result.evidence_status["oil"] == "not_confirming"


def test_geopolitics_is_blocked_without_timestamped_headline() -> None:
    result = build_evidence_gate_result(load_builtin_fixture("yield_pressure_confirmed"))

    assert "geopolitics" not in result.allowed_candidate_drivers
    assert result.blocked_drivers["geopolitics"]


def test_warsh_headline_does_not_open_geopolitics_gate() -> None:
    fixture = ScenarioFixture(
        scenario_id="warsh_not_war_gate",
        as_of_myt="13-06-2026 21:57",
        market=MarketMove(
            symbol="XAUUSD",
            from_price=4100.0,
            to_price=4120.0,
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
                timestamp_myt="13-06-2026 05:11",
                source="US Top News and Analysis",
                title="Call Kevin Warsh the Fed chairman",
                relevance_reason="Fed leadership headline.",
                impact_direction_on_gold="unknown",
                tags=("rss", "fed"),
            ),
        ),
    )

    result = build_evidence_gate_result(fixture)

    assert "geopolitics" not in result.allowed_candidate_drivers
    assert result.blocked_drivers["geopolitics"]


def test_geopolitical_news_stays_context_when_cross_assets_and_price_do_not_confirm() -> None:
    fixture = ScenarioFixture(
        scenario_id="geo_news_cross_assets_stale",
        as_of_myt="11-06-2026 11:50",
        market=MarketMove(
            symbol="XAUUSD",
            from_price=4070.0,
            to_price=4071.0,
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

    result = build_evidence_gate_result(fixture, provider_health=health)

    assert "geopolitics" not in result.allowed_candidate_drivers
    assert result.blocked_drivers["geopolitics"] == "Geopolitical headline is present, but market confirmation is incomplete."
    assert result.evidence_status["news"] == "relevant_news_found"
