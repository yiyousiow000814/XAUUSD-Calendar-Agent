import json

from src.xauusd_market_agent.providers.related_assets import refresh_related_assets_cache


def test_refresh_related_assets_cache_copies_local_sources(tmp_path) -> None:
    source_dir = tmp_path / "source"
    source_dir.mkdir()
    (source_dir / "dxy.csv").write_text(
        "timestamp,close\n2026-05-19T07:00:00+08:00,100.0\n",
        encoding="utf-8",
    )
    mapping_path = tmp_path / "sources.json"
    mapping_path.write_text(
        json.dumps({"dxy": str(source_dir / "dxy.csv")}),
        encoding="utf-8",
    )
    target_dir = tmp_path / "cache"

    refreshed = refresh_related_assets_cache(mapping_path, target_dir)

    assert refreshed == ["dxy"]
    assert (target_dir / "dxy.csv").exists()
