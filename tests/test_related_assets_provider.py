import json

from src.xauusd_market_agent.providers.related_assets import load_related_assets_snapshot


def test_load_related_assets_snapshot_from_json_file(tmp_path) -> None:
    path = tmp_path / "related_assets.json"
    path.write_text(
        json.dumps(
            {
                "dxy_percent": 0.22,
                "us10y_bps": 5.1,
                "us2y_bps": 4.4,
                "wti_percent": 1.6,
            }
        ),
        encoding="utf-8",
    )

    snapshot = load_related_assets_snapshot(path)

    assert snapshot.dxy_percent == 0.22
    assert snapshot.us10y_bps == 5.1
