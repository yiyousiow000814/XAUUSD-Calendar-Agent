from app.agent.event_history import build_event_canonical_id, parse_event_components


def test_parse_event_components_extracts_frequency() -> None:
    identity = parse_event_components("Retail Sales m/m")
    assert identity.metric == "Retail Sales"
    assert identity.frequency == "m/m"
    assert identity.period == ""


def test_parse_event_components_extracts_frequency_in_parentheses() -> None:
    identity = parse_event_components("CPI (MoM)")
    assert identity.metric == "CPI"
    assert identity.frequency == "m/m"
    assert identity.period == ""


def test_parse_event_components_extracts_period() -> None:
    identity = parse_event_components("GDP (Q4)")
    assert identity.metric == "GDP"
    assert identity.frequency == "none"
    assert identity.period == "Q4"


def test_event_canonical_id_separates_frequency() -> None:
    mom_id, _ = build_event_canonical_id("USD", "CPI (MoM)")
    yoy_id, _ = build_event_canonical_id("USD", "CPI (YoY)")
    assert mom_id != yoy_id
