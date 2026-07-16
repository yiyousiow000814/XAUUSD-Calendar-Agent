from src.xauusd_market_agent.state import empty_market_state
from src.xauusd_market_agent.state_store import JsonStateStore


def test_json_state_store_round_trips_market_state(tmp_path) -> None:
    store = JsonStateStore(tmp_path / "state.json")
    state = empty_market_state(main_driver="yields", current_bias="bearish_gold")
    store.save(state)

    loaded = store.load()

    assert loaded.main_driver == "yields"
    assert loaded.current_bias == "bearish_gold"
    assert loaded.cause_status == "unconfirmed"
    assert loaded.invalidation_triggered is False
