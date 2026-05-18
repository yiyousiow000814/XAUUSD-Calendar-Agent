from datetime import datetime

from src.xauusd_market_agent.providers.market_prices import load_recent_market_snapshot


def test_load_recent_market_snapshot_from_csv_fixture(tmp_path) -> None:
    csv_path = tmp_path / "prices.csv"
    csv_path.write_text(
        "timestamp,open,high,low,close\n"
        "2026-05-19T07:00:00+08:00,4500,4502,4499,4501\n"
        "2026-05-19T07:15:00+08:00,4501,4503,4490,4491\n",
        encoding="utf-8",
    )

    snapshot = load_recent_market_snapshot(
        price_path=csv_path,
        anchor_time=datetime.fromisoformat("2026-05-19T07:15:00+08:00"),
    )

    assert snapshot.market.symbol == "XAUUSD"
    assert snapshot.market.to_price == 4491.0


def test_load_recent_market_snapshot_uses_latest_available_window_when_anchor_is_stale(tmp_path) -> None:
    csv_path = tmp_path / "prices.csv"
    csv_path.write_text(
        "timestamp,open,high,low,close\n"
        "2026-01-30T06:00:00+08:00,5200,5201,5198,5199\n"
        "2026-01-30T14:13:00+08:00,5060,5061,5058,5060\n"
        "2026-01-30T14:28:00+08:00,5060,5070,5059,5069\n",
        encoding="utf-8",
    )

    snapshot = load_recent_market_snapshot(
        price_path=csv_path,
        anchor_time=datetime.fromisoformat("2026-05-19T00:31:00+08:00"),
    )

    assert snapshot.market.window_minutes == 15
    assert snapshot.market.from_price == 5060.0
