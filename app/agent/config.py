import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

APP_NAME = "XAUUSDCalendarAgent"
_DEFAULT_REPO_PATH: str | None = None
_SCHEMA_VERSION = 2


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
        "schema_version": _SCHEMA_VERSION,
        "repo_path": get_default_repo_path(),
        "temporary_path": "",
        "output_dir": "",
        "output_dir_last_sync_at": {},
        "enable_temporary_path": False,
        "temporary_path_confirmed_path": "",
        "temporary_path_confirmed_repo": "",
        "temporary_path_confirmed_mode": "",
        "temporary_path_confirmed_at": "",
        "auto_pull_days": 1,
        "check_interval_minutes": 360,
        "auto_sync_after_pull": True,
        "debug": False,
        "last_pull_at": "",
        "last_sync_at": "",
        "last_pull_sha": "",
        "auto_update_enabled": True,
        "auto_update_interval_minutes": 60,
        "github_repo": "yiyousiow000814/XAUUSD-Calendar-Agent",
        "github_branch": "main",
        "github_release_asset_name": "Setup.exe",
        "github_token": "",
        "run_on_startup": True,
        # Autostart launch mode is only applied when the process is started via the
        # Windows Run entry (we pass `--autostart` in the startup command).
        # Values: "tray" | "show"
        "autostart_launch_mode": "tray",
        # Window close behavior (X / Alt+F4). Values: "exit" | "tray"
        "close_behavior": "exit",
        "settings_auto_save": True,
        "theme_preference": "system",
        "split_ratio": 0.66,
        "repo_path_history": [],
        "temporary_path_history": [],
        "output_dir_history": [],
        "successful_repo_paths": [],
        "created_paths": [],
        "calendar_timezone_mode": "system",
        "calendar_utc_offset_minutes": 0,
    }


def get_github_token(config: dict | None = None) -> str:
    if config:
        value = (config.get("github_token") or "").strip()
        if value:
            return value
    path = get_config_path()
    try:
        if not path.exists():
            return ""
    except OSError:
        return ""
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
        if isinstance(data, dict):
            value = (data.get("github_token") or "").strip()
            return value
    except (OSError, json.JSONDecodeError):
        return ""
    return ""


def _ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def load_config() -> dict:
    path = get_config_path()
    defaults = get_default_config()
    config = dict(defaults)
    migrated_output_sync = False
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
    config.pop("github_token_hint", None)

    output_dir = (config.get("output_dir") or "").strip()
    legacy_last_sync_at = (config.get("last_sync_at") or "").strip()
    mapping = config.get("output_dir_last_sync_at")
    if not isinstance(mapping, dict):
        mapping = {}
        config["output_dir_last_sync_at"] = mapping
        migrated_output_sync = True
    if output_dir and legacy_last_sync_at:
        key = normalize_path_key(output_dir)
        if not (mapping.get(key) or "").strip():
            mapping[key] = legacy_last_sync_at
            migrated_output_sync = True

    # Ensure the config exists so future runs have a stable location, and also
    # backfill new default keys into existing configs.
    should_persist = False
    if not path.exists():
        should_persist = True
    else:
        try:
            with path.open("r", encoding="utf-8") as handle:
                existing = json.load(handle)
            if not isinstance(existing, dict):
                existing = {}
        except (OSError, json.JSONDecodeError):
            existing = {}
        if any(key not in existing for key in defaults):
            should_persist = True
    if migrated_output_sync:
        should_persist = True
    if should_persist:
        save_config(config)
    return config


def save_config(config: dict) -> None:
    path = get_config_path()
    try:
        _ensure_parent(path)
        merged: dict = {}
        existing: dict = {}
        if path.exists():
            payload = None
            decode_error_stats: list[tuple[int, int]] = []
            last_text = ""
            for attempt in range(6):
                try:
                    stat = path.stat()
                    text = path.read_text(encoding="utf-8")
                    last_text = text
                except OSError:
                    return

                try:
                    payload = json.loads(text) if text.strip() else {}
                    break
                except json.JSONDecodeError:
                    decode_error_stats.append((stat.st_mtime_ns, stat.st_size))
                    if attempt < 5:
                        time.sleep(0.05)

            if payload is None:
                stable = bool(decode_error_stats) and len(set(decode_error_stats)) == 1
                if not stable:
                    return
                try:
                    stamp = datetime.now().strftime("%Y%m%d%H%M%S")
                    backup = path.parent / f"{path.name}.corrupt-{stamp}"
                    backup.write_text(last_text, encoding="utf-8")
                except OSError:
                    pass
                payload = {}

            if isinstance(payload, dict):
                existing = payload
                merged.update(existing)
        merged.update(config)
        for key in ("github_token",):
            incoming = (config.get(key) or "").strip()
            if incoming:
                continue
            preserved = (existing.get(key) or "").strip()
            if preserved:
                merged[key] = preserved

        merged.pop("github_token_hint", None)
        tmp_path = path.parent / f"{path.name}.tmp-{os.getpid()}"
        with tmp_path.open("w", encoding="utf-8") as handle:
            json.dump(merged, handle, indent=2, ensure_ascii=True)
        os.replace(tmp_path, path)
    except OSError:
        # If the install folder is moved/locked while running, avoid crashing the app.
        return


def to_display_time(dt: datetime | None) -> str:
    if not dt:
        return "Not yet"
    return dt.strftime("%d-%m-%Y %H:%M")


def normalize_path_key(value: str | Path) -> str:
    raw = str(value).strip()
    if not raw:
        return ""
    try:
        raw = str(Path(raw).expanduser())
    except Exception:  # noqa: BLE001
        pass
    return os.path.normcase(os.path.normpath(raw))


def get_output_dir_last_sync_at(config: dict, output_dir: str | Path | None) -> str:
    if not output_dir:
        return ""
    raw = str(output_dir).strip()
    if not raw:
        return ""
    mapping = config.get("output_dir_last_sync_at")
    if not isinstance(mapping, dict):
        return ""
    key = normalize_path_key(raw)
    if not key:
        return ""
    value = (mapping.get(key) or "").strip()
    return value


def set_output_dir_last_sync_at(
    config: dict, output_dir: str | Path | None, value: str
) -> None:
    raw = str(output_dir).strip() if output_dir else ""
    stamp = (value or "").strip()
    if not raw or not stamp:
        return
    mapping = config.get("output_dir_last_sync_at")
    if not isinstance(mapping, dict):
        mapping = {}
        config["output_dir_last_sync_at"] = mapping
    key = normalize_path_key(raw)
    if not key:
        return
    mapping[key] = stamp


def get_selected_output_dir_last_sync_at(config: dict) -> str:
    output_dir = (config.get("output_dir") or "").strip()
    if not output_dir:
        return ""
    return get_output_dir_last_sync_at(config, output_dir)


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
