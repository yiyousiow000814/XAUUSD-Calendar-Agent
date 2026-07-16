from src.xauusd_market_agent.detectors import detect_market_trigger
from src.xauusd_market_agent.fixtures import load_builtin_fixture


def test_detect_market_trigger_flags_large_15m_drop() -> None:
    trigger = detect_market_trigger(load_builtin_fixture("yield_pressure_confirmed"))

    assert trigger.triggered is True
    assert "move_15m" in trigger.trigger_types


def test_detect_market_trigger_suppresses_small_move() -> None:
    trigger = detect_market_trigger(load_builtin_fixture("no_meaningful_change"))

    assert trigger.triggered is False
    assert trigger.trigger_types == []
