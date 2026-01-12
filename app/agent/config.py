import json
import os
import sys
from datetime import datetime
from pathlib import Path

APP_NAME = "XAUUSDCalendarAgent"
_DEFAULT_REPO_PATH: str | None = None


def _get_appdata_dir() -> Path:
    override = (os.environ.get("XAUUSD_CALENDAR_AGENT_DATA_DIR") or "").strip()
    if override:
        return Path(override)
    base = get_default_repo_path()
    if not base:
        return Path.home() / ".config" / APP_NAME
    return Path(base) / "user-data"


def get_config_path() -> Path:
    return _get_appdata_dir() / "config.json"


def get_legacy_config_path() -> Path:
    # Older builds stored config next to the executable/script folder.
    return Path(get_default_repo_path()) / "config.json"


def get_log_dir() -> Path:
    return _get_appdata_dir() / "logs"


def get_update_dir() -> Path:
    return _get_appdata_dir() / "updates"


def get_repo_dir() -> Path:
    return _get_appdata_dir() / "repo"


def get_default_repo_path() -> str:
    global _DEFAULT_REPO_PATH
    if _DEFAULT_REPO_PATH is not None:
        return _DEFAULT_REPO_PATH
    try:
        if getattr(sys, "frozen", False):
            _DEFAULT_REPO_PATH = str(Path(sys.executable).resolve().parent)
        else:
            _DEFAULT_REPO_PATH = str(Path(__file__).resolve().parents[2])
    except Exception:  # noqa: BLE001
        _DEFAULT_REPO_PATH = ""
    return _DEFAULT_REPO_PATH


def get_default_config() -> dict:
    return {
        "repo_path": get_default_repo_path(),
        "sync_repo_path": "",
        "output_dir": "",
        "enable_sync_repo": False,
        "sync_repo_confirmed_path": "",
        "sync_repo_confirmed_repo": "",
        "sync_repo_confirmed_mode": "",
        "sync_repo_confirmed_at": "",
        "auto_pull_days": 1,
        "check_interval_minutes": 360,
        "auto_sync_after_pull": True,
        "debug": False,
        "last_pull_at": "",
        "last_sync_at": "",
        "last_pull_sha": "",
        "auto_update_enabled": True,
        "auto_update_interval_minutes": 60,
        "github_repo": "yiyousiow000814/xauusd-news-information-and-predictions",
        "github_release_asset_name": "Setup.exe",
        "run_on_startup": True,
        "settings_auto_save": True,
        "theme_preference": "system",
        "split_ratio": 0.66,
        "repo_path_history": [],
        "sync_repo_path_history": [],
        "output_dir_history": [],
        "successful_repo_paths": [],
        "created_paths": [],
    }


def _ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def load_config() -> dict:
    path = get_config_path()
    config = get_default_config()
    candidates = [
        path,
        get_legacy_config_path(),
    ]
    for candidate in candidates:
        try:
            if not candidate or not candidate.exists():
                continue
        except OSError:
            continue
        try:
            with candidate.open("r", encoding="utf-8") as handle:
                data = json.load(handle)
            if isinstance(data, dict):
                config.update(data)
                break
        except (OSError, json.JSONDecodeError):
            continue

    config.pop("version", None)

    # Ensure the config exists so future runs have a stable location.
    if not path.exists():
        save_config(config)
    return config


def save_config(config: dict) -> None:
    path = get_config_path()
    try:
        _ensure_parent(path)
        with path.open("w", encoding="utf-8") as handle:
            json.dump(config, handle, indent=2, ensure_ascii=True)
    except OSError:
        # If the install folder is moved/locked while running, avoid crashing the app.
        return


def to_display_time(dt: datetime | None) -> str:
    if not dt:
        return "Not yet"
    return dt.strftime("%d-%m-%Y %H:%M")


def parse_iso_time(value: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def to_iso_time(dt: datetime | None) -> str:
    if not dt:
        return ""
    return dt.isoformat(timespec="seconds")
