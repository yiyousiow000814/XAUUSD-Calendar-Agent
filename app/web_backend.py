import json
import os
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ProcessPoolExecutor, TimeoutError
from datetime import datetime, timedelta, timezone
from hashlib import sha1
from pathlib import Path
from typing import Iterable

import webview
from agent.calendar_loader import load_calendar_events
from agent.calendar_update import update_calendar_from_github
from agent.config import (
    get_config_path,
    get_default_repo_path,
    get_github_token,
    get_legacy_config_path,
    get_log_dir,
    get_repo_dir,
    get_update_dir,
    load_config,
    parse_iso_time,
    save_config,
    to_display_time,
    to_iso_time,
)
from agent.git_ops import (
    clone_repo_with_progress_into_dir,
    fetch_origin,
    get_head_branch,
    get_head_sha,
    get_origin_repo_slug,
    get_origin_sha,
    get_status_porcelain,
    is_git_repo_usable,
    normalize_repo_slug,
    pull_origin_main,
    terminate_git_clone_processes_by_repo_url,
    terminate_process_tree,
)
from agent.logger import setup_logger
from agent.scheduler import create_startup_task, remove_startup_task
from agent.sync import mirror_sync
from agent.timezone import (
    CALENDAR_SOURCE_UTC_OFFSET_MINUTES,
    clamp_utc_offset_minutes,
    get_system_utc_offset_minutes,
    utc_offset_minutes_to_tzinfo,
)
from agent.updater import (
    check_github_repo_access,
    download_update,
    fetch_github_branch_head_sha,
    fetch_github_release,
)
from agent.version import APP_VERSION

try:
    import winreg
except Exception:  # noqa: BLE001
    winreg = None

APP_TITLE = "XAUUSD Calendar Agent"
AUTO_UPDATE_INTERVAL_MINUTES = 60
OUTPUT_DIR_MARKER_FILENAME = ".xauusd_calendar_agent_managed_output"
SYNC_REPO_GIT_PID_PREFIX = "sync-repo-clone"


class WebAgentBackend:
    def __init__(self) -> None:
        init_started = time.perf_counter()
        self.state = load_config()
        if not self.state.get("settings_auto_save", True):
            self.state["settings_auto_save"] = True
            save_config(self.state)
        self.logger = setup_logger(self.state.get("debug", False))
        self.logger.info("Backend init started")
        self.log_entries: list[dict] = []
        self.calendar_events: list[dict] = []
        self.currency = "USD"
        self.window: webview.Window | None = None
        self._lock = threading.Lock()
        self._shutdown_event = threading.Event()
        self._calendar_last_loaded: datetime | None = None
        self._calendar_status = "loading"
        self._calendar_refresh_lock = threading.Lock()
        self._calendar_refresh_in_progress = False
        self._calendar_proc_lock = threading.Lock()
        self._calendar_executor: ProcessPoolExecutor | None = None
        self._render_cache_lock = threading.Lock()
        self._render_cache_loaded_at: datetime | None = None
        self._render_cache_currency: str = ""
        self._render_cache_tz_offset_minutes: int | None = None
        self._render_cache_currency_options: list[str] = []
        self._render_cache_events: list[dict] = []
        self._render_cache_past_events: list[dict] = []
        self._snapshot_lock = threading.Lock()
        self._snapshot_cache: dict = {
            "lastPull": "Not yet",
            "lastSync": "Not yet",
            "lastPullAt": self.state.get("last_pull_at", ""),
            "lastSyncAt": self.state.get("last_sync_at", ""),
            "outputDir": self.state.get("output_dir", ""),
            "repoPath": "",
            "currency": self.currency,
            "currencyOptions": [],
            "events": [],
            "pastEvents": [],
            "logs": [],
            "version": APP_VERSION,
            "modal": None,
            "pullActive": False,
            "syncActive": False,
        }
        self._snapshot_rebuild_lock = threading.Lock()
        self._snapshot_rebuild_in_progress = False
        self._snapshot_rebuild_pending = False
        self._restart_deadline: datetime | None = None
        self._update_lock = threading.Lock()
        self._update_phase = "idle"
        self._update_message = ""
        self._update_available_version = ""
        self._update_download_url = ""
        self._update_download_target: str | None = None
        self._update_downloaded_bytes = 0
        self._update_total_bytes: int | None = None
        self._update_in_progress = False
        self._sync_repo_task_lock = threading.Lock()
        self._sync_repo_task_active = False
        self._sync_repo_task_phase = "idle"
        self._sync_repo_task_progress = 0.0
        self._sync_repo_task_message = ""
        self._sync_repo_task_path = ""
        self._sync_repo_last_notice_ts: float | None = None
        self._sync_repo_task_cancel_event: threading.Event | None = None
        self._sync_repo_git_pid: int | None = None
        self._task_lock = threading.Lock()
        self._manual_pull_active = False
        self._manual_sync_active = False
        self._background_started_lock = threading.Lock()
        self._background_started = False
        self._background_start_timer: threading.Timer | None = None
        self._config_watch_timer: threading.Timer | None = None
        self._last_seen_github_token = ""
        self._github_token_action_in_progress = False
        self._ui_modal: dict | None = None
        self._ui_modal_id_counter = 0
        self._snapshot_cache["calendarStatus"] = self._calendar_status
        self._request_snapshot_rebuild("startup")
        self._request_calendar_refresh("startup")
        self.logger.info(
            "Backend init complete in %.0fms",
            (time.perf_counter() - init_started) * 1000,
        )

    def _start_background_tasks_once(self, reason: str = "") -> None:
        with self._background_started_lock:
            if self._background_started:
                return
            self._background_started = True
        self._append_notice("Boot complete", level="INFO")
        if self._calendar_status != "loaded":
            self._request_calendar_refresh(f"startup:{reason}".strip(":"))
        self._run_task(self._maybe_pull_and_sync, "Startup check")
        self._run_task(lambda: self._update_check(manual=False), "Startup update check")
        self._start_auto_update_loop()
        self._start_config_watch()

    def frontend_boot_complete(self) -> dict:
        self.logger.info("Frontend boot complete")
        with self._background_started_lock:
            if self._background_started:
                return {"ok": True}
            if self._background_start_timer:
                self._background_start_timer.cancel()
                self._background_start_timer = None
        self._start_background_tasks_once("frontend-ready")
        return {"ok": True}

    def set_window(self, window: webview.Window) -> None:
        self.window = window
        with self._background_started_lock:
            if self._background_started or self._background_start_timer:
                return

            def start_later() -> None:
                self._start_background_tasks_once("timer")

            self._background_start_timer = threading.Timer(8.0, start_later)
            self._background_start_timer.daemon = True
            self._background_start_timer.start()

    def _start_config_watch(self) -> None:
        if self._config_watch_timer:
            return
        self._last_seen_github_token = get_github_token(None)
        interval_seconds = 0.35

        def tick() -> None:
            if self._shutdown_event.is_set():
                return
            try:
                current = get_github_token(None)
                if current != self._last_seen_github_token:
                    self._last_seen_github_token = current
                    if not current:
                        self.state["github_token"] = ""
                    else:
                        self._on_github_token_changed(current)
            except Exception:  # noqa: BLE001
                pass
            self._config_watch_timer = threading.Timer(interval_seconds, tick)
            self._config_watch_timer.daemon = True
            self._config_watch_timer.start()

        self._config_watch_timer = threading.Timer(interval_seconds, tick)
        self._config_watch_timer.daemon = True
        self._config_watch_timer.start()

    def _emit_modal_event(self, modal: dict) -> None:
        window = getattr(self, "window", None)
        if not window:
            return
        try:
            payload = json.dumps(modal, ensure_ascii=False)
            window.evaluate_js(
                'window.dispatchEvent(new CustomEvent("xauusd:modal", { detail: '
                + payload
                + " }));"
            )
        except Exception:  # noqa: BLE001
            return

    def _set_ui_modal(self, title: str, message: str, tone: str = "info") -> None:
        self._ui_modal_id_counter += 1
        self._ui_modal = {
            "id": f"modal-{self._ui_modal_id_counter}",
            "title": title,
            "message": message,
            "tone": tone,
        }
        self._request_snapshot_rebuild("ui-modal")
        self._emit_modal_event(dict(self._ui_modal))

    def dismiss_modal(self, payload: dict | None = None) -> dict:
        payload = payload or {}
        modal_id = (payload.get("id") or "").strip()
        if not modal_id:
            return {"ok": False, "message": "Missing id"}
        if self._ui_modal and self._ui_modal.get("id") == modal_id:
            self._ui_modal = None
            self._request_snapshot_rebuild("ui-modal-dismiss")
        return {"ok": True}

    def _on_github_token_changed(self, token: str) -> None:
        if self._github_token_action_in_progress:
            return
        repo = (self.state.get("github_repo") or "").strip()
        if not repo:
            return

        def runner() -> None:
            self._github_token_action_in_progress = True
            try:
                self._set_ui_modal(
                    "GitHub Token",
                    "Verifying token...",
                    tone="info",
                )
                ok, message = check_github_repo_access(repo, token=token)
                if not ok:
                    self._append_notice(
                        f"GitHub token detected but invalid: {message}", level="ERROR"
                    )
                    self._set_ui_modal(
                        "GitHub Token",
                        "Token Invalid.\n\nPlease check github_token in config.json",
                        tone="error",
                    )
                    return
                self.state["github_token"] = token
                save_config(self.state)
                self._append_notice("GitHub token detected and verified", level="INFO")
                self._set_ui_modal(
                    "GitHub Token",
                    "Token verified.\n\nUpdating data...",
                    tone="info",
                )
                self._pull_calendar_only(force=True, reason="token-change")
                self._check_updates_task(quiet=False)
            finally:
                self._github_token_action_in_progress = False

        self._run_task(runner, "GitHub token detected")

    @staticmethod
    def _clamp_split_ratio(value: float) -> float:
        if not isinstance(value, (int, float)):
            return 0.66
        if not (value == value):  # NaN
            return 0.66
        return max(0.55, min(0.75, float(value)))

    def _mark_update_checked(self) -> None:
        self.state["last_update_check_at"] = to_iso_time(datetime.now())
        save_config(self.state)

    @staticmethod
    def _parse_version(value: str) -> tuple:
        parts = value.split(".")
        numbers = []
        for part in parts:
            try:
                numbers.append(int(part))
            except ValueError:
                numbers.append(0)
        return tuple(numbers)

    # set_window moved earlier to defer heavy background startup.

    def _get_rendered_snapshot_payload(
        self,
    ) -> tuple[list[str], list[dict], list[dict]]:
        loaded_at = self._calendar_last_loaded
        currency = (self.currency or "USD").upper()
        tz_offset_minutes = self._effective_calendar_utc_offset_minutes()
        with self._render_cache_lock:
            if (
                loaded_at
                and self._render_cache_loaded_at == loaded_at
                and self._render_cache_currency == currency
                and self._render_cache_tz_offset_minutes == tz_offset_minutes
            ):
                return (
                    list(self._render_cache_currency_options),
                    list(self._render_cache_events),
                    list(self._render_cache_past_events),
                )
        currency_options = self._currency_options(self.calendar_events)
        events = self._render_next_events(self.calendar_events, currency)
        past_events = self._render_past_events(self.calendar_events, currency)
        with self._render_cache_lock:
            self._render_cache_loaded_at = loaded_at
            self._render_cache_currency = currency
            self._render_cache_tz_offset_minutes = tz_offset_minutes
            self._render_cache_currency_options = list(currency_options)
            self._render_cache_events = list(events)
            self._render_cache_past_events = list(past_events)
        return list(currency_options), list(events), list(past_events)

    def _request_snapshot_rebuild(self, reason: str = "") -> None:
        if self._shutdown_event.is_set():
            return
        with self._snapshot_rebuild_lock:
            self._snapshot_rebuild_pending = True
            if self._snapshot_rebuild_in_progress:
                return
            self._snapshot_rebuild_in_progress = True

        def runner() -> None:
            try:
                while True:
                    with self._snapshot_rebuild_lock:
                        if not self._snapshot_rebuild_pending:
                            self._snapshot_rebuild_in_progress = False
                            return
                        self._snapshot_rebuild_pending = False
                    self._rebuild_snapshot_cache(reason=reason)
            finally:
                with self._snapshot_rebuild_lock:
                    self._snapshot_rebuild_in_progress = False

        threading.Thread(target=runner, daemon=True).start()

    def _rebuild_snapshot_cache(self, reason: str = "") -> None:
        last_pull = parse_iso_time(self.state.get("last_pull_at", ""))
        last_sync = parse_iso_time(self.state.get("last_sync_at", ""))
        repo_path = self._get_main_repo_path()
        currency_options, events, past_events = self._get_rendered_snapshot_payload()
        with self._lock:
            logs = list(self.log_entries)
        with self._task_lock:
            pull_active = self._manual_pull_active
            sync_active = self._manual_sync_active
        payload = {
            "lastPull": to_display_time(last_pull),
            "lastSync": to_display_time(last_sync),
            "lastPullAt": self.state.get("last_pull_at", ""),
            "lastSyncAt": self.state.get("last_sync_at", ""),
            "outputDir": self.state.get("output_dir", ""),
            "repoPath": str(repo_path) if repo_path else "",
            "currency": self.currency,
            "currencyOptions": currency_options,
            "events": events,
            "pastEvents": past_events,
            "logs": logs,
            "version": APP_VERSION,
            "modal": dict(self._ui_modal) if self._ui_modal else None,
            "calendarStatus": self._calendar_status,
            "pullActive": pull_active,
            "syncActive": sync_active,
        }
        with self._snapshot_lock:
            self._snapshot_cache.update(payload)

    def get_snapshot(self) -> dict:
        self._refresh_calendar_if_stale()
        self._request_snapshot_rebuild("get_snapshot")
        restart_in = 0
        if self._restart_deadline:
            restart_in = max(
                0,
                int((self._restart_deadline - datetime.now()).total_seconds() + 0.999),
            )
        with self._snapshot_lock:
            base = dict(self._snapshot_cache)
        base["restartInSeconds"] = restart_in
        return base

    def get_settings(self) -> dict:
        log_file = get_log_dir() / "app.log"
        repo_path = self._get_main_repo_path()
        theme_pref = self.state.get("theme_preference", "dark")
        enable_system_theme = bool(self.state.get("enable_system_theme", False))
        if not enable_system_theme and theme_pref == "system":
            theme_pref = "dark"
        split_ratio = self._clamp_split_ratio(
            float(self.state.get("split_ratio", 0.66))
        )
        tz_mode = (self.state.get("calendar_timezone_mode") or "utc").strip().lower()
        if tz_mode not in ("utc", "system"):
            tz_mode = "utc"
        manual_offset = clamp_utc_offset_minutes(
            int(self.state.get("calendar_utc_offset_minutes", 0))
        )
        return {
            "autoSyncAfterPull": bool(self.state.get("auto_sync_after_pull", True)),
            "autoUpdateEnabled": bool(self.state.get("auto_update_enabled", True)),
            "runOnStartup": bool(self.state.get("run_on_startup", True)),
            "debug": bool(self.state.get("debug", False)),
            "autoSave": True,
            "enableSystemTheme": enable_system_theme,
            "theme": theme_pref,
            "enableSyncRepo": bool(self.state.get("enable_sync_repo", False)),
            "syncRepoPath": self.state.get("sync_repo_path", ""),
            "repoPath": str(repo_path) if repo_path else "",
            "logPath": str(log_file),
            "splitRatio": split_ratio,
            "removeLogs": True,
            "removeOutput": False,
            "removeSyncRepos": True,
            "uninstallConfirm": "",
            "calendarTimezoneMode": tz_mode,
            "calendarUtcOffsetMinutes": manual_offset,
        }

    def get_sync_repo_task(self) -> dict:
        with self._sync_repo_task_lock:
            return {
                "ok": True,
                "active": self._sync_repo_task_active,
                "phase": self._sync_repo_task_phase,
                "progress": float(self._sync_repo_task_progress),
                "message": self._sync_repo_task_message,
                "path": self._sync_repo_task_path,
            }

    def probe_sync_repo(self, payload: dict | None = None) -> dict:
        payload = payload or {}
        enable_sync_repo = bool(
            payload.get("enableSyncRepo", self.state.get("enable_sync_repo", False))
        )
        raw_path = (
            payload.get("syncRepoPath") or self.state.get("sync_repo_path") or ""
        ).strip()
        auto_start = bool(payload.get("autoStart", True))
        repo_slug = normalize_repo_slug((self.state.get("github_repo") or "").strip())
        if enable_sync_repo and not raw_path:
            raw_path = str(get_repo_dir())
        path = Path(raw_path) if raw_path else None
        probe = self._probe_sync_repo(path, repo_slug, auto_start=auto_start)
        return {"ok": True, **probe}

    def sync_repo_use_as_is(self, payload: dict | None = None) -> dict:
        payload = payload or {}
        raw_path = (
            payload.get("syncRepoPath") or self.state.get("sync_repo_path") or ""
        ).strip()
        repo_slug = normalize_repo_slug((self.state.get("github_repo") or "").strip())
        if not raw_path:
            return {"ok": False, "message": "Sync repo path is empty"}
        path = Path(raw_path)
        probe = self._probe_sync_repo(path, repo_slug, auto_start=False)
        if not probe.get("canUseAsIs"):
            return {
                "ok": False,
                "message": probe.get("message") or "Sync repo not usable",
            }
        self._set_sync_repo_confirmation(path, repo_slug, mode="use-as-is")
        self._append_notice("Sync repo confirmed (use as-is)", level="INFO")
        return {"ok": True}

    def sync_repo_reset(self, payload: dict | None = None) -> dict:
        payload = payload or {}
        raw_path = (
            payload.get("syncRepoPath") or self.state.get("sync_repo_path") or ""
        ).strip()
        repo_slug = normalize_repo_slug((self.state.get("github_repo") or "").strip())
        if not raw_path:
            return {"ok": False, "message": "Sync repo path is empty"}
        if not repo_slug:
            return {"ok": False, "message": "GitHub repo not configured"}
        path = Path(raw_path)
        self._terminate_sync_repo_pid_file(path, reason="Reset & Clone")
        with self._sync_repo_task_lock:
            task_active = self._sync_repo_task_active
        if task_active:
            canceled = self._cancel_sync_repo_task("Reset & Clone requested")
            if canceled:
                deadline = time.time() + 3.0
                while time.time() < deadline:
                    with self._sync_repo_task_lock:
                        active = self._sync_repo_task_active
                    if not active:
                        break
                    time.sleep(0.05)
                with self._sync_repo_task_lock:
                    if self._sync_repo_task_active:
                        return {
                            "ok": False,
                            "message": "Unable to stop existing sync repo operation; please retry",
                        }
        probe = self._probe_sync_repo(path, repo_slug, auto_start=False)
        if not probe.get("canReset"):
            return {"ok": False, "message": probe.get("message") or "Reset not allowed"}
        started = self._start_sync_repo_clone(path, repo_slug, reset_first=True)
        if not started:
            return {"ok": False, "message": "Sync repo operation already running"}
        return {"ok": True}

    def _terminate_sync_repo_pid_file(self, path: Path, reason: str) -> None:
        pid_path = self._sync_repo_pid_file(path)
        try:
            if not pid_path.exists():
                return
        except OSError:
            return
        try:
            content = pid_path.read_text(encoding="utf-8").strip()
        except OSError:
            content = ""
        pid: int | None = None
        if content:
            try:
                pid = int(content.splitlines()[0].strip())
            except Exception:  # noqa: BLE001
                pid = None
        if pid:
            try:
                terminate_process_tree(pid)
            except Exception:  # noqa: BLE001
                pass
        try:
            pid_path.unlink(missing_ok=True)
        except OSError:
            pass
        if pid:
            self._append_notice(
                f"Stopped previous git clone process (pid file): {pid} ({reason})",
                level="WARN",
            )

    def _sync_repo_pid_file(self, path: Path) -> Path:
        resolved = str(self._safe_resolve(path))
        digest = sha1(resolved.encode("utf-8", errors="ignore")).hexdigest()[:16]
        return get_log_dir() / f"{SYNC_REPO_GIT_PID_PREFIX}-{digest}.pid"

    def _cancel_sync_repo_task(self, reason: str) -> bool:
        with self._sync_repo_task_lock:
            if not self._sync_repo_task_active:
                return False
            cancel_event = self._sync_repo_task_cancel_event
            pid = self._sync_repo_git_pid
            task_path = self._sync_repo_task_path
            if cancel_event:
                cancel_event.set()
        if task_path:
            try:
                self._terminate_sync_repo_pid_file(
                    Path(task_path), reason=f"Cancel ({reason})"
                )
            except Exception:  # noqa: BLE001
                pass
        if pid:
            try:
                terminate_process_tree(pid)
            except Exception:  # noqa: BLE001
                pass
        self._append_notice(f"Sync repo operation canceled: {reason}", level="WARN")
        return True

    def save_settings(self, payload: dict) -> dict:
        previous_debug = bool(self.state.get("debug", False))
        auto_sync = bool(payload.get("autoSyncAfterPull", True))
        auto_update = bool(payload.get("autoUpdateEnabled", True))
        run_on_startup = bool(payload.get("runOnStartup", True))
        debug = bool(payload.get("debug", False))
        auto_save = True
        enable_sync_repo = bool(payload.get("enableSyncRepo", False))
        split_ratio_raw = payload.get("splitRatio", self.state.get("split_ratio", 0.66))
        split_ratio = self._clamp_split_ratio(float(split_ratio_raw))
        theme = (payload.get("theme") or "system").lower()
        if theme not in ("system", "dark", "light"):
            theme = "system"
        enable_system_theme = bool(payload.get("enableSystemTheme", theme == "system"))
        if not enable_system_theme and theme == "system":
            theme = "dark"

        tz_mode = (payload.get("calendarTimezoneMode") or "").strip().lower()
        if not tz_mode:
            tz_mode = (
                (self.state.get("calendar_timezone_mode") or "utc").strip().lower()
            )
        if tz_mode not in ("utc", "system"):
            tz_mode = "utc"
        tz_offset_raw = payload.get(
            "calendarUtcOffsetMinutes", self.state.get("calendar_utc_offset_minutes", 0)
        )
        try:
            tz_offset = clamp_utc_offset_minutes(int(tz_offset_raw))
        except (TypeError, ValueError):
            tz_offset = 0

        self.state["auto_sync_after_pull"] = auto_sync
        self.state["auto_update_enabled"] = auto_update
        self.state["run_on_startup"] = run_on_startup
        self.state["debug"] = debug
        self.state["settings_auto_save"] = auto_save
        self.state["theme_preference"] = theme
        self.state["enable_system_theme"] = enable_system_theme
        self.state["enable_sync_repo"] = enable_sync_repo
        self.state["split_ratio"] = split_ratio
        self.state["calendar_timezone_mode"] = tz_mode
        self.state["calendar_utc_offset_minutes"] = tz_offset
        save_config(self.state)
        self.logger = setup_logger(debug)
        self._apply_startup_setting(run_on_startup)
        if debug and not previous_debug:
            self._append_notice("Debug logging enabled", level="INFO")
        return {"ok": True}

    def _effective_calendar_utc_offset_minutes(self) -> int:
        mode = (self.state.get("calendar_timezone_mode") or "utc").strip().lower()
        if mode == "system":
            return clamp_utc_offset_minutes(get_system_utc_offset_minutes())
        return clamp_utc_offset_minutes(
            int(self.state.get("calendar_utc_offset_minutes", 0))
        )

    def open_log(self) -> dict:
        log_file = get_log_dir() / "app.log"
        target = log_file if log_file.exists() else get_log_dir()
        try:
            os.startfile(target)  # type: ignore[attr-defined]
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "message": str(exc)}
        return {"ok": True}

    def open_path(self, path: str) -> dict:
        value = (path or "").strip()
        if not value:
            return {"ok": False, "message": "Path is empty"}
        try:
            os.startfile(value)  # type: ignore[attr-defined]
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "message": str(exc)}
        return {"ok": True}

    def add_log(self, payload: dict) -> dict:
        message = (payload.get("message") or "").strip()
        level = (payload.get("level") or "INFO").strip().upper()
        if not message:
            return {"ok": False, "message": "Message empty"}
        if level not in ("INFO", "WARN", "ERROR"):
            level = "INFO"
        self._append_notice(message, level=level)
        self._request_snapshot_rebuild("add_log")
        return {"ok": True}

    def browse_sync_repo(self) -> dict:
        if not self.window:
            return {"ok": False, "message": "Window not ready"}
        start_dir = (self.state.get("sync_repo_path") or "").strip()
        directory = ""
        if start_dir:
            path = Path(start_dir)
            if path.exists() and path.is_dir():
                directory = str(path)
            elif path.parent.exists():
                directory = str(path.parent)
        result = self.window.create_file_dialog(
            webview.FOLDER_DIALOG, directory=directory
        )
        if not result:
            return {"ok": False}
        path = result[0]
        return self.set_sync_repo_path(path)

    def set_sync_repo_path(self, path: str) -> dict:
        value = (path or "").strip()
        self.state["sync_repo_path"] = value
        if value:
            self._ensure_dir(value)
            self._track_path("sync_repo_path_history", value)
        save_config(self.state)
        return {"ok": True, "path": value}

    def uninstall(self, payload: dict) -> dict:
        confirm = (payload.get("confirm") or "").strip()
        if confirm != "UNINSTALL":
            return {"ok": False, "message": "Confirmation required"}
        remove_logs = bool(payload.get("removeLogs", True))
        remove_output = bool(payload.get("removeOutput", False))
        remove_sync_repos = bool(payload.get("removeSyncRepos", True))

        for path in (get_config_path(), get_legacy_config_path(), get_update_dir()):
            try:
                if path.is_file():
                    path.unlink()
                elif path.is_dir():
                    shutil.rmtree(path, ignore_errors=True)
            except OSError:
                continue
        if remove_logs:
            try:
                shutil.rmtree(get_log_dir(), ignore_errors=True)
            except OSError:
                pass

        try:
            remove_startup_task()
        except Exception:  # noqa: BLE001
            pass

        for path_str in self.state.get("created_paths", []):
            path = Path(path_str)
            if not path.exists() or not path.is_dir():
                continue
            try:
                if not any(path.iterdir()):
                    path.rmdir()
            except OSError:
                continue

        uninstall_cmd = self._find_uninstaller()
        if not uninstall_cmd:
            self._append_notice(
                "Uninstaller not found. Cleanup completed.", level="WARN"
            )
            return {
                "ok": False,
                "message": (
                    "Uninstaller not found. This copy may not be installed via Setup.exe. "
                    "App data cleanup completed; delete the EXE manually if needed."
                ),
            }

        if os.name != "nt":
            return {"ok": False, "message": "Uninstall is supported on Windows only"}

        if remove_output:
            output_dir = (self.state.get("output_dir") or "").strip()
            if output_dir:
                path = Path(output_dir)
                marker = path / OUTPUT_DIR_MARKER_FILENAME
                if (
                    path.exists()
                    and path.is_dir()
                    and marker.is_file()
                    and not self._is_path_root_dir(path)
                ):
                    shutil.rmtree(path, ignore_errors=True)
                else:
                    self._append_notice(
                        f"Skipped deleting output dir (not managed): {output_dir}",
                        level="WARN",
                    )

        if remove_sync_repos:
            self._cleanup_managed_sync_repos(
                [
                    self.state.get("sync_repo_path", ""),
                    *self.state.get("successful_repo_paths", []),
                ]
            )

        exe_dir = (
            Path(sys.executable).resolve().parent
            if getattr(sys, "frozen", False)
            else None
        )
        install_dir = ""
        if exe_dir and self._is_installed_dir(exe_dir):
            install_dir = str(exe_dir)
        appdata_root = os.environ.get("APPDATA") or ""
        roaming_data_dir = (
            os.path.join(appdata_root, "XAUUSDCalendar") if appdata_root else ""
        )

        script_path = get_update_dir() / f"uninstall_{os.getpid()}.cmd"
        script_path.parent.mkdir(parents=True, exist_ok=True)
        script = (
            "@echo off\r\n"
            f"set PID={os.getpid()}\r\n"
            f"set UNINS={uninstall_cmd}\r\n"
            f"set INSTALL_DIR={install_dir}\r\n"
            f"set ROAMING_DIR={roaming_data_dir}\r\n"
            "taskkill /F /PID %PID% >nul 2>&1\r\n"
            ":wait\r\n"
            'tasklist /FI "PID eq %PID%" | findstr /I "%PID%" >nul\r\n'
            "if not errorlevel 1 (\r\n"
            "  timeout /t 1 /nobreak >nul\r\n"
            "  goto wait\r\n"
            ")\r\n"
            "%UNINS% /VERYSILENT /SUPPRESSMSGBOXES /NORESTART\r\n"
            'if not "%ROAMING_DIR%"=="" rmdir /s /q "%ROAMING_DIR%" >nul 2>&1\r\n'
            'if not "%INSTALL_DIR%"=="" rmdir /s /q "%INSTALL_DIR%" >nul 2>&1\r\n'
            'del "%~f0" >nul 2>&1\r\n'
        )
        script_path.write_text(script, encoding="utf-8")

        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        try:
            subprocess.Popen(
                ["cmd", "/c", "start", "", "/min", str(script_path)],
                creationflags=creationflags,
            )
        except Exception as exc:  # noqa: BLE001
            self.logger.exception("Failed to launch uninstall script")
            return {"ok": False, "message": f"Failed to launch uninstaller: {exc}"}

        self._append_notice("Uninstall started", level="INFO")
        threading.Timer(0.2, self._request_exit).start()
        return {"ok": True}

    @staticmethod
    def _is_installed_dir(path: Path) -> bool:
        local = os.environ.get("LOCALAPPDATA") or ""
        if not local:
            return False
        expected = (Path(local) / "XAUUSDCalendarAgent").resolve()
        try:
            return path.resolve() == expected
        except OSError:
            return False

    @staticmethod
    def _is_within(child: Path, parent: Path) -> bool:
        try:
            child_resolved = child.resolve()
            parent_resolved = parent.resolve()
        except OSError:
            return False
        return (
            parent_resolved == child_resolved
            or parent_resolved in child_resolved.parents
        )

    def _cleanup_managed_sync_repos(self, paths: Iterable[str]) -> None:
        managed_root = get_repo_dir()
        for path_str in paths:
            value = (path_str or "").strip()
            if not value:
                continue
            candidate = Path(value)
            if not candidate.exists() or not candidate.is_dir():
                continue
            if not self._is_within(candidate, managed_root):
                self._append_notice(
                    f"Skip deleting non-managed repo path: {candidate}", level="WARN"
                )
                continue
            shutil.rmtree(candidate, ignore_errors=True)

    def _request_exit(self) -> None:
        try:
            self.shutdown()
        except Exception:  # noqa: BLE001
            pass
        if not self.window:
            return
        try:
            self.window.destroy()
        except Exception:  # noqa: BLE001
            pass

    def _find_uninstaller(self) -> str | None:
        if not sys.platform.startswith("win"):
            return None
        if getattr(sys, "frozen", False):
            exe_dir = Path(sys.executable).resolve().parent
            for candidate in exe_dir.glob("unins*.exe"):
                return f'"{candidate}"'
        if not winreg:
            return None
        uninstall_paths = [r"Software\Microsoft\Windows\CurrentVersion\Uninstall"]
        for root in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            for path in uninstall_paths:
                try:
                    with winreg.OpenKey(root, path) as key:
                        count, _, _ = winreg.QueryInfoKey(key)
                        for idx in range(count):
                            try:
                                subkey_name = winreg.EnumKey(key, idx)
                                with winreg.OpenKey(key, subkey_name) as subkey:
                                    name, _ = winreg.QueryValueEx(subkey, "DisplayName")
                                    if name != APP_TITLE:
                                        continue
                                    uninstall, _ = winreg.QueryValueEx(
                                        subkey, "UninstallString"
                                    )
                                    return str(uninstall)
                            except OSError:
                                continue
                except OSError:
                    continue
        return None

    def set_currency(self, value: str) -> dict:
        next_value = (value or "USD").upper()
        if next_value == self.currency:
            return {"ok": True}
        self.currency = next_value
        self._refresh_calendar_if_stale()
        self._request_snapshot_rebuild("currency")
        return {"ok": True}

    def browse_output_dir(self) -> dict:
        if not self.window:
            return {"ok": False, "message": "Window not ready"}
        start_dir = (self.state.get("output_dir") or "").strip()
        directory = ""
        if start_dir:
            path = Path(start_dir)
            if path.exists() and path.is_dir():
                directory = str(path)
            elif path.parent.exists():
                directory = str(path.parent)
        result = self.window.create_file_dialog(
            webview.FOLDER_DIALOG, directory=directory
        )
        if not result:
            return {"ok": False}
        path = result[0]
        self.state["output_dir"] = path
        save_config(self.state)
        return {"ok": True, "path": path}

    def set_output_dir(self, path: str) -> dict:
        value = (path or "").strip()
        output_dir_created = False
        if value:
            try:
                output_dir_created = not Path(value).exists()
            except OSError:
                output_dir_created = False
        self.state["output_dir"] = value
        if value:
            self._ensure_dir(value)
            if output_dir_created:
                self._write_output_dir_marker(Path(value))
            self._track_path("output_dir_history", value)
        save_config(self.state)
        return {"ok": True}

    def pull_now(self) -> dict:
        def task() -> None:
            with self._task_lock:
                self._manual_pull_active = True
            self._request_snapshot_rebuild("pull-active")
            try:
                self._pull_and_sync()
            finally:
                with self._task_lock:
                    self._manual_pull_active = False
                self._request_snapshot_rebuild("pull-inactive")

        self._run_task(task, "Manual pull")
        return {"ok": True}

    def sync_now(self) -> dict:
        def task() -> None:
            with self._task_lock:
                self._manual_sync_active = True
            self._request_snapshot_rebuild("sync-active")
            try:
                self._sync_only()
            finally:
                with self._task_lock:
                    self._manual_sync_active = False
                self._request_snapshot_rebuild("sync-inactive")

        self._run_task(task, "Manual sync")
        return {"ok": True}

    def clear_logs(self) -> dict:
        with self._lock:
            self.log_entries = []
        return {"ok": True}

    def get_update_state(self) -> dict:
        last_checked = to_display_time(
            parse_iso_time(self.state.get("last_update_check_at", ""))
        )
        with self._update_lock:
            progress = 0.0
            if self._update_total_bytes and self._update_total_bytes > 0:
                progress = max(
                    0.0,
                    min(1.0, self._update_downloaded_bytes / self._update_total_bytes),
                )
            elif self._update_phase in ("downloaded", "restarting"):
                progress = 1.0
            return {
                "ok": True,
                "phase": self._update_phase,
                "message": self._update_message,
                "availableVersion": self._update_available_version,
                "progress": progress,
                "downloadedBytes": self._update_downloaded_bytes,
                "totalBytes": self._update_total_bytes,
                "lastCheckedAt": last_checked,
            }

    def check_updates(self) -> dict:
        if self._shutdown_event.is_set():
            return {"ok": False, "message": "Shutting down"}
        self._mark_update_checked()
        with self._update_lock:
            self._update_phase = "checking"
            self._update_message = "Checking..."
            self._update_available_version = ""
            self._update_download_url = ""
            self._update_download_target = None
            self._update_downloaded_bytes = 0
            self._update_total_bytes = None
            self._update_in_progress = False
        self._run_task(
            lambda: self._check_updates_task(quiet=False), "Manual update check"
        )
        return {"ok": True}

    def update_now(self) -> dict:
        if self._shutdown_event.is_set():
            return {"ok": False, "message": "Shutting down"}
        with self._update_lock:
            if self._update_in_progress:
                return {"ok": False, "message": "Update already in progress"}
            has_pending = bool(self._update_download_url)
            is_downloaded = self._update_phase == "downloaded" and bool(
                self._update_download_target
            )

        if is_downloaded:
            self._run_task(self._install_update_task, "Install now")
            return {"ok": True}

        if not has_pending:
            result = self._check_updates_task(quiet=True)
            if not result.get("updateAvailable"):
                return {
                    "ok": False,
                    "message": result.get("message") or "No update available",
                }

        self._run_task(self._download_update_task, "Update now")
        return {"ok": True}

    def _append_notice(self, message: str, level: str = "INFO") -> None:
        timestamp = datetime.now().strftime("%d-%m-%Y %H:%M")
        entry = {"time": timestamp, "message": message, "level": level.upper()}
        with self._lock:
            self.log_entries.insert(0, entry)
            if len(self.log_entries) > 200:
                self.log_entries = self.log_entries[:200]
        self._request_snapshot_rebuild("append_notice")

    @staticmethod
    def _calendar_refreshed_message(files: int, reason: str = "") -> str:
        return "Events updated to latest"

    def _run_task(self, func, label: str) -> None:
        def wrapper() -> None:
            if self._shutdown_event.is_set():
                return
            try:
                func()
            except Exception as exc:  # noqa: BLE001
                self.logger.exception("Task failed: %s", label)
                self._append_notice(f"{label} failed: {exc}", level="ERROR")

        thread = threading.Thread(target=wrapper, daemon=True)
        thread.start()

    def _check_updates_task(self, quiet: bool) -> dict:
        self._mark_update_checked()
        repo = self.state.get("github_repo", "")
        if not repo:
            with self._update_lock:
                self._update_phase = "idle"
                self._update_message = "Update channel not configured"
            return {
                "ok": False,
                "message": "Update channel not configured",
                "updateAvailable": False,
            }

        info = fetch_github_release(
            repo,
            asset_name=self.state.get("github_release_asset_name") or None,
            token=get_github_token(self.state),
        )
        if not info.ok:
            with self._update_lock:
                self._update_phase = "idle"
                self._update_message = info.message
            return {"ok": False, "message": info.message, "updateAvailable": False}

        current_version = APP_VERSION
        if info.version and self._parse_version(info.version) <= self._parse_version(
            current_version
        ):
            with self._update_lock:
                self._update_phase = "idle"
                self._update_message = "Up to date"
                self._update_available_version = ""
                self._update_download_url = ""
                self._update_download_target = None
            return {"ok": True, "message": "Up to date", "updateAvailable": False}

        if not info.download_url:
            with self._update_lock:
                self._update_phase = "idle"
                self._update_message = "Release missing download URL"
            return {
                "ok": False,
                "message": "Release missing download URL",
                "updateAvailable": False,
            }

        with self._update_lock:
            self._update_phase = "available"
            self._update_message = f"Update available: {info.version}"
            self._update_available_version = info.version or ""
            self._update_download_url = info.download_url or ""
        if (not self.state.get("auto_update_enabled", False)) and (not quiet):
            self._append_notice(f"Update available: {info.version}", level="INFO")
        return {
            "ok": True,
            "message": f"Update available: {info.version}",
            "updateAvailable": True,
            "version": info.version,
        }

    def _download_update_task(self) -> None:
        with self._update_lock:
            if self._update_in_progress:
                return
            download_url = self._update_download_url
            version = self._update_available_version
            self._update_in_progress = True
            self._update_phase = "downloading"
            self._update_message = "Downloading..."
            self._update_download_target = None
            self._update_downloaded_bytes = 0
            self._update_total_bytes = None

        def on_progress(downloaded: int, total: int | None) -> None:
            with self._update_lock:
                self._update_downloaded_bytes = downloaded
                self._update_total_bytes = total

        self._append_notice(f"Downloading update {version}", level="INFO")
        try:
            target = download_update(
                download_url,
                get_update_dir(),
                progress_callback=on_progress,
                token=get_github_token(self.state),
            )
        except Exception as exc:  # noqa: BLE001
            self._append_notice(f"Update download failed: {exc}", level="ERROR")
            with self._update_lock:
                self._update_in_progress = False
                self._update_phase = "error"
                self._update_message = f"Update failed: {exc}"
            return

        with self._update_lock:
            if self._update_total_bytes is None or self._update_total_bytes <= 0:
                self._update_total_bytes = self._update_downloaded_bytes
            else:
                self._update_downloaded_bytes = max(
                    self._update_downloaded_bytes, self._update_total_bytes
                )
        time.sleep(0.35)

        with self._update_lock:
            self._update_phase = "downloaded"
            self._update_message = "Download complete"
            self._update_download_target = str(target)
            self._update_in_progress = False

        self._append_notice("Update downloaded, ready to install", level="INFO")

    def _install_update_task(self) -> None:
        with self._update_lock:
            if self._update_in_progress:
                return
            target = self._update_download_target
            if not target:
                self._update_phase = "error"
                self._update_message = "No downloaded update found"
                return
            self._update_in_progress = True
            self._update_phase = "restarting"
            self._update_message = "Restarting..."

        self._append_notice("Installing update…", level="INFO")
        self._apply_update_now(Path(target))

    def shutdown(self) -> None:
        self._shutdown_event.set()
        self._append_notice("Shutting down", level="INFO")
        with self._background_started_lock:
            if self._background_start_timer:
                try:
                    self._background_start_timer.cancel()
                except Exception:  # noqa: BLE001
                    pass
                self._background_start_timer = None

        with self._calendar_proc_lock:
            executor = self._calendar_executor
            self._calendar_executor = None

        if executor:
            try:
                executor.shutdown(wait=False, cancel_futures=True)
            except Exception:  # noqa: BLE001
                pass

    def _start_auto_update_loop(self) -> None:
        interval_seconds = max(10, AUTO_UPDATE_INTERVAL_MINUTES) * 60

        def loop() -> None:
            while not self._shutdown_event.wait(interval_seconds):
                self._update_check(manual=False)

        thread = threading.Thread(target=loop, daemon=True)
        thread.start()

    def _resolve_calendar_repo_path(self) -> Path | None:
        main_path = self._get_main_repo_path()
        if self.state.get("enable_sync_repo", False):
            sync_value = (self.state.get("sync_repo_path") or "").strip()
            if sync_value:
                repo_slug = normalize_repo_slug(
                    (self.state.get("github_repo") or "").strip()
                )
                probe = self._probe_sync_repo(
                    Path(sync_value), repo_slug, auto_start=True
                )
                if probe.get("ready"):
                    return Path(sync_value)

        if main_path and (main_path / "data" / "Economic_Calendar").exists():
            return main_path
        return None

    def _request_calendar_refresh(self, reason: str = "") -> None:
        if self._shutdown_event.is_set():
            return
        with self._calendar_refresh_lock:
            if self._calendar_refresh_in_progress:
                return
            self._calendar_refresh_in_progress = True
            self._calendar_status = "loading"
            self._request_snapshot_rebuild("calendar-loading")

        def runner() -> None:
            try:
                repo_path = self._resolve_calendar_repo_path()
                if not repo_path:
                    self._calendar_status = "empty"
                    self.calendar_events = []
                    self._calendar_last_loaded = datetime.now()
                    self._request_snapshot_rebuild("calendar-empty")
                    return
                events = self._load_calendar_events_external(repo_path)
                self._calendar_status = "loaded"
                self.calendar_events = events
                self._calendar_last_loaded = datetime.now()
                self._request_snapshot_rebuild("calendar-loaded")
            except Exception as exc:  # noqa: BLE001
                self.logger.exception("Calendar refresh failed (%s)", reason)
                self._calendar_status = "error"
                self._append_notice(f"Calendar refresh failed: {exc}", level="ERROR")
                self.calendar_events = []
                self._calendar_last_loaded = datetime.now()
                self._request_snapshot_rebuild("calendar-error")
            finally:
                with self._calendar_refresh_lock:
                    self._calendar_refresh_in_progress = False

        thread = threading.Thread(target=runner, daemon=True)
        thread.start()

    def _get_calendar_executor(self) -> ProcessPoolExecutor:
        with self._calendar_proc_lock:
            if self._calendar_executor:
                return self._calendar_executor
            self._calendar_executor = ProcessPoolExecutor(max_workers=1)
            return self._calendar_executor

    def _load_calendar_events_external(self, repo_path: Path) -> list[dict]:
        """
        Parse the calendar in a child process to avoid starving the GUI thread via the GIL.
        Falls back to in-process parsing if the executor is unavailable.
        """
        try:
            executor = self._get_calendar_executor()
        except Exception:  # noqa: BLE001
            return self._load_calendar_events(repo_path)

        future = executor.submit(load_calendar_events, str(repo_path))
        try:
            return future.result(timeout=20)
        except TimeoutError:
            future.cancel()
            raise RuntimeError("Calendar load timed out") from None
        except Exception:  # noqa: BLE001
            return self._load_calendar_events(repo_path)

    def _refresh_calendar_data(self) -> None:
        repo_path = self._resolve_calendar_repo_path()
        if not repo_path:
            self.calendar_events = []
            self._calendar_last_loaded = datetime.now()
            return
        self.calendar_events = self._load_calendar_events(repo_path)
        self._calendar_last_loaded = datetime.now()

    def _refresh_calendar_if_stale(self) -> None:
        if not self._calendar_last_loaded:
            self._request_calendar_refresh("initial")
            return
        if not self.calendar_events:
            self._request_calendar_refresh("empty")
            return
        age = datetime.now() - self._calendar_last_loaded
        if age.total_seconds() > 90:
            self._request_calendar_refresh("stale")

    def _load_calendar_events(self, repo_path: Path) -> list[dict]:
        now = datetime.now()
        calendar_root = repo_path / "data" / "Economic_Calendar"
        if not calendar_root.exists():
            return []
        year_dirs = []
        for entry in calendar_root.iterdir():
            if entry.is_dir() and entry.name.isdigit():
                year_dirs.append(int(entry.name))
        if not year_dirs:
            return []
        years = sorted(set(year_dirs))
        current_year = now.year
        candidates = [y for y in years if y in (current_year, current_year + 1)]
        if not candidates:
            candidates = [years[-1]]
        items: list[dict] = []
        for year in candidates:
            year_path = calendar_root / str(year)
            file_path = year_path / f"{year}_calendar.json"
            if not file_path.exists():
                matches = list(year_path.glob("*.json"))
                if not matches:
                    continue
                file_path = matches[0]
            try:
                payload = json.loads(file_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(payload, list):
                continue
            items.extend(payload)
        events = []
        for item in items:
            date_raw = item.get("Date")
            time_raw = (item.get("Time") or "").strip()
            event_raw = (item.get("Event") or "").strip()
            currency_raw = (item.get("Cur.") or "").strip()
            importance_raw = (item.get("Imp.") or "").strip()
            if not date_raw or not event_raw:
                continue
            try:
                date_val = datetime.strptime(date_raw, "%Y-%m-%d").date()
            except ValueError:
                continue
            time_label = time_raw or "All Day"
            if ":" in time_raw:
                try:
                    time_val = datetime.strptime(time_raw, "%H:%M").time()
                except ValueError:
                    time_val = datetime.min.time()
            else:
                time_val = datetime.min.time()
            dt_source = datetime.combine(date_val, time_val).replace(
                tzinfo=utc_offset_minutes_to_tzinfo(CALENDAR_SOURCE_UTC_OFFSET_MINUTES)
            )
            dt_utc = dt_source.astimezone(timezone.utc)
            events.append(
                {
                    "dt_utc": dt_utc,
                    "time_label": time_label,
                    "event": event_raw,
                    "currency": currency_raw.upper(),
                    "importance": importance_raw,
                    "actual": (item.get("Actual") or "").strip(),
                    "forecast": (item.get("Forecast") or "").strip(),
                    "previous": (item.get("Previous") or "").strip(),
                }
            )
        events.sort(key=lambda item: item["dt_utc"])
        return events

    def _currency_options(self, events: list[dict]) -> list[str]:
        currencies = {
            event.get("currency", "") for event in events if event.get("currency")
        }
        options = ["USD"]
        options.extend(sorted(currency for currency in currencies if currency != "USD"))
        options.append("ALL")
        return options

    def _format_countdown(self, target_utc: datetime) -> str:
        delta = target_utc - datetime.now(timezone.utc)
        if delta.total_seconds() <= 0:
            return "Now"
        minutes = int(delta.total_seconds() // 60)
        hours, mins = divmod(minutes, 60)
        days, hours = divmod(hours, 24)
        if days > 0:
            return f"{days}d {hours}h"
        return f"{hours}h {mins}m"

    def _format_time_text(
        self,
        dt_display: datetime,
        time_label: str,
        source_date_label: str | None = None,
    ) -> str:
        time_text = dt_display.strftime("%d-%m-%Y %H:%M")
        label = time_label.strip()
        if label.lower() == "all day":
            date_label = source_date_label or dt_display.strftime("%d-%m-%Y")
            return f"{date_label} All Day"
        if label and ":" not in label:
            return f"{dt_display.strftime('%d-%m-%Y')} {label}"
        return time_text

    def _render_next_events(self, events: list[dict], currency: str) -> list[dict]:
        now_utc = datetime.now(timezone.utc)
        selected = (currency or "USD").strip().upper()
        if not events:
            return []
        tz = utc_offset_minutes_to_tzinfo(self._effective_calendar_utc_offset_minutes())
        source_tz = utc_offset_minutes_to_tzinfo(CALENDAR_SOURCE_UTC_OFFSET_MINUTES)
        rendered = []
        candidates = [
            event for event in events if isinstance(event.get("dt_utc"), datetime)
        ]
        for event in sorted(candidates, key=lambda item: item["dt_utc"]):
            dt_utc: datetime = event["dt_utc"]
            if dt_utc < now_utc:
                continue
            event_currency = event.get("currency", "").upper()
            if selected != "ALL" and event_currency != selected:
                continue
            time_label = event["time_label"]
            event_name = event["event"]
            importance = event.get("importance", "")
            dt_display = dt_utc.astimezone(tz)
            source_date = dt_utc.astimezone(source_tz).strftime("%d-%m-%Y")
            time_text = self._format_time_text(
                dt_display, time_label, source_date_label=source_date
            )
            rendered.append(
                {
                    "time": time_text,
                    "cur": event_currency or "--",
                    "impact": importance or "--",
                    "event": event_name,
                    "countdown": self._format_countdown(dt_utc),
                }
            )
            if len(rendered) >= 240:
                break
        return rendered

    def _render_past_events(self, events: list[dict], currency: str) -> list[dict]:
        now_utc = datetime.now(timezone.utc)
        cutoff = now_utc - timedelta(days=31)
        selected = (currency or "USD").strip().upper()
        if not events:
            return []
        tz = utc_offset_minutes_to_tzinfo(self._effective_calendar_utc_offset_minutes())
        source_tz = utc_offset_minutes_to_tzinfo(CALENDAR_SOURCE_UTC_OFFSET_MINUTES)
        rendered = []
        candidates = [
            event for event in events if isinstance(event.get("dt_utc"), datetime)
        ]
        for event in sorted(candidates, key=lambda item: item["dt_utc"], reverse=True):
            dt_utc: datetime = event["dt_utc"]
            if dt_utc >= now_utc or dt_utc < cutoff:
                continue
            event_currency = event.get("currency", "").upper()
            if selected != "ALL" and event_currency != selected:
                continue
            time_label = event.get("time_label", "")
            dt_display = dt_utc.astimezone(tz)
            source_date = dt_utc.astimezone(source_tz).strftime("%d-%m-%Y")
            rendered.append(
                {
                    "time": self._format_time_text(
                        dt_display, time_label, source_date_label=source_date
                    ),
                    "cur": event_currency or "--",
                    "impact": (event.get("importance") or "--").strip() or "--",
                    "event": (event.get("event") or "").strip(),
                    "actual": (event.get("actual") or "").strip(),
                    "forecast": (event.get("forecast") or "").strip(),
                    "previous": (event.get("previous") or "").strip(),
                }
            )
            if len(rendered) >= 300:
                break
        return rendered

    def _ensure_dir(self, value: str) -> None:
        if not value:
            return
        path = Path(value)
        if path.exists():
            return
        path.mkdir(parents=True, exist_ok=True)
        created = self.state.get("created_paths", [])
        if value not in created:
            created.append(value)
            self.state["created_paths"] = created

    def _track_path(self, key: str, value: str) -> None:
        if not value:
            return
        history = self.state.get(key, [])
        if value in history:
            return
        history.append(value)
        self.state[key] = history

    def _track_successful_repo(self, repo_path: Path) -> None:
        history = self.state.get("successful_repo_paths", [])
        value = str(repo_path)
        if value in history:
            return
        history.append(value)
        self.state["successful_repo_paths"] = history
        save_config(self.state)

    def _apply_startup_setting(self, enabled: bool) -> None:
        if enabled:
            result = create_startup_task(self._build_start_command())
        else:
            result = remove_startup_task()
        if not result.ok:
            self._append_notice(f"{result.message}: {result.output}", level="WARN")

    def _build_start_command(self) -> str:
        if getattr(sys, "frozen", False):
            exe_path = Path(sys.executable)
            return f'"{exe_path}"'
        python_path = Path(sys.executable)
        script_path = Path(__file__).resolve().parent / "web_app.py"
        return f'"{python_path}" "{script_path}"'

    def _get_main_repo_path(self) -> Path | None:
        raw = (self.state.get("repo_path") or "").strip()
        return Path(raw) if raw else None

    def _resolve_repo_path(self) -> Path | None:
        enable_sync_repo = bool(self.state.get("enable_sync_repo", False))
        sync_value = (
            self.state.get("sync_repo_path", "").strip() if enable_sync_repo else ""
        )
        repo_value = self.state.get("repo_path", "").strip()
        if enable_sync_repo:
            if not sync_value:
                managed = get_repo_dir()
                sync_value = str(managed)
                self.state["sync_repo_path"] = sync_value
                save_config(self.state)
            repo_slug = normalize_repo_slug(
                (self.state.get("github_repo") or "").strip()
            )
            sync_path = Path(sync_value)
            probe = self._probe_sync_repo(sync_path, repo_slug, auto_start=True)
            if probe.get("ready"):
                return sync_path
            if probe.get("action") == "auto-clone-started":
                self._append_sync_repo_notice_once(
                    "Sync repo is being prepared (clone in progress).", level="INFO"
                )
            elif probe.get("needsConfirmation"):
                self._append_sync_repo_notice_once(
                    "Sync repo needs confirmation. Open Settings, then close it to review options.",
                    level="WARN",
                )
            return None
        if repo_value:
            repo_path = Path(repo_value)
            calendar_root = repo_path / "data" / "Economic_Calendar"
            if (repo_path / ".git").exists() or calendar_root.exists():
                return repo_path
            managed = get_repo_dir()
            if (
                enable_sync_repo
                and not (self.state.get("sync_repo_path") or "").strip()
            ):
                self.state["sync_repo_path"] = str(managed)
                save_config(self.state)
            return self._ensure_git_repo(managed)
        return None

    def _ensure_git_repo(self, repo_path: Path) -> Path | None:
        if (repo_path / ".git").exists():
            return repo_path
        repo = self.state.get("github_repo", "")
        if not repo:
            self._append_notice("GitHub repo not configured", level="WARN")
            return None
        if repo_path.exists():
            try:
                if any(repo_path.iterdir()):
                    self._append_notice(
                        "Selected folder is not a Git repository. Please choose an empty folder.",
                        level="WARN",
                    )
                    return None
                repo_path.rmdir()
            except OSError:
                self._append_notice(
                    "Selected folder is not a Git repository. Please choose an empty folder.",
                    level="WARN",
                )
                return None
        repo_path.parent.mkdir(parents=True, exist_ok=True)
        from agent.git_ops import clone_repo

        result = clone_repo(f"https://github.com/{repo}.git", repo_path)
        if not result.ok:
            self._append_notice(f"{result.message}: {result.output}", level="ERROR")
            return None
        self._append_notice("Repo cloned for sync", level="INFO")
        self._track_successful_repo(repo_path)
        return repo_path

    def _append_sync_repo_notice_once(self, message: str, level: str = "INFO") -> None:
        now = time.time()
        if self._sync_repo_last_notice_ts and now - self._sync_repo_last_notice_ts < 20:
            return
        self._sync_repo_last_notice_ts = now
        self._append_notice(message, level=level)

    @staticmethod
    def _safe_resolve(path: Path) -> Path:
        try:
            return path.resolve(strict=False)
        except Exception:  # noqa: BLE001
            return path

    def _is_safe_sync_repo_target(self, path: Path) -> bool:
        main_path_raw = get_default_repo_path()
        if not main_path_raw:
            return True
        main_path = self._safe_resolve(Path(main_path_raw))
        candidate = self._safe_resolve(path)
        try:
            candidate.relative_to(main_path)
            return False
        except ValueError:
            pass
        try:
            main_path.relative_to(candidate)
            return False
        except ValueError:
            pass
        return True

    def _is_sync_repo_confirmed(self, path: Path, repo_slug: str) -> bool:
        confirmed_path = (self.state.get("sync_repo_confirmed_path") or "").strip()
        confirmed_repo = (
            (self.state.get("sync_repo_confirmed_repo") or "").strip().lower()
        )
        confirmed_mode = (
            (self.state.get("sync_repo_confirmed_mode") or "").strip().lower()
        )
        if not confirmed_path or not confirmed_repo or not confirmed_mode:
            return False
        if confirmed_repo != (repo_slug or "").strip().lower():
            return False
        resolved = str(self._safe_resolve(path))
        return resolved == confirmed_path and confirmed_mode in ("use-as-is", "reset")

    def _set_sync_repo_confirmation(
        self, path: Path, repo_slug: str, mode: str
    ) -> None:
        self.state["sync_repo_confirmed_path"] = str(self._safe_resolve(path))
        self.state["sync_repo_confirmed_repo"] = (repo_slug or "").strip().lower()
        self.state["sync_repo_confirmed_mode"] = (mode or "").strip().lower()
        self.state["sync_repo_confirmed_at"] = to_iso_time(datetime.now())
        save_config(self.state)

    def _probe_sync_repo(
        self, path: Path | None, repo_slug: str, auto_start: bool
    ) -> dict:
        with self._sync_repo_task_lock:
            task_active = self._sync_repo_task_active
            task_path = self._sync_repo_task_path
        if not path:
            return {
                "status": "disabled",
                "ready": False,
                "needsConfirmation": False,
                "canUseAsIs": False,
                "canReset": False,
                "path": "",
                "message": "Sync repo disabled",
                "taskActive": task_active,
                "taskPath": task_path,
            }
        resolved = str(self._safe_resolve(path))
        can_reset = self._is_safe_sync_repo_target(path)
        expected_repo = (repo_slug or "").strip().lower()
        if not can_reset:
            return {
                "status": "unsafe",
                "ready": False,
                "needsConfirmation": True,
                "canUseAsIs": False,
                "canReset": False,
                "path": resolved,
                "message": "Sync repo overlaps Main Path. Choose a separate folder.",
                "taskActive": False,
                "taskPath": "",
            }
        if not expected_repo:
            return {
                "status": "misconfigured",
                "ready": False,
                "needsConfirmation": False,
                "canUseAsIs": False,
                "canReset": can_reset,
                "path": resolved,
                "message": "GitHub repo not configured",
                "taskActive": task_active,
                "taskPath": task_path,
            }
        if task_active and task_path and task_path == resolved:
            return {
                "status": "busy",
                "ready": False,
                "needsConfirmation": False,
                "canUseAsIs": False,
                "canReset": False,
                "path": resolved,
                "message": "Sync repo operation in progress",
                "taskActive": True,
                "taskPath": task_path,
                "action": "in-progress",
            }

        if path.exists() and not path.is_dir():
            return {
                "status": "invalid",
                "ready": False,
                "needsConfirmation": False,
                "canUseAsIs": False,
                "canReset": False,
                "path": resolved,
                "message": "Sync repo path is not a folder",
                "taskActive": False,
                "taskPath": "",
            }

        status = ""
        message = ""
        needs_confirmation = False
        can_use_as_is = False
        ready = False
        details: dict = {}

        if not path.exists():
            status = "missing"
            message = "Folder does not exist; clone will create it"
        else:
            try:
                is_empty = not any(path.iterdir())
            except OSError:
                is_empty = False
            if is_empty:
                status = "empty"
                message = "Folder is empty; clone will use it"
            elif (path / ".git").exists():
                usable = is_git_repo_usable(path)
                if not usable.ok:
                    status = "git-unusable"
                    message = "Git metadata detected, but the repo is not usable"
                    needs_confirmation = True
                    details["error"] = usable.output
                else:
                    origin_slug = get_origin_repo_slug(path)
                    if not origin_slug.ok:
                        status = "git-origin-missing"
                        message = "Git repo detected, but origin is missing"
                        needs_confirmation = True
                        details["error"] = origin_slug.output
                    elif origin_slug.output.strip().lower() != expected_repo:
                        status = "git-origin-mismatch"
                        message = "Git repo detected, but origin does not match the configured sync repo"
                        needs_confirmation = True
                        details["origin"] = origin_slug.output.strip()
                        details["expectedRepo"] = expected_repo
                    else:
                        # Origin matches the configured sync repo. Ensure this folder is actually
                        # safe to use as a working copy for GitHub main.
                        needs_confirmation = True
                        details["origin"] = origin_slug.output.strip()
                        details["expectedRepo"] = expected_repo
                        legacy_prefix_staging = f"{path.name}.staging-"
                        legacy_prefix_backup = f"{path.name}.backup-"
                        has_legacy_temp = False
                        try:
                            with os.scandir(path) as it:
                                for entry in it:
                                    try:
                                        if not entry.is_dir(follow_symlinks=False):
                                            continue
                                    except OSError:
                                        continue
                                    name = entry.name
                                    if name.startswith(
                                        legacy_prefix_staging
                                    ) or name.startswith(legacy_prefix_backup):
                                        has_legacy_temp = True
                                        break
                        except OSError:
                            has_legacy_temp = False

                        calendar_root = path / "data" / "Economic_Calendar"
                        if not calendar_root.exists():
                            status = "git-unusable"
                            message = "Sync repo is missing calendar data"
                        else:
                            status_out = get_status_porcelain(path)
                            if not status_out.ok:
                                status = "git-unusable"
                                message = "Git repo detected, but status cannot be read"
                                details["error"] = status_out.output
                            elif has_legacy_temp or status_out.output.strip():
                                status = "git-not-clean"
                                message = "Sync repo contains extra files"
                            else:
                                # Keep probe fast and UI-friendly: do not fetch on probe.
                                head_branch = get_head_branch(path)
                                head = get_head_sha(path)
                                origin_sha = get_origin_sha(path)
                                if head_branch.ok and head_branch.output.strip():
                                    details["branch"] = head_branch.output.strip()
                                if head.ok and head.output.strip():
                                    details["head"] = head.output.strip()
                                if origin_sha.ok and origin_sha.output.strip():
                                    details["originMain"] = origin_sha.output.strip()

                                if not head.ok:
                                    status = "git-unusable"
                                    message = (
                                        "Git repo detected, but HEAD cannot be read"
                                    )
                                    details["error"] = head.output
                                elif not head_branch.ok:
                                    status = "git-unusable"
                                    message = (
                                        "Git repo detected, but branch cannot be read"
                                    )
                                    details["error"] = head_branch.output
                                elif head_branch.output.strip() != "main":
                                    status = "git-not-main"
                                    message = "Sync repo is not on branch main"
                                else:
                                    status = "git-expected-usable"
                                    message = "Existing sync repo looks usable"
                                    can_use_as_is = True
                                    if (
                                        head.ok
                                        and origin_sha.ok
                                        and head.output.strip()
                                        and origin_sha.output.strip()
                                        and head.output.strip()
                                        != origin_sha.output.strip()
                                    ):
                                        details["note"] = (
                                            "Note: HEAD differs from origin/main; Pull will update it."
                                        )
            else:
                status = "non-git-nonempty"
                message = "Folder contains files"
                needs_confirmation = True
                # Keep this warning simple: the folder might contain unrelated files,
                # so we avoid listing entries (can be noisy/expensive for large folders).

        if (
            needs_confirmation
            and status == "git-expected-usable"
            and self._is_sync_repo_confirmed(path, expected_repo)
        ):
            needs_confirmation = False
            ready = True
            can_use_as_is = True
            message = "Sync repo confirmed and ready"

        if status in ("missing", "empty") and auto_start:
            if not can_reset:
                return {
                    "status": "unsafe",
                    "ready": False,
                    "needsConfirmation": False,
                    "canUseAsIs": False,
                    "canReset": False,
                    "path": resolved,
                    "message": "Refusing to clone into Main Path or its parent",
                    "taskActive": False,
                    "taskPath": "",
                }
            started = self._start_sync_repo_clone(
                path, expected_repo, reset_first=False
            )
            if started:
                return {
                    "status": status,
                    "ready": False,
                    "needsConfirmation": False,
                    "canUseAsIs": False,
                    "canReset": True,
                    "path": resolved,
                    "message": message,
                    "taskActive": True,
                    "taskPath": resolved,
                    "action": "auto-clone-started",
                }

        if status == "git-expected-usable" and not needs_confirmation:
            ready = True

        return {
            "status": status,
            "ready": ready,
            "needsConfirmation": needs_confirmation,
            "canUseAsIs": can_use_as_is,
            "canReset": bool(can_reset),
            "path": resolved,
            "message": message,
            "details": details,
            "taskActive": False,
            "taskPath": "",
        }

    def _start_sync_repo_clone(
        self, path: Path, repo_slug: str, reset_first: bool
    ) -> bool:
        cancel_event = threading.Event()
        with self._sync_repo_task_lock:
            if self._sync_repo_task_active:
                return False
            self._sync_repo_task_active = True
            self._sync_repo_task_phase = "resetting" if reset_first else "cloning"
            self._sync_repo_task_progress = 0.0
            self._sync_repo_task_message = "Preparing sync repo"
            self._sync_repo_task_path = str(self._safe_resolve(path))
            self._sync_repo_task_cancel_event = cancel_event
            self._sync_repo_git_pid = None

        repo_url = f"https://github.com/{repo_slug}.git"

        def runner() -> None:
            try:
                resolved = Path(self._sync_repo_task_path)
                pid_file = self._sync_repo_pid_file(resolved)
                last_clear_failures: list[str] = []
                if cancel_event.is_set():
                    self._update_sync_repo_task("error", 0.0, "Canceled")
                    return
                if not self._is_safe_sync_repo_target(resolved):
                    self._append_notice(
                        "Reset/clone blocked: target path is not allowed", level="ERROR"
                    )
                    self._update_sync_repo_task("error", 0.0, "Unsafe sync repo path")
                    return

                def _on_rmtree_error(func, target, exc_info) -> None:  # noqa: ANN001
                    try:
                        os.chmod(target, 0o700)
                        func(target)
                    except Exception as exc:  # noqa: BLE001
                        raise exc

                def clear_dir_contents_strict(target: Path, attempts: int = 6) -> bool:
                    nonlocal last_clear_failures
                    failing_entries: list[str] = []
                    for attempt in range(attempts):
                        try:
                            target.mkdir(parents=True, exist_ok=True)
                        except OSError:
                            time.sleep(0.18 * (attempt + 1))
                            continue

                        try:
                            entries = list(target.iterdir())
                        except OSError:
                            time.sleep(0.18 * (attempt + 1))
                            continue

                        if not entries:
                            return True

                        ok = True
                        for entry in entries:
                            try:
                                if entry.is_dir():
                                    shutil.rmtree(entry, onerror=_on_rmtree_error)
                                else:
                                    os.chmod(entry, 0o700)
                                    entry.unlink(missing_ok=True)
                            except Exception:  # noqa: BLE001
                                ok = False
                                if len(failing_entries) < 6:
                                    failing_entries.append(str(entry))

                        if ok:
                            try:
                                if not any(target.iterdir()):
                                    return True
                            except OSError:
                                pass

                        time.sleep(0.18 * (attempt + 1))

                    try:
                        last_clear_failures = failing_entries
                        return not any(target.iterdir())
                    except OSError:
                        last_clear_failures = failing_entries
                        return False

                if reset_first:
                    self._append_notice("Sync reset started", level="WARN")
                    self._update_sync_repo_task(
                        "resetting", 0.05, "Clearing sync repo folder"
                    )
                else:
                    self._append_notice("Sync repo clone started", level="INFO")

                try:
                    resolved.parent.mkdir(parents=True, exist_ok=True)
                    resolved.mkdir(parents=True, exist_ok=True)
                except Exception as exc:  # noqa: BLE001
                    self._append_notice(f"Sync repo clone failed: {exc}", level="ERROR")
                    self._update_sync_repo_task("error", 0.0, "Clone failed")
                    return

                if cancel_event.is_set():
                    self._update_sync_repo_task("error", 0.0, "Canceled")
                    return

                if reset_first:
                    self._terminate_sync_repo_pid_file(resolved, reason="Reset & Clone")
                    ok = clear_dir_contents_strict(resolved)
                    if not ok:
                        kill_result = terminate_git_clone_processes_by_repo_url(
                            repo_url
                        )
                        if kill_result.ok and (kill_result.output or "").startswith(
                            "killed="
                        ):
                            self._append_notice(
                                f"Stopped git clone processes for sync repo: {kill_result.output}",
                                level="WARN",
                            )
                        ok = clear_dir_contents_strict(resolved, attempts=8)
                    if not ok:
                        sample = ", ".join(last_clear_failures[:3])
                        if sample:
                            self._append_notice(
                                f"Sync repo reset failed (examples still locked): {sample}",
                                level="ERROR",
                            )
                        self._append_notice(
                            "Sync reset failed: folder is in use. Close any apps using it and try again.",
                            level="ERROR",
                        )
                        self._update_sync_repo_task("error", 0.0, "Folder is in use")
                        return

                self._update_sync_repo_task("cloning", 0.1, "Cloning repo")

                def on_progress(percent: int, line: str) -> None:
                    progress = 0.1 + (max(0, min(100, percent)) / 100.0) * 0.85
                    self._update_sync_repo_task("cloning", progress, "Cloning...")

                def on_process(process: subprocess.Popen) -> None:
                    with self._sync_repo_task_lock:
                        self._sync_repo_git_pid = (
                            int(process.pid) if process.pid else None
                        )
                    try:
                        pid_file.parent.mkdir(parents=True, exist_ok=True)
                        pid_file.write_text(str(int(process.pid)), encoding="utf-8")
                    except Exception:  # noqa: BLE001
                        pass

                # Clone into the existing folder (.) so empty folders work without errors.
                result = clone_repo_with_progress_into_dir(
                    repo_url, resolved, on_progress=on_progress, on_process=on_process
                )
                with self._sync_repo_task_lock:
                    self._sync_repo_git_pid = None
                try:
                    pid_file.unlink(missing_ok=True)
                except OSError:
                    pass
                if not result.ok:
                    if cancel_event.is_set():
                        self._update_sync_repo_task("error", 0.0, "Canceled")
                        return
                    self._append_notice(
                        f"Sync repo clone failed: {result.output}", level="ERROR"
                    )
                    self._update_sync_repo_task("error", 0.0, "Clone failed")
                    if reset_first:
                        try:
                            clear_dir_contents_strict(resolved, attempts=2)
                        except Exception:  # noqa: BLE001
                            pass
                    return

                self._append_notice("Sync repo clone completed", level="INFO")
                self._track_successful_repo(resolved)
                calendar_root = resolved / "data" / "Economic_Calendar"
                if not calendar_root.exists():
                    self._append_notice(
                        "Sync incomplete: calendar data missing. Please retry Reset & Clone.",
                        level="ERROR",
                    )
                    self._update_sync_repo_task("error", 0.0, "Clone incomplete")
                    try:
                        clear_dir_contents_strict(resolved, attempts=2)
                    except Exception:  # noqa: BLE001
                        pass
                    return

                self._set_sync_repo_confirmation(resolved, repo_slug, mode="reset")
                self.calendar_events = self._load_calendar_events(resolved)
                self._calendar_last_loaded = datetime.now()
                self._update_sync_repo_task("ready", 1.0, "Ready")
            finally:
                with self._sync_repo_task_lock:
                    self._sync_repo_task_active = False
                    self._sync_repo_task_cancel_event = None
                    self._sync_repo_git_pid = None
                    if self._sync_repo_task_phase not in ("ready", "error"):
                        self._sync_repo_task_phase = "idle"

        thread = threading.Thread(target=runner, daemon=True)
        thread.start()
        return True

    def _update_sync_repo_task(self, phase: str, progress: float, message: str) -> None:
        with self._sync_repo_task_lock:
            self._sync_repo_task_phase = phase
            self._sync_repo_task_progress = max(0.0, min(1.0, float(progress)))
            self._sync_repo_task_message = message

    def _maybe_pull_and_sync(self) -> None:
        if self._shutdown_event.is_set():
            return
        if not self.state.get("enable_sync_repo", False):
            self._maybe_refresh_calendar_only()
            return
        repo_path = self._resolve_repo_path()
        if not repo_path:
            if self.state.get("enable_sync_repo", False):
                return
            self._append_notice("Repository path not configured", level="WARN")
            return
        if not (repo_path / ".git").exists():
            install_dir = (
                Path(get_default_repo_path()) if get_default_repo_path() else None
            )
            if not install_dir or not self._is_installed_dir(install_dir):
                self._append_notice(
                    "Update skipped: this installation does not support auto-update",
                    level="WARN",
                )
                return

            last_pull = parse_iso_time(self.state.get("last_pull_at", ""))
            stale = True
            if last_pull:
                stale = datetime.now() - last_pull > timedelta(
                    days=self.state.get("auto_pull_days", 1)
                )
            if not stale:
                self._append_notice("Calendar is up to date", level="INFO")
                return

            repo = (self.state.get("github_repo") or "").strip()
            branch = (self.state.get("github_branch") or "main").strip() or "main"
            if not repo:
                self._append_notice("GitHub repo not configured", level="WARN")
                return
            result = update_calendar_from_github(
                repo, branch, install_dir, token=get_github_token(self.state)
            )
            if not result.ok:
                self._append_notice(result.message, level="ERROR")
                return

            self.state["last_pull_at"] = to_iso_time(datetime.now())
            save_config(self.state)
            self._append_notice(
                self._calendar_refreshed_message(result.files), level="INFO"
            )
            if self.state.get("auto_sync_after_pull", True) and self._get_output_dir():
                self._sync_only()
            self._refresh_calendar_data()
            return

        last_pull = parse_iso_time(self.state.get("last_pull_at", ""))
        stale = True
        if last_pull:
            stale = datetime.now() - last_pull > timedelta(
                days=self.state.get("auto_pull_days", 1)
            )

        fetch = fetch_origin(repo_path)
        if not fetch.ok:
            self._append_notice(f"Fetch failed: {fetch.output}", level="ERROR")
            return
        self._track_successful_repo(repo_path)

        head = get_head_sha(repo_path)
        origin = get_origin_sha(repo_path)
        if not head.ok or not origin.ok:
            self._append_notice("Failed to read Git repository state", level="ERROR")
            return

        needs_pull = head.output.strip() != origin.output.strip()
        if stale or needs_pull:
            self._pull_and_sync()
        else:
            self._append_notice("Repo already up to date", level="INFO")

    def _pull_and_sync(self) -> None:
        if self._shutdown_event.is_set():
            return
        if not self.state.get("enable_sync_repo", False):
            self._pull_calendar_only(force=True)
            return
        repo_path = self._resolve_repo_path()
        if not repo_path:
            return
        if not (repo_path / ".git").exists():
            install_dir = (
                Path(get_default_repo_path()) if get_default_repo_path() else None
            )
            if not install_dir or not self._is_installed_dir(install_dir):
                self._append_notice(
                    "Update skipped: this installation does not support auto-update",
                    level="WARN",
                )
                return
            repo = (self.state.get("github_repo") or "").strip()
            branch = (self.state.get("github_branch") or "main").strip() or "main"
            if not repo:
                self._append_notice("GitHub repo not configured", level="WARN")
                return
            result = update_calendar_from_github(
                repo, branch, install_dir, token=get_github_token(self.state)
            )
            if not result.ok:
                self._append_notice(result.message, level="ERROR")
                return
            self.state["last_pull_at"] = to_iso_time(datetime.now())
            save_config(self.state)
            self._append_notice(
                self._calendar_refreshed_message(result.files), level="INFO"
            )
            if self.state.get("auto_sync_after_pull", True):
                output_dir = self._get_output_dir()
                if output_dir:
                    self._sync_only()
                else:
                    self._append_notice(
                        "Auto sync skipped: output directory not configured",
                        level="WARN",
                    )
            self._refresh_calendar_data()
            return
        result = pull_origin_main(repo_path)
        if not result.ok:
            self._append_notice(f"Pull failed: {result.output}", level="ERROR")
            return
        self._append_notice("Data update completed", level="INFO")
        self._track_successful_repo(repo_path)

        sha = get_head_sha(repo_path)
        if sha.ok:
            self.state["last_pull_sha"] = sha.output.strip()

        self.state["last_pull_at"] = to_iso_time(datetime.now())
        save_config(self.state)

        if self.state.get("auto_sync_after_pull", True):
            output_dir = self._get_output_dir()
            if output_dir:
                self._sync_only()
            else:
                self._append_notice(
                    "Auto sync skipped: output directory not configured", level="WARN"
                )
        self._refresh_calendar_data()

    def _sync_only(self) -> None:
        if self._shutdown_event.is_set():
            return
        repo_path = self._resolve_repo_path()
        output_dir = self._get_output_dir()
        if not repo_path:
            return
        if not output_dir:
            self._append_notice("Output directory not configured", level="WARN")
            return

        src_dir = repo_path / "data" / "Economic_Calendar"
        try:
            result = mirror_sync(src_dir, output_dir)
        except FileNotFoundError:
            self._append_notice(
                "Calendar source not found in repository", level="ERROR"
            )
            return
        self._write_output_dir_marker(output_dir)
        self._track_successful_repo(repo_path)
        self._append_notice(
            f"Sync ok: +{result.copied} / -{result.deleted} / = {result.skipped}",
            level="INFO",
        )
        self.state["last_sync_at"] = to_iso_time(datetime.now())
        save_config(self.state)
        self._refresh_calendar_data()

    def _maybe_refresh_calendar_only(self) -> None:
        last_pull = parse_iso_time(self.state.get("last_pull_at", ""))
        stale = True
        if last_pull:
            stale = datetime.now() - last_pull > timedelta(
                days=self.state.get("auto_pull_days", 1)
            )
        if not stale:
            self._append_notice("Calendar is up to date", level="INFO")
            return
        self._pull_calendar_only(force=False, reason="auto")

    def _pull_calendar_only(self, force: bool, reason: str = "") -> None:
        repo_path = self._get_main_repo_path()
        if not repo_path:
            self._append_notice("Repository path not configured", level="WARN")
            return
        repo = (self.state.get("github_repo") or "").strip()
        branch = (self.state.get("github_branch") or "main").strip() or "main"
        if not repo:
            self._append_notice("GitHub repo not configured", level="WARN")
            return
        token = get_github_token(self.state)
        sha_ok, sha_message, sha = fetch_github_branch_head_sha(
            repo, branch, token=token
        )
        if not sha_ok:
            self._append_notice(sha_message, level="ERROR")
            return

        calendar_dir = repo_path / "data" / "Economic_Calendar"
        has_local_calendar = False
        try:
            has_local_calendar = calendar_dir.exists() and any(calendar_dir.iterdir())
        except OSError:
            has_local_calendar = False

        if sha and sha == (self.state.get("last_pull_sha") or "").strip():
            if (not force) and has_local_calendar:
                self.state["last_pull_at"] = to_iso_time(datetime.now())
                save_config(self.state)
                self._append_notice("Calendar is up to date", level="INFO")
                self._refresh_calendar_data()
                return
        result = update_calendar_from_github(repo, branch, repo_path, token=token)
        if not result.ok:
            self._append_notice(result.message, level="ERROR")
            return
        self.state["last_pull_at"] = to_iso_time(datetime.now())
        self.state["last_pull_sha"] = sha
        save_config(self.state)
        self._append_notice(
            self._calendar_refreshed_message(result.files, reason=reason),
            level="INFO",
        )
        if self.state.get("auto_sync_after_pull", True) and self._get_output_dir():
            self._sync_only()
        self._refresh_calendar_data()

    def _get_output_dir(self) -> Path | None:
        value = self.state.get("output_dir", "").strip()
        if not value:
            return None
        return Path(value)

    def _write_output_dir_marker(self, output_dir: Path) -> None:
        try:
            if not output_dir.exists() or not output_dir.is_dir():
                return
            marker_path = output_dir / OUTPUT_DIR_MARKER_FILENAME
            if marker_path.exists():
                return
            payload = {"managedBy": APP_TITLE, "createdAt": to_iso_time(datetime.now())}
            marker_path.write_text(
                json.dumps(payload, ensure_ascii=False), encoding="utf-8"
            )
        except OSError:
            return

    @staticmethod
    def _is_path_root_dir(path: Path) -> bool:
        try:
            resolved = path.resolve()
        except OSError:
            resolved = path
        anchor = resolved.anchor
        if not anchor:
            return False
        return resolved == Path(anchor)

    def _update_check(self, manual: bool) -> None:
        if self._shutdown_event.is_set():
            return
        result = self._check_updates_task(quiet=not manual)
        if manual or not result.get("updateAvailable"):
            return
        if not self.state.get("auto_update_enabled", False):
            return
        with self._update_lock:
            download_url = self._update_download_url
            version = self._update_available_version
        if not download_url:
            return
        self._download_and_apply_update(download_url, version)

    def _download_and_apply_update(self, download_url: str, version: str) -> None:
        if self._shutdown_event.is_set():
            return
        self._append_notice(f"Downloading update {version}", level="INFO")
        try:
            target = download_update(
                download_url, get_update_dir(), token=get_github_token(self.state)
            )
        except Exception as exc:  # noqa: BLE001
            self._append_notice(f"Update download failed: {exc}", level="ERROR")
            return
        self._append_notice("Update downloaded. Applying now…", level="INFO")
        self._apply_update_now(target)

    def _apply_update_now(self, pending_path: Path) -> None:
        if not getattr(sys, "frozen", False):
            self._append_notice(
                "Auto update is available only in the EXE build", level="WARN"
            )
            return
        asset_name = (self.state.get("github_release_asset_name") or "").lower()
        is_setup = asset_name == "setup.exe" or asset_name.startswith("setup")

        exe_path = Path(sys.executable)
        script_path = pending_path.parent / f"apply_update_{os.getpid()}.cmd"
        if is_setup:
            restart_delay_seconds = 5
            self._restart_deadline = datetime.now() + timedelta(
                seconds=restart_delay_seconds
            )
            script = (
                "@echo off\n"
                f"set PID={os.getpid()}\n"
                'set "APP_EXE=%LOCALAPPDATA%\\XAUUSDCalendarAgent\\XAUUSD Calendar Agent.exe"\n'
                ":wait\n"
                'tasklist /FI "PID eq %PID%" | findstr /I "%PID%" >nul\n'
                "if not errorlevel 1 (\n"
                "  timeout /t 1 /nobreak >nul\n"
                "  goto wait\n"
                ")\n"
                f'start "" /wait "{pending_path}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART\n'
                'if exist "%APP_EXE%" start "" "%APP_EXE%"\n'
                f'del "{pending_path}" >nul 2>&1\n'
                'del "%~f0"\n'
            )
        else:
            script = (
                "@echo off\n"
                f"set PID={os.getpid()}\n"
                ":wait\n"
                'tasklist /FI "PID eq %PID%" | findstr /I "%PID%" >nul\n'
                "if not errorlevel 1 (\n"
                "  timeout /t 1 /nobreak >nul\n"
                "  goto wait\n"
                ")\n"
                f'move /y "{pending_path}" "{exe_path}"\n'
                f'start "" "{exe_path}"\n'
                'del "%~f0"\n'
            )
        script_path.write_text(script, encoding="utf-8")
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        subprocess.Popen(
            ["cmd", "/c", str(script_path)],
            creationflags=creationflags,
        )
        if is_setup:
            threading.Timer(restart_delay_seconds, self._request_exit).start()
        else:
            threading.Timer(0.2, self._request_exit).start()
