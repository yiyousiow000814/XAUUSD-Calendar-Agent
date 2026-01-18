import json
import sys
from pathlib import Path


def _ensure_app_on_path() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    app_dir = repo_root / "app"
    if str(app_dir) not in sys.path:
        sys.path.insert(0, str(app_dir))


def test_load_config_migrates_legacy_temp_path_keys(tmp_path, monkeypatch):
    _ensure_app_on_path()
    from agent import config as agent_config

    monkeypatch.setenv("XAUUSD_CALENDAR_AGENT_DATA_DIR", str(tmp_path))

    key_map = agent_config._legacy_config_key_map()
    legacy_path_key = next(k for k, v in key_map.items() if v == "temporary_path")
    legacy_enable_key = next(
        k for k, v in key_map.items() if v == "enable_temporary_path"
    )
    legacy_history_key = next(
        k for k, v in key_map.items() if v == "temporary_path_history"
    )

    config_path = agent_config.get_config_path()
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(
        json.dumps(
            {
                legacy_path_key: r"C:\tmp\temp-path",
                legacy_enable_key: True,
                legacy_history_key: [r"C:\tmp\one", r"C:\tmp\two"],
            },
            ensure_ascii=True,
        ),
        encoding="utf-8",
    )

    loaded = agent_config.load_config()
    assert loaded["temporary_path"] == r"C:\tmp\temp-path"
    assert loaded["enable_temporary_path"] is True
    assert loaded["temporary_path_history"] == [r"C:\tmp\one", r"C:\tmp\two"]
    assert legacy_path_key not in loaded
    assert legacy_enable_key not in loaded
    assert legacy_history_key not in loaded

    on_disk = json.loads(config_path.read_text(encoding="utf-8"))
    assert "temporary_path" in on_disk
    assert legacy_path_key not in on_disk
    assert legacy_enable_key not in on_disk
    assert legacy_history_key not in on_disk


def test_load_config_does_not_override_existing_temp_path(tmp_path, monkeypatch):
    _ensure_app_on_path()
    from agent import config as agent_config

    monkeypatch.setenv("XAUUSD_CALENDAR_AGENT_DATA_DIR", str(tmp_path))

    key_map = agent_config._legacy_config_key_map()
    legacy_path_key = next(k for k, v in key_map.items() if v == "temporary_path")

    config_path = agent_config.get_config_path()
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(
        json.dumps(
            {
                "temporary_path": r"C:\tmp\already-set",
                legacy_path_key: r"C:\tmp\legacy-value",
            },
            ensure_ascii=True,
        ),
        encoding="utf-8",
    )

    loaded = agent_config.load_config()
    assert loaded["temporary_path"] == r"C:\tmp\already-set"
    assert legacy_path_key not in loaded
