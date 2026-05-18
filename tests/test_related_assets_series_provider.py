from datetime import datetime

from src.xauusd_market_agent.providers.related_assets import load_related_assets_timeseries_snapshot


def test_load_related_assets_timeseries_snapshot_computes_pct_and_bps_changes(tmp_path) -> None:
    assets_dir = tmp_path / "assets"
    assets_dir.mkdir()
    (assets_dir / "dxy.csv").write_text(
        "timestamp,close\n"
        "2026-05-19T07:00:00+08:00,100.00\n"
        "2026-05-19T07:15:00+08:00,100.22\n",
        encoding="utf-8",
    )
    (assets_dir / "us10y.csv").write_text(
        "timestamp,close\n"
        "2026-05-19T07:00:00+08:00,4.10\n"
        "2026-05-19T07:15:00+08:00,4.15\n",
        encoding="utf-8",
    )
    (assets_dir / "wti.csv").write_text(
        "timestamp,close\n"
        "2026-05-19T07:00:00+08:00,80.00\n"
        "2026-05-19T07:15:00+08:00,81.60\n",
        encoding="utf-8",
    )

    snapshot = load_related_assets_timeseries_snapshot(
        assets_dir=assets_dir,
        anchor_time=datetime.fromisoformat("2026-05-19T07:15:00+08:00"),
        window_minutes=15,
    )

    assert round(snapshot.dxy_percent, 2) == 0.22
    assert round(snapshot.us10y_bps, 1) == 5.0
    assert round(snapshot.wti_percent, 2) == 2.0
