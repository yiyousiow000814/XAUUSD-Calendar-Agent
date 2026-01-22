from __future__ import annotations

import base64
import csv
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser
from collections import OrderedDict
from concurrent.futures import ProcessPoolExecutor, TimeoutError
from datetime import datetime, timedelta, timezone
from hashlib import sha1
from pathlib import Path
from typing import Iterable

try:
    import webview
except ImportError:  # pragma: no cover - optional in test/CI environments
    webview = None
from agent.calendar_loader import load_calendar_events
from agent.calendar_update import update_calendar_from_github
from agent.config import (
    get_config_path,
    get_default_repo_path,
    get_github_token,
    get_legacy_config_path,
    get_log_dir,
    get_repo_dir,
    get_selected_output_dir_last_sync_at,
    get_update_dir,
    load_config,
    parse_iso_time,
    save_config,
    set_output_dir_last_sync_at,
    to_display_time,
    to_iso_time,
)
from agent.currency_options import CURRENCY_OPTIONS
from agent.event_history import build_event_canonical_id
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
from agent.scheduler import TASK_NAME, create_startup_task, remove_startup_task
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
AUTO_UPDATE_IDLE_MINUTES = 10
OUTPUT_DIR_MARKER_FILENAME = ".xauusd_calendar_agent_managed_output"
GIT_PID_PREFIX = "repo-clone"


class WebAgentBackend:
    def __init__(self) -> None:
        init_started = time.perf_counter()
        self.state = load_config()
        if not self.state.get("settings_auto_save", True):
            self.state["settings_auto_save"] = True
            save_config(self.state)
        self.logger = setup_logger(self.state.get("debug", False))
        self.logger.info("Backend init started")
        self.tray_supported = False
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
        selected_last_sync_at = get_selected_output_dir_last_sync_at(self.state)
        selected_last_sync = parse_iso_time(selected_last_sync_at)
        self._snapshot_cache: dict = {
            "lastPull": "Not yet",
            "lastSync": to_display_time(selected_last_sync),
            "lastPullAt": self.state.get("last_pull_at", ""),
            "lastSyncAt": selected_last_sync_at,
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
        self._update_install_prepared = False
        self._update_install_script_path: str | None = None
        self._update_install_completed = False
        self._update_install_staging_dir: str | None = None
        self._update_install_started_at: float | None = None
        self._ui_state_lock = threading.Lock()
        self._ui_state_seen_at: datetime | None = None
        self._ui_visible = True
        self._ui_focused = True
        self._ui_last_input_at: datetime | None = None
        self._update_prompted_version = ""
        self._update_prompted_at: datetime | None = None
        self._update_restart_hidden_once = False
        self._event_history_lock = threading.Lock()
        self._event_history_cache: OrderedDict[str, list[dict]] = OrderedDict()
        self._event_history_cache_limit = 60
        self._event_history_index_signature: tuple[tuple[str, float, int], ...] = ()
        self._temporary_path_task_lock = threading.Lock()
        self._temporary_path_task_active = False
        self._temporary_path_task_phase = "idle"
        self._temporary_path_task_progress = 0.0
        self._temporary_path_task_message = ""
        self._temporary_path_task_path = ""
        self._temporary_path_last_notice_ts: float | None = None
        self._temporary_path_task_cancel_event: threading.Event | None = None
        self._temporary_path_git_pid: int | None = None
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
        self._ensure_startup_task_command()
        self._cleanup_stale_update_staging()
        self.logger.info(
            "Backend init complete in %.0fms",
            (time.perf_counter() - init_started) * 1000,
        )

    def set_tray_supported(self, supported: bool) -> None:
        # Runtime capability; do not persist to config.json.
        self.tray_supported = bool(supported)

    def set_ui_state(self, payload: dict | None = None) -> dict:
        """
        Frontend heartbeat so the backend can decide whether it's safe to auto-update.
        Payload times use epoch milliseconds.
        """
        if payload is None:
            payload = {}
        now = datetime.now()
        with self._ui_state_lock:
            self._ui_state_seen_at = now
            if "visible" in payload:
                self._ui_visible = bool(payload.get("visible", True))
            if "focused" in payload:
                self._ui_focused = bool(payload.get("focused", True))
            last_input_ms = payload.get("lastInputAt")
            if isinstance(last_input_ms, (int, float)) and last_input_ms > 0:
                try:
                    self._ui_last_input_at = datetime.fromtimestamp(
                        float(last_input_ms) / 1000.0
                    )
                except (OSError, ValueError):
                    self._ui_last_input_at = None
        return {"ok": True}

    def _ensure_startup_task_command(self) -> None:
        """
        Ensure the Windows Run entry is updated to the current start command.

        Existing installs may have a Run entry without `--autostart`, so the user's
        autostart launch preference would not apply until the entry is rewritten.
        """
        if not sys.platform.startswith("win") or not winreg:
            return
        if not bool(self.state.get("run_on_startup", True)):
            return
        expected = self._build_start_command().strip()
        if not expected:
            return
        current = ""
        try:
            with winreg.OpenKey(  # type: ignore[attr-defined]
                winreg.HKEY_CURRENT_USER,  # type: ignore[attr-defined]
                r"Software\Microsoft\Windows\CurrentVersion\Run",
                0,
                winreg.KEY_READ,  # type: ignore[attr-defined]
            ) as key:
                value, _kind = winreg.QueryValueEx(key, TASK_NAME)  # type: ignore[attr-defined]
                current = str(value or "").strip()
        except FileNotFoundError:
            current = ""
        except OSError as exc:
            # Avoid failing startup just because the registry cannot be read.
            self.logger.warning("Startup entry read failed: %s", exc)
            return
        if current == expected:
            return
        result = create_startup_task(expected)
        if not result.ok:
            self._append_notice(f"{result.message}: {result.output}", level="WARN")

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
        selected_last_sync_at = get_selected_output_dir_last_sync_at(self.state)
        last_sync = parse_iso_time(selected_last_sync_at)
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
            "lastSyncAt": selected_last_sync_at,
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

    def get_event_history(self, payload: dict | None = None) -> dict:
        payload = payload or {}
        event_name = (payload.get("event") or "").strip()
        cur = (payload.get("cur") or "").strip()
        if not event_name:
            return {"ok": False, "message": "Missing event name"}

        event_id, identity = build_event_canonical_id(cur, event_name)
        repo_path = self._resolve_calendar_repo_path() or self._get_main_repo_path()
        if not repo_path:
            return {"ok": False, "message": "Calendar repo path not set"}

        cached = self._get_cached_event_history(event_id)
        if cached is not None:
            return {
                "ok": True,
                "eventId": event_id,
                "metric": identity.metric,
                "frequency": identity.frequency,
                "period": identity.period,
                "cur": cur.upper() or "NA",
                "points": cached,
                "cached": True,
            }

        points = self._collect_event_history_from_index(event_id, repo_path)
        if not points:
            points = self._collect_event_history_from_calendar(event_id, repo_path)
        points = self._apply_previous_fallback(points)
        self._store_event_history_cache(event_id, points)
        return {
            "ok": True,
            "eventId": event_id,
            "metric": identity.metric,
            "frequency": identity.frequency,
            "period": identity.period,
            "cur": cur.upper() or "NA",
            "points": points,
            "cached": False,
        }

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
        tz_mode = (self.state.get("calendar_timezone_mode") or "system").strip().lower()
        if tz_mode not in ("utc", "system"):
            tz_mode = "system"
        manual_offset = clamp_utc_offset_minutes(
            int(self.state.get("calendar_utc_offset_minutes", 0))
        )
        autostart_launch_mode = (
            (self.state.get("autostart_launch_mode") or "tray").strip().lower()
        )
        if autostart_launch_mode not in ("tray", "show"):
            autostart_launch_mode = "tray"
        close_behavior = (self.state.get("close_behavior") or "exit").strip().lower()
        if close_behavior not in ("exit", "tray"):
            close_behavior = "exit"
        return {
            "autoSyncAfterPull": bool(self.state.get("auto_sync_after_pull", True)),
            "autoUpdateEnabled": bool(self.state.get("auto_update_enabled", True)),
            "runOnStartup": bool(self.state.get("run_on_startup", True)),
            "autostartLaunchMode": autostart_launch_mode,
            "closeBehavior": close_behavior,
            "traySupported": bool(getattr(self, "tray_supported", False)),
            "debug": bool(self.state.get("debug", False)),
            "autoSave": True,
            "enableSystemTheme": enable_system_theme,
            "theme": theme_pref,
            "enableTemporaryPath": bool(self.state.get("enable_temporary_path", False)),
            "temporaryPath": self.state.get("temporary_path", ""),
            "repoPath": str(repo_path) if repo_path else "",
            "logPath": str(log_file),
            "splitRatio": split_ratio,
            "removeLogs": True,
            "removeOutput": False,
            "removeTemporaryPaths": True,
            "uninstallConfirm": "",
            "calendarTimezoneMode": tz_mode,
            "calendarUtcOffsetMinutes": manual_offset,
        }

    def get_temporary_path_task(self) -> dict:
        with self._temporary_path_task_lock:
            return {
                "ok": True,
                "active": self._temporary_path_task_active,
                "phase": self._temporary_path_task_phase,
                "progress": float(self._temporary_path_task_progress),
                "message": self._temporary_path_task_message,
                "path": self._temporary_path_task_path,
            }

    def probe_temporary_path(self, payload: dict | None = None) -> dict:
        payload = payload or {}
        enable_temporary_path = bool(
            payload.get(
                "enableTemporaryPath", self.state.get("enable_temporary_path", False)
            )
        )
        raw_path = (
            payload.get("temporaryPath") or self.state.get("temporary_path") or ""
        ).strip()
        auto_start = bool(payload.get("autoStart", True))
        repo_slug = normalize_repo_slug((self.state.get("github_repo") or "").strip())
        if enable_temporary_path and not raw_path:
            raw_path = str(get_repo_dir())
        path = Path(raw_path) if raw_path else None
        probe = self._probe_temporary_path(path, repo_slug, auto_start=auto_start)
        return {"ok": True, **probe}

    def temporary_path_use_as_is(self, payload: dict | None = None) -> dict:
        payload = payload or {}
        raw_path = (
            payload.get("temporaryPath") or self.state.get("temporary_path") or ""
        ).strip()
        repo_slug = normalize_repo_slug((self.state.get("github_repo") or "").strip())
        if not raw_path:
            return {"ok": False, "message": "Temporary Path is empty"}
        path = Path(raw_path)
        probe = self._probe_temporary_path(path, repo_slug, auto_start=False)
        if not probe.get("canUseAsIs"):
            return {
                "ok": False,
                "message": probe.get("message") or "Temporary Path not usable",
            }
        self._set_temporary_path_confirmation(path, repo_slug, mode="use-as-is")
        self._append_notice("Temporary Path confirmed (use as-is)", level="INFO")
        return {"ok": True}

    def temporary_path_reset(self, payload: dict | None = None) -> dict:
        payload = payload or {}
        raw_path = (
            payload.get("temporaryPath") or self.state.get("temporary_path") or ""
        ).strip()
        repo_slug = normalize_repo_slug((self.state.get("github_repo") or "").strip())
        if not raw_path:
            return {"ok": False, "message": "Temporary Path is empty"}
        if not repo_slug:
            return {"ok": False, "message": "GitHub repo not configured"}
        path = Path(raw_path)
        self._terminate_temporary_path_pid_file(path, reason="Reset & Clone")
        with self._temporary_path_task_lock:
            task_active = self._temporary_path_task_active
        if task_active:
            canceled = self._cancel_temporary_path_task("Reset & Clone requested")
            if canceled:
                deadline = time.time() + 3.0
                while time.time() < deadline:
                    with self._temporary_path_task_lock:
                        active = self._temporary_path_task_active
                    if not active:
                        break
                    time.sleep(0.05)
                with self._temporary_path_task_lock:
                    if self._temporary_path_task_active:
                        return {
                            "ok": False,
                            "message": "Unable to stop existing Temporary Path operation; please retry",
                        }
        probe = self._probe_temporary_path(path, repo_slug, auto_start=False)
        if not probe.get("canReset"):
            return {"ok": False, "message": probe.get("message") or "Reset not allowed"}
        started = self._start_temporary_path_clone(path, repo_slug, reset_first=True)
        if not started:
            return {"ok": False, "message": "Temporary Path operation already running"}
        return {"ok": True}

    def _terminate_temporary_path_pid_file(self, path: Path, reason: str) -> None:
        pid_files = self._temporary_path_pid_files(path)
        if not pid_files:
            return

        stopped: list[int] = []
        for pid_path in pid_files:
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
                stopped.append(pid)
            try:
                pid_path.unlink(missing_ok=True)
            except OSError:
                pass

        if stopped:
            self._append_notice(
                f"Stopped previous git clone process (pid file): {stopped[0]} ({reason})",
                level="WARN",
            )

    def _temporary_path_pid_suffix(self, path: Path) -> str:
        resolved = str(self._safe_resolve(path))
        digest = sha1(resolved.encode("utf-8", errors="ignore")).hexdigest()[:16]
        return f"-{digest}.pid"

    def _temporary_path_pid_file(self, path: Path) -> Path:
        # Keep the prefix stable and generic so renames of "Temporary Path" do not
        # require PID file migrations.
        return (
            get_log_dir() / f"{GIT_PID_PREFIX}{self._temporary_path_pid_suffix(path)}"
        )

    def _temporary_path_pid_files(self, path: Path) -> list[Path]:
        # Be prefix-agnostic to remain compatible across renames: any PID file ending
        # with this path digest is considered a match.
        suffix = self._temporary_path_pid_suffix(path)
        log_dir = get_log_dir()
        try:
            return sorted(log_dir.glob(f"*{suffix}"))
        except OSError:
            return []

    def _cancel_temporary_path_task(self, reason: str) -> bool:
        with self._temporary_path_task_lock:
            if not self._temporary_path_task_active:
                return False
            cancel_event = self._temporary_path_task_cancel_event
            pid = self._temporary_path_git_pid
            task_path = self._temporary_path_task_path
            if cancel_event:
                cancel_event.set()
        if task_path:
            try:
                self._terminate_temporary_path_pid_file(
                    Path(task_path), reason=f"Cancel ({reason})"
                )
            except Exception:  # noqa: BLE001
                pass
        if pid:
            try:
                terminate_process_tree(pid)
            except Exception:  # noqa: BLE001
                pass
        self._append_notice(
            f"Temporary Path operation canceled: {reason}", level="WARN"
        )
        return True

    def save_settings(self, payload: dict) -> dict:
        previous_debug = bool(self.state.get("debug", False))
        auto_sync = bool(payload.get("autoSyncAfterPull", True))
        auto_update = bool(payload.get("autoUpdateEnabled", True))
        run_on_startup = bool(payload.get("runOnStartup", True))
        autostart_launch_mode = (
            (payload.get("autostartLaunchMode") or "").strip().lower()
        )
        if not autostart_launch_mode:
            autostart_launch_mode = (
                (self.state.get("autostart_launch_mode") or "tray").strip().lower()
            )
        if autostart_launch_mode not in ("tray", "show"):
            autostart_launch_mode = "tray"

        close_behavior = (payload.get("closeBehavior") or "").strip().lower()
        if not close_behavior:
            close_behavior = (
                (self.state.get("close_behavior") or "exit").strip().lower()
            )
        if close_behavior not in ("exit", "tray"):
            close_behavior = "exit"
        debug = bool(payload.get("debug", False))
        auto_save = True
        enable_temporary_path = bool(payload.get("enableTemporaryPath", False))
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
                (self.state.get("calendar_timezone_mode") or "system").strip().lower()
            )
        if tz_mode not in ("utc", "system"):
            tz_mode = "system"
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
        self.state["autostart_launch_mode"] = autostart_launch_mode
        self.state["close_behavior"] = close_behavior
        self.state["debug"] = debug
        self.state["settings_auto_save"] = auto_save
        self.state["theme_preference"] = theme
        self.state["enable_system_theme"] = enable_system_theme
        self.state["enable_temporary_path"] = enable_temporary_path
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
        mode = (self.state.get("calendar_timezone_mode") or "system").strip().lower()
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

    def open_url(self, url: str) -> dict:
        value = (url or "").strip()
        if not value:
            return {"ok": False, "message": "URL is empty"}
        try:
            ok = webbrowser.open(value)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "message": str(exc)}
        if not ok:
            return {"ok": False, "message": "Failed to open URL"}
        return {"ok": True}

    def open_release_notes(self) -> dict:
        repo = (self.state.get("github_repo") or "").strip()
        if not repo:
            return {"ok": False, "message": "GitHub repo is not configured"}
        version = (self._update_available_version or "").strip()
        if version:
            url = f"https://github.com/{repo}/releases/tag/v{version}"
        else:
            url = f"https://github.com/{repo}/releases"
        return self.open_url(url)

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

    def browse_temporary_path(self) -> dict:
        if not self.window:
            return {"ok": False, "message": "Window not ready"}
        if not webview:
            return {"ok": False, "message": "Webview is not available"}
        start_dir = (self.state.get("temporary_path") or "").strip()
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
        return self.set_temporary_path(path)

    def set_temporary_path(self, path: str) -> dict:
        value = (path or "").strip()
        self.state["temporary_path"] = value
        if value:
            self._ensure_dir(value)
            self._track_path("temporary_path_history", value)
        save_config(self.state)
        return {"ok": True, "path": value}

    def uninstall(self, payload: dict) -> dict:
        confirm = (payload.get("confirm") or "").strip()
        if confirm != "UNINSTALL":
            return {"ok": False, "message": "Confirmation required"}
        remove_logs = bool(payload.get("removeLogs", True))
        remove_output = bool(payload.get("removeOutput", False))
        remove_temporary_paths = bool(payload.get("removeTemporaryPaths", True))

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
                managed_dir = path / "data" / "Economic_Calendar"
                managed_marker = managed_dir / OUTPUT_DIR_MARKER_FILENAME
                legacy_marker = path / OUTPUT_DIR_MARKER_FILENAME
                can_remove = (
                    path.exists()
                    and path.is_dir()
                    and managed_dir.exists()
                    and managed_dir.is_dir()
                    and (managed_marker.is_file() or legacy_marker.is_file())
                    and not self._is_path_root_dir(path)
                )
                if not can_remove:
                    self._append_notice(
                        f"Skipped deleting managed calendar dir (not managed): {output_dir}",
                        level="WARN",
                    )
                else:
                    shutil.rmtree(managed_dir, ignore_errors=True)
                    # Best-effort cleanup of empty parent folders we created.
                    try:
                        parent = managed_dir.parent
                        if (
                            parent.exists()
                            and parent.is_dir()
                            and not any(parent.iterdir())
                        ):
                            parent.rmdir()
                    except OSError:
                        pass

        if remove_temporary_paths:
            self._cleanup_managed_temporary_paths(
                [
                    self.state.get("temporary_path", ""),
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
            "  ping -n 2 127.0.0.1 >nul\r\n"
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

    def _cleanup_managed_temporary_paths(self, paths: Iterable[str]) -> None:
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

    def _request_exit(self, *, force: bool = False) -> None:
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
        if force:
            threading.Timer(1.5, lambda: os._exit(0)).start()

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
        if not webview:
            return {"ok": False, "message": "Webview is not available"}
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
        self._request_snapshot_rebuild("output-dir:browse")
        return {"ok": True, "path": path}

    def set_output_dir(self, path: str) -> dict:
        value = (path or "").strip()
        self.state["output_dir"] = value
        if value:
            self._ensure_dir(value)
            # Marker is written into the managed subdirectory after the first successful sync.
            self._track_path("output_dir_history", value)
        save_config(self.state)
        self._request_snapshot_rebuild("output-dir:set")
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
            if self._update_phase == "installing":
                progress = max(0.0, self._get_install_progress())
            elif self._update_total_bytes and self._update_total_bytes > 0:
                download_progress = min(
                    1.0, self._update_downloaded_bytes / self._update_total_bytes
                )
                progress = max(0.0, min(0.9, download_progress * 0.9))
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
            self._update_install_prepared = False
            self._update_install_script_path = None
            self._update_install_completed = False
            self._update_install_staging_dir = None
            self._update_install_started_at = None
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
            is_downloaded = (
                self._update_phase == "downloaded"
                and bool(self._update_download_target)
                and self._update_install_completed
            )

        if is_downloaded:
            self._update_restart_hidden_once = False
            self._run_task(self._install_update_task, "Install now")
            return {"ok": True}

        if not has_pending:
            result = self._check_updates_task(quiet=True)
            if not result.get("updateAvailable"):
                return {
                    "ok": False,
                    "message": result.get("message") or "No update available",
                }

        self._run_task(
            lambda: self._download_update_task(start_install_on_download=True),
            "Update now",
        )
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
                self._update_install_completed = False
                self._update_install_staging_dir = None
                self._update_install_started_at = None
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
                self._update_install_completed = False
                self._update_install_staging_dir = None
                self._update_install_started_at = None
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
                self._update_install_completed = False
                self._update_install_staging_dir = None
                self._update_install_started_at = None
            return {"ok": True, "message": "Up to date", "updateAvailable": False}

        if not info.download_url:
            with self._update_lock:
                self._update_phase = "idle"
                self._update_message = "Release missing download URL"
                self._update_install_completed = False
                self._update_install_staging_dir = None
                self._update_install_started_at = None
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

    def _download_update_task(self, start_install_on_download: bool = False) -> None:
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
            self._update_install_prepared = False
            self._update_install_script_path = None
            self._update_install_completed = False
            self._update_install_staging_dir = None
            self._update_install_started_at = None

        def on_progress(downloaded: int, total: int | None) -> None:
            with self._update_lock:
                self._update_downloaded_bytes = downloaded
                self._update_total_bytes = total

        self._append_notice(f"Downloading update {version}", level="INFO")
        self.logger.info("Update download url: %s", download_url)
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

        self.logger.info("Update downloaded to: %s", target)
        self._append_notice("Update downloaded", level="INFO")
        install_result = "skipped"
        if start_install_on_download:
            install_result = self._run_background_install(Path(target))
        if install_result == "done":
            with self._update_lock:
                staging_dir = self._update_install_staging_dir
            if not staging_dir:
                with self._update_lock:
                    self._update_in_progress = False
                    self._update_phase = "error"
                    self._update_message = "Install failed (staging missing)"
                self._append_notice(
                    "Update install failed: staging missing", level="ERROR"
                )
                return
            with self._update_lock:
                self._update_phase = "downloaded"
                self._update_message = "Install complete"
                self._update_download_target = str(target)
                self._update_in_progress = False
                self._update_install_completed = True
            self._append_notice("Update installed, ready to restart", level="INFO")
        elif install_result == "failed":
            return
        else:
            with self._update_lock:
                self._update_phase = "downloaded"
                self._update_message = "Download complete"
                self._update_download_target = str(target)
                self._update_in_progress = False
            self._append_notice("Update downloaded, ready to install", level="INFO")

    def _read_exe_version(self, exe_path: Path) -> str:
        try:
            command = [
                "powershell",
                "-NoProfile",
                "-Command",
                f"(Get-Item '{exe_path}').VersionInfo.FileVersion",
            ]
            creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
            output = subprocess.check_output(
                command,
                text=True,
                stderr=subprocess.DEVNULL,
                creationflags=creationflags,
            )
            return (output or "").strip().splitlines()[0]
        except Exception:  # noqa: BLE001
            return ""

    def _get_install_progress(self) -> float:
        started_at = self._update_install_started_at
        if not started_at:
            return 0.9
        elapsed = max(0.0, time.time() - started_at)
        ramp = min(1.0, elapsed / 12.0)
        return min(0.98, 0.9 + ramp * 0.08)

    def _sanitize_update_label(self, value: str) -> str:
        cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", value or "").strip("._-")
        return cleaned or "update"

    def _get_update_staging_root(self, version: str) -> Path:
        base = os.environ.get("LOCALAPPDATA")
        if not base:
            base = str(Path.home() / "AppData" / "Local")
        root = Path(base) / "XAUUSDCalendarAgent-staged"
        label = self._sanitize_update_label(version)
        return root / f"stage_{label}_{os.getpid()}"

    def _cleanup_stale_update_staging(self) -> None:
        if not sys.platform.startswith("win"):
            return
        base = os.environ.get("LOCALAPPDATA")
        if not base:
            base = str(Path.home() / "AppData" / "Local")
        root = Path(base) / "XAUUSDCalendarAgent-staged"

        def runner() -> None:
            if not root.exists():
                return
            try:
                items = list(root.iterdir())
            except OSError:
                return
            stale_dirs = [p for p in items if p.is_dir()]
            stale_files = [p for p in items if p.is_file()]
            for stale_file in stale_files:
                try:
                    stale_file.unlink()
                except OSError:
                    continue
            if not stale_dirs:
                try:
                    if not any(root.iterdir()):
                        root.rmdir()
                except OSError:
                    return
                return
            removed_any = False
            for stage_dir in stale_dirs:
                try:
                    shutil.rmtree(stage_dir)
                    removed_any = True
                except OSError:
                    continue
            if removed_any:
                try:
                    if not any(root.iterdir()):
                        root.rmdir()
                except OSError:
                    return

        threading.Thread(target=runner, daemon=True).start()

    def _run_background_install(self, pending_path: Path) -> str:
        asset_name = (self.state.get("github_release_asset_name") or "").lower()
        is_setup = asset_name == "setup.exe" or asset_name.startswith("setup")
        if not is_setup:
            return "skipped"
        with self._update_lock:
            expected_version = self._update_available_version
            self._update_phase = "installing"
            self._update_message = "Installing..."
            self._update_download_target = str(pending_path)
            self._update_install_started_at = time.time()
        log_path = pending_path.parent / f"update_setup_{os.getpid()}.log"
        staging_root = self._get_update_staging_root(expected_version or "update")
        try:
            if staging_root.exists():
                shutil.rmtree(staging_root)
            staging_root.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            with self._update_lock:
                self._update_in_progress = False
                self._update_phase = "error"
                self._update_message = f"Install failed: {exc}. Log: {log_path}"
                self._update_install_started_at = None
            self._append_notice(
                f"Update install failed: {exc}. Log: {log_path}", level="ERROR"
            )
            return "failed"
        args = [
            str(pending_path),
            "/VERYSILENT",
            "/SUPPRESSMSGBOXES",
            "/NORESTART",
            "/NOCLOSEAPPLICATIONS",
            f"/DIR={staging_root}",
            f"/LOG={log_path}",
        ]
        self._append_notice("Installing update in background…", level="INFO")
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        try:
            result = subprocess.run(
                args,
                check=False,
                creationflags=creationflags,
            )
        except Exception as exc:  # noqa: BLE001
            with self._update_lock:
                self._update_in_progress = False
                self._update_phase = "error"
                self._update_message = f"Install failed: {exc}. Log: {log_path}"
            self._append_notice(
                f"Update install failed: {exc}. Log: {log_path}", level="ERROR"
            )
            return "failed"
        if result.returncode != 0:
            with self._update_lock:
                self._update_in_progress = False
                self._update_phase = "error"
                self._update_message = (
                    f"Install failed (exit {result.returncode}). Log: {log_path}"
                )
                self._update_install_started_at = None
            self._append_notice(
                f"Update install failed (exit {result.returncode}). Log: {log_path}",
                level="ERROR",
            )
            return "failed"
        staged_exe = staging_root / "XAUUSD Calendar Agent.exe"
        if not staged_exe.exists():
            with self._update_lock:
                self._update_in_progress = False
                self._update_phase = "error"
                self._update_message = f"Installed exe missing. Log: {log_path}"
                self._update_install_started_at = None
            self._append_notice(
                f"Update install failed (staged exe missing). Log: {log_path}",
                level="ERROR",
            )
            return "failed"
        if expected_version:
            installed_version = self._read_exe_version(staged_exe)
            if installed_version and expected_version not in installed_version:
                with self._update_lock:
                    self._update_in_progress = False
                    self._update_phase = "error"
                    self._update_message = f"Install version mismatch. Log: {log_path}"
                    self._update_install_started_at = None
                self._append_notice(
                    f"Update install version mismatch. Log: {log_path}",
                    level="ERROR",
                )
                return "failed"
        with self._update_lock:
            self._update_install_staging_dir = str(staging_root)
            self._update_install_started_at = None
        return "done"

    def _restart_after_update(self) -> None:
        exe_path = Path(sys.executable)
        launch_args = " --start-hidden" if self._update_restart_hidden_once else ""
        script_path = get_update_dir() / f"restart_app_{os.getpid()}.cmd"
        script = (
            "@echo off\n"
            f"set PID={os.getpid()}\n"
            ":wait\n"
            'tasklist /FI "PID eq %PID%" | findstr /I "%PID%" >nul\n'
            "if not errorlevel 1 (\n"
            "  ping -n 2 127.0.0.1 >nul\n"
            "  goto wait\n"
            ")\n"
            f'start "" "{exe_path}"{launch_args}\n'
            'del "%~f0"\n'
        )
        script_path.write_text(script, encoding="utf-8")
        self.logger.info("Restart script ready: %s", script_path)
        self._launch_hidden_script(script_path, "Restart")
        restart_delay_seconds = 3
        self._restart_deadline = datetime.now() + timedelta(
            seconds=restart_delay_seconds
        )
        threading.Timer(
            restart_delay_seconds, lambda: self._request_exit(force=True)
        ).start()

    def _apply_staged_update(
        self, staging_root: Path, setup_exe_path: Path | None
    ) -> None:
        if not getattr(sys, "frozen", False):
            self._append_notice(
                "Auto update is available only in the EXE build", level="WARN"
            )
            return
        exe_path = Path(sys.executable).resolve()
        install_dir = exe_path.parent
        stage_root = staging_root.resolve()
        launch_args = " --start-hidden" if self._update_restart_hidden_once else ""
        stage_parent = stage_root.parent
        log_path = (
            Path(tempfile.gettempdir()) / f"xauusd_update_switch_{os.getpid()}.log"
        )
        script_path = (
            Path(tempfile.gettempdir()) / f"apply_staged_update_{os.getpid()}.cmd"
        )
        backup_dir = stage_parent / f"backup_{os.getpid()}"
        user_data_backup = stage_parent / f"user_data_{os.getpid()}"
        app_id = "3F6B2F3A-2A0F-4A93-9C5D-7E1D1C7F7D0E"
        script = self._build_staged_update_script(
            stage_root,
            install_dir,
            backup_dir,
            user_data_backup,
            log_path,
            app_id,
            launch_args,
            os.getpid(),
            setup_exe_path,
        )
        script_path.write_text(script, encoding="utf-8")
        self.logger.info("Staged update script ready: %s", script_path)
        self._launch_hidden_script(script_path, "Staged update")
        restart_delay_seconds = 3
        self._restart_deadline = datetime.now() + timedelta(
            seconds=restart_delay_seconds
        )
        threading.Timer(
            restart_delay_seconds, lambda: self._request_exit(force=True)
        ).start()

    @staticmethod
    def _build_staged_update_script(
        stage_root: Path,
        install_dir: Path,
        backup_dir: Path,
        user_data_backup: Path,
        log_path: Path,
        app_id: str,
        launch_args: str,
        pid: int,
        setup_exe_path: Path | None,
    ) -> str:
        setup_exe = str(setup_exe_path) if setup_exe_path else ""
        shortcut_script = (
            "$ErrorActionPreference = 'Stop'\n"
            "$s = New-Object -ComObject WScript.Shell\n"
            "$desk = if ($env:TEST_DESKTOP_DIR) { $env:TEST_DESKTOP_DIR } else "
            "{ [Environment]::GetFolderPath('Desktop') }\n"
            "$start = if ($env:TEST_START_MENU_DIR) { $env:TEST_START_MENU_DIR } else "
            "{ [Environment]::GetFolderPath('Programs') }\n"
            "$targets = @(\n"
            "  (Join-Path $desk 'XAUUSD Calendar Agent.lnk'),\n"
            "  (Join-Path $start 'XAUUSD Calendar Agent\\XAUUSD Calendar Agent.lnk')\n"
            ")\n"
            "foreach ($p in $targets) {\n"
            "  $dir = Split-Path $p\n"
            "  if (!(Test-Path $dir)) {\n"
            "    New-Item -ItemType Directory -Force -Path $dir | Out-Null\n"
            "  }\n"
            "  $lnk = $s.CreateShortcut($p)\n"
            "  $lnk.TargetPath = $env:APP_EXE\n"
            "  $lnk.IconLocation = $env:APP_EXE\n"
            "  $lnk.WorkingDirectory = $env:INSTALL_DIR\n"
            "  $lnk.Save()\n"
            "}\n"
        )
        encoded_shortcut_script = base64.b64encode(
            shortcut_script.encode("utf-16le")
        ).decode("ascii")
        return (
            "@echo off\n"
            f"set PID={pid}\n"
            f'set "STAGE_DIR={stage_root}"\n'
            f'set "INSTALL_DIR={install_dir}"\n'
            f'set "BACKUP_DIR={backup_dir}"\n'
            f'set "USER_DATA_BACKUP={user_data_backup}"\n'
            f'set "LOG_PATH={log_path}"\n'
            f'set "UNINSTALL_KEY=HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{{{app_id}}}_is1"\n'
            'set "RESULT=0"\n'
            'set "MIRROR_OK=0"\n'
            f'set "SETUP_EXE={setup_exe}"\n'
            'set "APP_EXE=%INSTALL_DIR%\\XAUUSD Calendar Agent.exe"\n'
            'set "APP_EXE_BACKUP=%BACKUP_DIR%\\XAUUSD Calendar Agent.exe"\n'
            'set "LAUNCH_EXE="\n'
            'set "EXE_NAME=XAUUSD Calendar Agent.exe"\n'
            'set "LEGACY_EXE=Agent.exe"\n'
            ":wait\n"
            'tasklist /FI "PID eq %PID%" | findstr /I "%PID%" >nul\n'
            "if not errorlevel 1 (\n"
            "  ping -n 2 127.0.0.1 >nul\n"
            "  goto wait\n"
            ")\n"
            'taskkill /F /IM "%EXE_NAME%" /T >nul 2>&1\n'
            'taskkill /F /IM "%LEGACY_EXE%" /T >nul 2>&1\n'
            "for /l %%i in (1,1,10) do (\n"
            '  tasklist /FI "IMAGENAME eq %EXE_NAME%" | findstr /I "%EXE_NAME%" >nul\n'
            "  if errorlevel 1 (\n"
            '    tasklist /FI "IMAGENAME eq %LEGACY_EXE%" | findstr /I "%LEGACY_EXE%" >nul\n'
            "    if errorlevel 1 goto ready\n"
            "  )\n"
            "  ping -n 2 127.0.0.1 >nul\n"
            ")\n"
            ":ready\n"
            'if not exist "%STAGE_DIR%\\XAUUSD Calendar Agent.exe" (\n'
            '  set "RESULT=1"\n'
            '  echo Staged exe missing>>"%LOG_PATH%"\n'
            "  goto cleanup\n"
            ")\n"
            'set "MOVED_USERDATA=1"\n'
            'if exist "%INSTALL_DIR%\\user-data" (\n'
            '  set "MOVED_USERDATA=0"\n'
            "  for /l %%i in (1,1,5) do (\n"
            '    move /y "%INSTALL_DIR%\\user-data" "%USER_DATA_BACKUP%" >nul\n'
            "    if not errorlevel 1 (\n"
            '      set "MOVED_USERDATA=1"\n'
            "      goto moved_user_data\n"
            "    )\n"
            "    ping -n 2 127.0.0.1 >nul\n"
            "  )\n"
            ")\n"
            ":moved_user_data\n"
            'if "%MOVED_USERDATA%"=="0" (\n'
            '  set "RESULT=1"\n'
            '  echo Failed to move user-data>>"%LOG_PATH%"\n'
            "  goto restore\n"
            ")\n"
            'if "%SIMULATE_MOVE_FAIL%"=="1" (\n'
            "  goto mirror_stage\n"
            ")\n"
            'set "MOVED_INSTALL=0"\n'
            "for /l %%i in (1,1,5) do (\n"
            '  if not exist "%INSTALL_DIR%" (\n'
            '    set "MOVED_INSTALL=1"\n'
            "    goto moved_install\n"
            "  )\n"
            '  move /y "%INSTALL_DIR%" "%BACKUP_DIR%" >nul\n'
            "  if not errorlevel 1 (\n"
            '    set "MOVED_INSTALL=1"\n'
            "    goto moved_install\n"
            "  )\n"
            "  ping -n 2 127.0.0.1 >nul\n"
            ")\n"
            ":moved_install\n"
            'if "%MOVED_INSTALL%"=="0" (\n'
            '  echo Failed to move current install>>"%LOG_PATH%"\n'
            "  goto mirror_stage\n"
            ")\n"
            'set "MOVED_STAGE=0"\n'
            "for /l %%i in (1,1,5) do (\n"
            '  move /y "%STAGE_DIR%" "%INSTALL_DIR%" >nul\n'
            "  if not errorlevel 1 (\n"
            '    set "MOVED_STAGE=1"\n'
            "    goto moved_stage\n"
            "  )\n"
            "  ping -n 2 127.0.0.1 >nul\n"
            ")\n"
            ":moved_stage\n"
            'if "%MOVED_STAGE%"=="0" (\n'
            '  set "RESULT=1"\n'
            '  echo Failed to move staged install>>"%LOG_PATH%"\n'
            "  goto restore\n"
            ")\n"
            "goto after_swap\n"
            ":mirror_stage\n"
            'set "MIRROR_OK=0"\n'
            "for /l %%i in (1,1,3) do (\n"
            '  robocopy "%STAGE_DIR%" "%INSTALL_DIR%" /MIR /NFL /NDL /NJH /NJS /NC /NS >nul\n'
            "  if errorlevel 8 (\n"
            "    ping -n 2 127.0.0.1 >nul\n"
            "  ) else (\n"
            '    set "MIRROR_OK=1"\n'
            "    goto mirror_done\n"
            "  )\n"
            ")\n"
            ":mirror_done\n"
            'if "%MIRROR_OK%"=="1" (\n'
            '  echo MIRROR_SWAP_OK>>"%LOG_PATH%"\n'
            "  goto after_swap\n"
            ")\n"
            'set "RESULT=1"\n'
            'echo MIRROR_SWAP_FAILED>>"%LOG_PATH%"\n'
            "goto restore\n"
            ":after_swap\n"
            'if exist "%USER_DATA_BACKUP%" (\n'
            '  if exist "%INSTALL_DIR%\\user-data" (\n'
            '    robocopy "%USER_DATA_BACKUP%" "%INSTALL_DIR%\\user-data" /E /MOVE /NFL /NDL /NJH /NJS /NC /NS >nul\n'
            '    rmdir /s /q "%USER_DATA_BACKUP%" >nul 2>&1\n'
            "  ) else (\n"
            '    move /y "%USER_DATA_BACKUP%" "%INSTALL_DIR%\\user-data" >nul\n'
            "  )\n"
            ")\n"
            'reg add "%UNINSTALL_KEY%" /v "InstallLocation" /t REG_SZ /d "%INSTALL_DIR%" /f >nul\n'
            'reg add "%UNINSTALL_KEY%" /v "DisplayIcon" /t REG_SZ /d "%APP_EXE%" /f >nul\n'
            'reg add "%UNINSTALL_KEY%" /v "UninstallString" /t REG_SZ /d ""%INSTALL_DIR%\\unins000.exe"" /f >nul\n'
            'reg add "%UNINSTALL_KEY%" /v "QuietUninstallString" /t REG_SZ /d ""%INSTALL_DIR%\\unins000.exe" '
            '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART" /f >nul\n'
            'if not "%SETUP_EXE%"=="" if exist "%SETUP_EXE%" (\n'
            '  set "REPAIR_LOG=%LOG_PATH%.repair.log"\n'
            '  start "" /wait "%SETUP_EXE%" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART '
            '/NOCLOSEAPPLICATIONS /DIR="%INSTALL_DIR%" /LOG="%REPAIR_LOG%"\n'
            "  if errorlevel 1 (\n"
            '    echo REPAIR_FAILED>>"%LOG_PATH%"\n'
            "  ) else (\n"
            '    echo REPAIR_OK>>"%LOG_PATH%"\n'
            "  )\n"
            ")\n"
            'set "LAUNCH_EXE=%APP_EXE%"\n'
            "goto launch\n"
            ":restore\n"
            'if exist "%BACKUP_DIR%" (\n'
            '  move /y "%BACKUP_DIR%" "%INSTALL_DIR%" >nul\n'
            ")\n"
            'if exist "%USER_DATA_BACKUP%" (\n'
            '  if exist "%INSTALL_DIR%\\user-data" (\n'
            '    robocopy "%USER_DATA_BACKUP%" "%INSTALL_DIR%\\user-data" /E /MOVE /NFL /NDL /NJH /NJS /NC /NS >nul\n'
            '    rmdir /s /q "%USER_DATA_BACKUP%" >nul 2>&1\n'
            "  ) else (\n"
            '    move /y "%USER_DATA_BACKUP%" "%INSTALL_DIR%\\user-data" >nul\n'
            "  )\n"
            ")\n"
            'if exist "%APP_EXE%" (\n'
            '  set "LAUNCH_EXE=%APP_EXE%"\n'
            ') else if exist "%APP_EXE_BACKUP%" (\n'
            '  set "LAUNCH_EXE=%APP_EXE_BACKUP%"\n'
            ")\n"
            ":launch\n"
            'if not "%LAUNCH_EXE%"=="" start "" "%LAUNCH_EXE%"' + launch_args + "\n"
            'echo APP_EXE=%APP_EXE%>>"%LOG_PATH%"\n'
            'echo INSTALL_DIR=%INSTALL_DIR%>>"%LOG_PATH%"\n'
            'echo TEST_DESKTOP_DIR=%TEST_DESKTOP_DIR%>>"%LOG_PATH%"\n'
            'echo TEST_START_MENU_DIR=%TEST_START_MENU_DIR%>>"%LOG_PATH%"\n'
            "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand "
            + encoded_shortcut_script
            + " >nul 2>&1\n"
            "if errorlevel 1 (\n"
            '  set "RESULT=1"\n'
            '  echo SHORTCUTS_FAILED>>"%LOG_PATH%"\n'
            ") else (\n"
            '  echo SHORTCUTS_UPDATED>>"%LOG_PATH%"\n'
            ")\n"
            ":cleanup\n"
            'if exist "%STAGE_DIR%" (\n'
            "  for /l %%i in (1,1,3) do (\n"
            '    rmdir /s /q "%STAGE_DIR%" >nul 2>&1\n'
            '    if not exist "%STAGE_DIR%" goto stage_removed\n'
            "    ping -n 2 127.0.0.1 >nul\n"
            "  )\n"
            '  if exist "%STAGE_DIR%" (\n'
            "    powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass "
            '-Command "Start-Sleep -Seconds 3; '
            "$p=$env:STAGE_DIR; if (Test-Path $p) { "
            'Remove-Item -Recurse -Force -LiteralPath $p }" >nul 2>&1\n'
            '    echo STAGE_DIR_PENDING>>"%LOG_PATH%"\n'
            "  ) else (\n"
            '    echo STAGE_DIR_REMOVED>>"%LOG_PATH%"\n'
            "  )\n"
            "  goto stage_cleanup_done\n"
            ")\n"
            ":stage_removed\n"
            'echo STAGE_DIR_REMOVED>>"%LOG_PATH%"\n'
            ":stage_cleanup_done\n"
            'if exist "%BACKUP_DIR%" (\n'
            "  for /l %%i in (1,1,5) do (\n"
            '    rmdir /s /q "%BACKUP_DIR%" >nul 2>&1\n'
            '    if not exist "%BACKUP_DIR%" goto backup_removed\n'
            "    ping -n 2 127.0.0.1 >nul\n"
            "  )\n"
            '  if exist "%BACKUP_DIR%" (\n'
            "    powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass "
            '-Command "Start-Sleep -Seconds 4; '
            "$p=$env:BACKUP_DIR; if (Test-Path $p) { "
            'Remove-Item -Recurse -Force -LiteralPath $p }" >nul 2>&1\n'
            '    echo BACKUP_DIR_PENDING>>"%LOG_PATH%"\n'
            "  ) else (\n"
            '    echo BACKUP_DIR_REMOVED>>"%LOG_PATH%"\n'
            "  )\n"
            "  goto backup_cleanup_done\n"
            ")\n"
            ":backup_removed\n"
            'echo BACKUP_DIR_REMOVED>>"%LOG_PATH%"\n'
            ":backup_cleanup_done\n"
            ")\n"
            'set "STAGE_PARENT=%STAGE_DIR%\\.."\n'
            "for /l %%i in (1,1,5) do (\n"
            '  if not exist "%STAGE_PARENT%" goto stage_root_done\n'
            '  dir /b /a "%STAGE_PARENT%" 2>nul | findstr /r "." >nul\n'
            "  if errorlevel 1 (\n"
            '    rmdir "%STAGE_PARENT%" >nul 2>&1\n'
            '    if not exist "%STAGE_PARENT%" goto stage_root_removed\n'
            "  )\n"
            "  ping -n 2 127.0.0.1 >nul\n"
            ")\n"
            'if exist "%STAGE_PARENT%" (\n'
            '  echo STAGE_ROOT_NOT_EMPTY>>"%LOG_PATH%"\n'
            "  powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass "
            '-Command "Start-Sleep -Seconds 6; '
            "$p=$env:STAGE_PARENT; "
            "if ($p -and (Test-Path $p)) { "
            "$items = Get-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue; "
            "if (-not $items) { Remove-Item -Force -LiteralPath $p -ErrorAction SilentlyContinue } "
            '}" >nul 2>&1\n'
            '  echo STAGE_ROOT_PENDING>>"%LOG_PATH%"\n'
            ")\n"
            "goto stage_root_done\n"
            ":stage_root_removed\n"
            'echo STAGE_ROOT_REMOVED>>"%LOG_PATH%"\n'
            ":stage_root_done\n"
            'del "%~f0"\n'
            "exit /b %RESULT%\n"
        )

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
            install_ready = self._update_install_completed
            staging_dir = self._update_install_staging_dir

        self._append_notice("Installing update…", level="INFO")
        self.logger.info("Install now target: %s", target)
        if install_ready:
            if not staging_dir:
                with self._update_lock:
                    self._update_in_progress = False
                    self._update_phase = "error"
                    self._update_message = "Install data missing"
                self._append_notice(
                    "Update install failed: staging data missing", level="ERROR"
                )
                return
            self._apply_staged_update(Path(staging_dir), Path(target))
        else:
            self._apply_update_now(Path(target), request_exit=True)

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
        if self.state.get("enable_temporary_path", False):
            sync_value = (self.state.get("temporary_path") or "").strip()
            if sync_value:
                repo_slug = normalize_repo_slug(
                    (self.state.get("github_repo") or "").strip()
                )
                probe = self._probe_temporary_path(
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
        oldest_needed_year = (now - timedelta(days=31)).year
        wanted_years = {current_year, current_year + 1, oldest_needed_year}
        candidates = [y for y in years if y in wanted_years]
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
        return list(CURRENCY_OPTIONS)

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
        grace_window = timedelta(minutes=3)
        selected = (currency or "USD").strip().upper()
        if not events:
            return []
        tz = utc_offset_minutes_to_tzinfo(self._effective_calendar_utc_offset_minutes())
        source_tz = utc_offset_minutes_to_tzinfo(CALENDAR_SOURCE_UTC_OFFSET_MINUTES)
        rendered = []
        candidates = [
            event for event in events if isinstance(event.get("dt_utc"), datetime)
        ]
        visible: list[dict] = []
        for event in candidates:
            dt_utc: datetime = event["dt_utc"]
            if dt_utc < now_utc - grace_window:
                continue
            visible.append(event)

        def _sort_key(item: dict) -> tuple[int, float]:
            dt_utc: datetime = item["dt_utc"]
            is_current = dt_utc <= now_utc
            # Current items first (newest first), then upcoming (soonest first).
            return (
                0 if is_current else 1,
                -dt_utc.timestamp() if is_current else dt_utc.timestamp(),
            )

        # Ensure event IDs are unique within the rendered list, even if multiple
        # rows share the same "stable signature" (time/currency/title/etc.).
        seen_event_ids: dict[str, int] = {}

        for event in sorted(visible, key=_sort_key):
            dt_utc: datetime = event["dt_utc"]
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
            is_current = dt_utc <= now_utc and (now_utc - dt_utc) <= grace_window
            # Use a stable signature for React keys (avoid including Actual/Forecast/Previous
            # which can change over time). If duplicates still exist, add a deterministic
            # suffix to keep keys unique.
            raw_id = "|".join(
                [
                    dt_utc.isoformat(),
                    event_currency,
                    (time_label or "").strip(),
                    (importance or "").strip(),
                    (event_name or "").strip(),
                ]
            )
            digest = hashlib.sha1(raw_id.encode("utf-8")).hexdigest()
            seq = seen_event_ids.get(digest, 0) + 1
            seen_event_ids[digest] = seq
            event_id = f"evt-{digest}" if seq == 1 else f"evt-{digest}-{seq}"
            rendered.append(
                {
                    "id": event_id,
                    "state": "current" if is_current else "upcoming",
                    "time": time_text,
                    "cur": event_currency or "--",
                    "impact": importance or "--",
                    "event": event_name,
                    "countdown": (
                        "Current" if is_current else self._format_countdown(dt_utc)
                    ),
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
        max_items = 6000 if selected == "ALL" else 300
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
            if len(rendered) >= max_items:
                break
        return rendered

    def _event_history_index_paths(self, repo_path: Path) -> list[Path]:
        index_dir = repo_path / "data" / "event_history_index"
        if not index_dir.exists():
            return []
        return sorted(index_dir.glob("*_event_history_index.csv"))

    def _event_history_signature(
        self, paths: list[Path]
    ) -> tuple[tuple[str, float, int], ...]:
        signature: list[tuple[str, float, int]] = []
        for path in paths:
            try:
                stat = path.stat()
            except FileNotFoundError:
                continue
            signature.append((str(path), float(stat.st_mtime), int(stat.st_size)))
        return tuple(signature)

    def _refresh_event_history_cache(self, repo_path: Path) -> list[Path]:
        paths = self._event_history_index_paths(repo_path)
        signature = self._event_history_signature(paths)
        with self._event_history_lock:
            if signature != self._event_history_index_signature:
                self._event_history_index_signature = signature
                self._event_history_cache.clear()
        return paths

    @staticmethod
    def _parse_history_date(value: str) -> datetime | None:
        if not value:
            return None
        try:
            return datetime.strptime(value.strip(), "%Y-%m-%d")
        except ValueError:
            return None

    @staticmethod
    def _parse_history_time_minutes(value: str) -> int:
        if not value:
            return 0
        text = value.strip()
        if ":" not in text:
            return 0
        try:
            dt = datetime.strptime(text, "%H:%M")
        except ValueError:
            return 0
        return dt.hour * 60 + dt.minute

    def _collect_event_history_from_index(
        self, event_id: str, repo_path: Path
    ) -> list[dict]:
        paths = self._refresh_event_history_cache(repo_path)
        if not paths:
            return []
        points: list[dict] = []
        for path in paths:
            with path.open("r", encoding="utf-8") as handle:
                reader = csv.DictReader(handle)
                for row in reader:
                    if row.get("EventId") != event_id:
                        continue
                    points.append(
                        {
                            "date": (row.get("Date") or "").strip(),
                            "time": (row.get("Time") or "").strip(),
                            "actual": (row.get("Actual") or "").strip(),
                            "forecast": (row.get("Forecast") or "").strip(),
                            "previous": (row.get("Previous") or "").strip(),
                        }
                    )
        points.sort(
            key=lambda item: (
                self._parse_history_date(item["date"]) or datetime.min,
                self._parse_history_time_minutes(item["time"]),
            )
        )
        return points

    @staticmethod
    def _is_history_value_missing(value: str | None) -> bool:
        if value is None:
            return True
        normalized = value.strip().lower()
        return normalized in {"", "--", "-", "\u2014", "tba", "n/a", "na", "null"}

    def _apply_previous_fallback(self, points: list[dict]) -> list[dict]:
        if not points:
            return points
        last_actual: str | None = None
        for point in points:
            prior_actual = last_actual
            actual = (point.get("actual") or "").strip()
            previous = (point.get("previous") or "").strip()
            if (
                self._is_history_value_missing(previous)
                and prior_actual
                and not self._is_history_value_missing(prior_actual)
            ):
                point["previous"] = prior_actual
            if not self._is_history_value_missing(actual):
                last_actual = actual
        return points

    def _collect_event_history_from_calendar(
        self, event_id: str, repo_path: Path
    ) -> list[dict]:
        calendar_root = repo_path / "data" / "Economic_Calendar"
        if not calendar_root.exists():
            return []
        points: list[dict] = []
        for year_dir in sorted(calendar_root.iterdir()):
            if not year_dir.is_dir():
                continue
            try:
                year = int(year_dir.name)
            except ValueError:
                continue
            json_path = year_dir / f"{year}_calendar.json"
            if not json_path.exists():
                continue
            try:
                payload = json.loads(json_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                continue
            if not isinstance(payload, list):
                continue
            for row in payload:
                if not isinstance(row, dict):
                    continue
                event = (row.get("Event") or "").strip()
                if not event:
                    continue
                cur = (row.get("Cur.") or "").strip()
                row_id, _identity = build_event_canonical_id(cur, event)
                if row_id != event_id:
                    continue
                points.append(
                    {
                        "date": str(row.get("Date") or "").strip(),
                        "time": str(row.get("Time") or "").strip(),
                        "actual": str(row.get("Actual") or "").strip(),
                        "forecast": str(row.get("Forecast") or "").strip(),
                        "previous": str(row.get("Previous") or "").strip(),
                    }
                )
        points.sort(
            key=lambda item: (
                self._parse_history_date(item["date"]) or datetime.min,
                self._parse_history_time_minutes(item["time"]),
            )
        )
        return points

    def _get_cached_event_history(self, event_id: str) -> list[dict] | None:
        with self._event_history_lock:
            cached = self._event_history_cache.get(event_id)
            if cached is None:
                return None
            self._event_history_cache.move_to_end(event_id)
            return list(cached)

    def _store_event_history_cache(self, event_id: str, points: list[dict]) -> None:
        with self._event_history_lock:
            self._event_history_cache[event_id] = list(points)
            self._event_history_cache.move_to_end(event_id)
            while len(self._event_history_cache) > self._event_history_cache_limit:
                self._event_history_cache.popitem(last=False)

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
            return f'"{exe_path}" --autostart'
        python_path = Path(sys.executable)
        script_path = Path(__file__).resolve().parent / "web_app.py"
        return f'"{python_path}" "{script_path}" --autostart'

    def _get_main_repo_path(self) -> Path | None:
        raw = (self.state.get("repo_path") or "").strip()
        return Path(raw) if raw else None

    def _resolve_repo_path(self) -> Path | None:
        enable_temporary_path = bool(self.state.get("enable_temporary_path", False))
        sync_value = (
            self.state.get("temporary_path", "").strip()
            if enable_temporary_path
            else ""
        )
        repo_value = self.state.get("repo_path", "").strip()
        if enable_temporary_path:
            if not sync_value:
                managed = get_repo_dir()
                sync_value = str(managed)
                self.state["temporary_path"] = sync_value
                save_config(self.state)
            repo_slug = normalize_repo_slug(
                (self.state.get("github_repo") or "").strip()
            )
            sync_path = Path(sync_value)
            probe = self._probe_temporary_path(sync_path, repo_slug, auto_start=True)
            if probe.get("ready"):
                return sync_path
            if probe.get("action") == "auto-clone-started":
                self._append_temporary_path_notice_once(
                    "Temporary Path is being prepared (clone in progress).",
                    level="INFO",
                )
            elif probe.get("needsConfirmation"):
                self._append_temporary_path_notice_once(
                    "Temporary Path needs confirmation. Open Settings, then close it to review options.",
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
                enable_temporary_path
                and not (self.state.get("temporary_path") or "").strip()
            ):
                self.state["temporary_path"] = str(managed)
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

    def _append_temporary_path_notice_once(
        self, message: str, level: str = "INFO"
    ) -> None:
        now = time.time()
        if (
            self._temporary_path_last_notice_ts
            and now - self._temporary_path_last_notice_ts < 20
        ):
            return
        self._temporary_path_last_notice_ts = now
        self._append_notice(message, level=level)

    @staticmethod
    def _safe_resolve(path: Path) -> Path:
        try:
            return path.resolve(strict=False)
        except Exception:  # noqa: BLE001
            return path

    def _is_safe_temporary_path_target(self, path: Path) -> bool:
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

    def _is_temporary_path_confirmed(self, path: Path, repo_slug: str) -> bool:
        confirmed_path = (self.state.get("temporary_path_confirmed_path") or "").strip()
        confirmed_repo = (
            (self.state.get("temporary_path_confirmed_repo") or "").strip().lower()
        )
        confirmed_mode = (
            (self.state.get("temporary_path_confirmed_mode") or "").strip().lower()
        )
        if not confirmed_path or not confirmed_repo or not confirmed_mode:
            return False
        if confirmed_repo != (repo_slug or "").strip().lower():
            return False
        resolved = str(self._safe_resolve(path))
        return resolved == confirmed_path and confirmed_mode in ("use-as-is", "reset")

    def _set_temporary_path_confirmation(
        self, path: Path, repo_slug: str, mode: str
    ) -> None:
        self.state["temporary_path_confirmed_path"] = str(self._safe_resolve(path))
        self.state["temporary_path_confirmed_repo"] = (repo_slug or "").strip().lower()
        self.state["temporary_path_confirmed_mode"] = (mode or "").strip().lower()
        self.state["temporary_path_confirmed_at"] = to_iso_time(datetime.now())
        save_config(self.state)

    def _probe_temporary_path(
        self, path: Path | None, repo_slug: str, auto_start: bool
    ) -> dict:
        with self._temporary_path_task_lock:
            task_active = self._temporary_path_task_active
            task_path = self._temporary_path_task_path
        if not path:
            return {
                "status": "disabled",
                "ready": False,
                "needsConfirmation": False,
                "canUseAsIs": False,
                "canReset": False,
                "path": "",
                "message": "Temporary Path disabled",
                "taskActive": task_active,
                "taskPath": task_path,
            }
        resolved = str(self._safe_resolve(path))
        can_reset = self._is_safe_temporary_path_target(path)
        expected_repo = (repo_slug or "").strip().lower()
        if not can_reset:
            return {
                "status": "unsafe",
                "ready": False,
                "needsConfirmation": True,
                "canUseAsIs": False,
                "canReset": False,
                "path": resolved,
                "message": "Temporary Path overlaps Main Path. Choose a separate folder.",
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
                "message": "Temporary Path operation in progress",
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
                "message": "Temporary Path is not a folder",
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
                        message = "Git repo detected, but origin does not match the configured Temporary Path repo"
                        needs_confirmation = True
                        details["origin"] = origin_slug.output.strip()
                        details["expectedRepo"] = expected_repo
                    else:
                        # Origin matches the configured repo. Ensure this folder is actually
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
                            message = "Temporary Path is missing calendar data"
                        else:
                            status_out = get_status_porcelain(path)
                            if not status_out.ok:
                                status = "git-unusable"
                                message = "Git repo detected, but status cannot be read"
                                details["error"] = status_out.output
                            elif has_legacy_temp or status_out.output.strip():
                                status = "git-not-clean"
                                message = "Temporary Path contains extra files"
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
                                    message = "Temporary Path is not on branch main"
                                else:
                                    status = "git-expected-usable"
                                    message = "Existing Temporary Path looks usable"
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
            and self._is_temporary_path_confirmed(path, expected_repo)
        ):
            needs_confirmation = False
            ready = True
            can_use_as_is = True
            message = "Temporary Path confirmed and ready"

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
            started = self._start_temporary_path_clone(
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

    def _start_temporary_path_clone(
        self, path: Path, repo_slug: str, reset_first: bool
    ) -> bool:
        cancel_event = threading.Event()
        with self._temporary_path_task_lock:
            if self._temporary_path_task_active:
                return False
            self._temporary_path_task_active = True
            self._temporary_path_task_phase = "resetting" if reset_first else "cloning"
            self._temporary_path_task_progress = 0.0
            self._temporary_path_task_message = "Preparing Temporary Path"
            self._temporary_path_task_path = str(self._safe_resolve(path))
            self._temporary_path_task_cancel_event = cancel_event
            self._temporary_path_git_pid = None

        repo_url = f"https://github.com/{repo_slug}.git"

        def runner() -> None:
            try:
                resolved = Path(self._temporary_path_task_path)
                pid_file = self._temporary_path_pid_file(resolved)
                last_clear_failures: list[str] = []
                if cancel_event.is_set():
                    self._update_temporary_path_task("error", 0.0, "Canceled")
                    return
                if not self._is_safe_temporary_path_target(resolved):
                    self._append_notice(
                        "Reset/clone blocked: target path is not allowed", level="ERROR"
                    )
                    self._update_temporary_path_task(
                        "error", 0.0, "Unsafe Temporary Path"
                    )
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
                    self._append_notice("Temporary Path reset started", level="WARN")
                    self._update_temporary_path_task(
                        "resetting", 0.05, "Clearing Temporary Path folder"
                    )
                else:
                    self._append_notice("Temporary Path clone started", level="INFO")

                try:
                    resolved.parent.mkdir(parents=True, exist_ok=True)
                    resolved.mkdir(parents=True, exist_ok=True)
                except Exception as exc:  # noqa: BLE001
                    self._append_notice(
                        f"Temporary Path clone failed: {exc}", level="ERROR"
                    )
                    self._update_temporary_path_task("error", 0.0, "Clone failed")
                    return

                if cancel_event.is_set():
                    self._update_temporary_path_task("error", 0.0, "Canceled")
                    return

                if reset_first:
                    self._terminate_temporary_path_pid_file(
                        resolved, reason="Reset & Clone"
                    )
                    ok = clear_dir_contents_strict(resolved)
                    if not ok:
                        kill_result = terminate_git_clone_processes_by_repo_url(
                            repo_url
                        )
                        if kill_result.ok and (kill_result.output or "").startswith(
                            "killed="
                        ):
                            self._append_notice(
                                f"Stopped git clone processes for Temporary Path: {kill_result.output}",
                                level="WARN",
                            )
                        ok = clear_dir_contents_strict(resolved, attempts=8)
                    if not ok:
                        sample = ", ".join(last_clear_failures[:3])
                        if sample:
                            self._append_notice(
                                f"Temporary Path reset failed (examples still locked): {sample}",
                                level="ERROR",
                            )
                        self._append_notice(
                            "Temporary Path reset failed: folder is in use. Close any apps using it and try again.",
                            level="ERROR",
                        )
                        self._update_temporary_path_task(
                            "error", 0.0, "Folder is in use"
                        )
                        return

                self._update_temporary_path_task("cloning", 0.1, "Cloning repo")

                def on_progress(percent: int, line: str) -> None:
                    progress = 0.1 + (max(0, min(100, percent)) / 100.0) * 0.85
                    self._update_temporary_path_task("cloning", progress, "Cloning...")

                def on_process(process: subprocess.Popen) -> None:
                    with self._temporary_path_task_lock:
                        self._temporary_path_git_pid = (
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
                with self._temporary_path_task_lock:
                    self._temporary_path_git_pid = None
                try:
                    pid_file.unlink(missing_ok=True)
                except OSError:
                    pass
                if not result.ok:
                    if cancel_event.is_set():
                        self._update_temporary_path_task("error", 0.0, "Canceled")
                        return
                    self._append_notice(
                        f"Temporary Path clone failed: {result.output}", level="ERROR"
                    )
                    self._update_temporary_path_task("error", 0.0, "Clone failed")
                    if reset_first:
                        try:
                            clear_dir_contents_strict(resolved, attempts=2)
                        except Exception:  # noqa: BLE001
                            pass
                    return

                self._append_notice("Temporary Path clone completed", level="INFO")
                self._track_successful_repo(resolved)
                calendar_root = resolved / "data" / "Economic_Calendar"
                if not calendar_root.exists():
                    self._append_notice(
                        "Temporary Path incomplete: calendar data missing. Please retry Reset & Clone.",
                        level="ERROR",
                    )
                    self._update_temporary_path_task("error", 0.0, "Clone incomplete")
                    try:
                        clear_dir_contents_strict(resolved, attempts=2)
                    except Exception:  # noqa: BLE001
                        pass
                    return

                self._set_temporary_path_confirmation(resolved, repo_slug, mode="reset")
                self.calendar_events = self._load_calendar_events(resolved)
                self._calendar_last_loaded = datetime.now()
                self._update_temporary_path_task("ready", 1.0, "Ready")
            finally:
                with self._temporary_path_task_lock:
                    self._temporary_path_task_active = False
                    self._temporary_path_task_cancel_event = None
                    self._temporary_path_git_pid = None
                    if self._temporary_path_task_phase not in ("ready", "error"):
                        self._temporary_path_task_phase = "idle"

        thread = threading.Thread(target=runner, daemon=True)
        thread.start()
        return True

    def _update_temporary_path_task(
        self, phase: str, progress: float, message: str
    ) -> None:
        with self._temporary_path_task_lock:
            self._temporary_path_task_phase = phase
            self._temporary_path_task_progress = max(0.0, min(1.0, float(progress)))
            self._temporary_path_task_message = message

    def _maybe_pull_and_sync(self) -> None:
        if self._shutdown_event.is_set():
            return
        if not self.state.get("enable_temporary_path", False):
            self._maybe_refresh_calendar_only()
            return
        repo_path = self._resolve_repo_path()
        if not repo_path:
            if self.state.get("enable_temporary_path", False):
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
        if not self.state.get("enable_temporary_path", False):
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
        managed_dir = output_dir / "data" / "Economic_Calendar"
        try:
            result = mirror_sync(src_dir, managed_dir)
        except FileNotFoundError:
            self._append_notice(
                "Calendar source not found in repository", level="ERROR"
            )
            return
        self._write_output_dir_marker(managed_dir)
        self._track_successful_repo(repo_path)
        self._append_notice(
            f"Sync ok: +{result.copied} / -{result.deleted} / = {result.skipped}",
            level="INFO",
        )
        now = to_iso_time(datetime.now())
        self.state["last_sync_at"] = now
        set_output_dir_last_sync_at(self.state, output_dir, now)
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
            payload = {
                "managedBy": APP_TITLE,
                "scope": "data/Economic_Calendar",
                "createdAt": to_iso_time(datetime.now()),
            }
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
            version = self._update_available_version

        should_apply, start_hidden = self._should_auto_apply_update()
        if should_apply:
            # Auto updates should be silent when the app is in the background; we keep
            # the restart hidden so the window does not pop to the foreground.
            self._update_restart_hidden_once = start_hidden
            self._run_task(self._auto_update_task, "Auto update")
            return

        # User is actively using the app: do not force a restart; nudge instead.
        self._update_restart_hidden_once = False
        self._maybe_prompt_update_available(version)

    def _should_auto_apply_update(self) -> tuple[bool, bool]:
        """
        Returns (should_apply_now, start_hidden_after_restart).

        We only auto-apply updates when the app is not actively used: either the
        window is in the background (hidden / not visible) or it has been idle
        for a while.
        """
        now = datetime.now()
        with self._ui_state_lock:
            seen_at = self._ui_state_seen_at
            visible = bool(self._ui_visible)
            last_input = self._ui_last_input_at

        if not seen_at:
            # If we haven't received any UI state yet, avoid surprising restarts.
            return False, False

        in_background = not visible
        if in_background:
            return True, True

        if last_input:
            idle_for = now - last_input
            if idle_for >= timedelta(minutes=AUTO_UPDATE_IDLE_MINUTES):
                return True, False

        # Active usage: visible and recently interacted with.
        # If focused is false but visible is true, treat it as active to avoid
        # surprising restarts while the window is still on-screen.
        return False, False

    def _maybe_prompt_update_available(self, version: str) -> None:
        try:
            version = (version or "").strip()
        except Exception:  # noqa: BLE001
            version = ""
        if not version:
            return

        with self._ui_state_lock:
            seen_at = self._ui_state_seen_at
            visible = bool(self._ui_visible)
            focused = bool(self._ui_focused)
            last_input = self._ui_last_input_at

        if not seen_at:
            return
        if not (visible and focused):
            return
        if not last_input:
            return
        if datetime.now() - last_input > timedelta(seconds=90):
            # If the app is technically focused but idle, skip the prompt.
            return

        if self._update_prompted_version == version:
            return
        self._update_prompted_version = version
        self._update_prompted_at = datetime.now()
        self._set_ui_modal(
            "Update available",
            f"v{version} is ready.\n\nOpen Settings to update now, or check release notes.",
            tone="info",
        )
        self._append_notice(f"Update available: {version}", level="INFO")

    def _auto_update_task(self) -> None:
        # Download then immediately install.
        self._download_update_task(start_install_on_download=True)
        with self._update_lock:
            ready = self._update_phase == "downloaded" and bool(
                self._update_download_target
            )
        if ready:
            self._install_update_task()

    def _prepare_update_install(self, pending_path: Path) -> None:
        if not getattr(sys, "frozen", False):
            self._append_notice(
                "Auto update is available only in the EXE build", level="WARN"
            )
            return
        with self._update_lock:
            if self._update_install_prepared and self._update_install_script_path:
                return
            expected_version = self._update_available_version

        asset_name = (self.state.get("github_release_asset_name") or "").lower()
        is_setup = asset_name == "setup.exe" or asset_name.startswith("setup")
        launch_args = " --start-hidden" if self._update_restart_hidden_once else ""
        script_path = pending_path.parent / f"apply_update_{os.getpid()}.cmd"
        if is_setup:
            log_path = pending_path.parent / f"update_install_{os.getpid()}.log"
            script = (
                "@echo off\n"
                f"set PID={os.getpid()}\n"
                f'set "LOG_PATH={log_path}"\n'
                f'set "EXPECTED_VERSION={expected_version}"\n'
                'set "APP_EXE=%LOCALAPPDATA%\\XAUUSDCalendarAgent\\XAUUSD Calendar Agent.exe"\n'
                ":wait\n"
                'tasklist /FI "PID eq %PID%" | findstr /I "%PID%" >nul\n'
                "if not errorlevel 1 (\n"
                "  ping -n 2 127.0.0.1 >nul\n"
                "  goto wait\n"
                ")\n"
                f'start "" /wait "{pending_path}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG="%LOG_PATH%"\n'
                'set "SETUP_EXIT=%ERRORLEVEL%"\n'
                'if not "%SETUP_EXIT%"=="0" (\n'
                '  echo Setup failed with exit %SETUP_EXIT%>>"%LOG_PATH%"\n'
                "  goto cleanup\n"
                ")\n"
                'if not exist "%APP_EXE%" (\n'
                '  echo Installed exe missing at %APP_EXE%>>"%LOG_PATH%"\n'
                "  goto cleanup\n"
                ")\n"
                'if not "%TEMP%"=="" (\n'
                '  echo Setting runtime temp to %TEMP%>>"%LOG_PATH%"\n'
                '  set "PYINSTALLER_TEMP=%TEMP%"\n'
                ")\n"
                'if not "%EXPECTED_VERSION%"=="" (\n'
                '  for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "(Get-Item \\"%APP_EXE%\\").VersionInfo.FileVersion"`) do '
                'set "INSTALLED_VERSION=%%v"\n'
                '  if "%INSTALLED_VERSION%"=="" (\n'
                '    echo Installed version missing; continue>>"%LOG_PATH%"\n'
                "    goto launch\n"
                "  )\n"
                '  echo Installed version: %INSTALLED_VERSION%>>"%LOG_PATH%"\n'
                '  echo %INSTALLED_VERSION% | findstr /C:"%EXPECTED_VERSION%" >nul\n'
                "  if errorlevel 1 (\n"
                '    echo Installed version mismatch>>"%LOG_PATH%"\n'
                "    goto cleanup\n"
                "  )\n"
                ")\n"
                ":launch\n"
                'set "LAUNCHED=0"\n'
                "for /l %%i in (1,1,10) do (\n"
                f'  start "" "%APP_EXE%"{launch_args}\n'
                "  ping -n 2 127.0.0.1 >nul\n"
                '  tasklist /FI "IMAGENAME eq XAUUSD Calendar Agent.exe" | findstr /I "XAUUSD Calendar Agent.exe" >nul\n'
                "  if not errorlevel 1 (\n"
                '    echo App relaunched on attempt %%i>>"%LOG_PATH%"\n'
                '    set "LAUNCHED=1"\n'
                "    goto cleanup\n"
                "  )\n"
                "  ping -n 2 127.0.0.1 >nul\n"
                ")\n"
                'if "%LAUNCHED%"=="0" echo Failed to relaunch app>>"%LOG_PATH%"\n'
                ":cleanup\n"
                f'del "{pending_path}" >nul 2>&1\n'
                'del "%~f0"\n'
            )
        else:
            exe_path = Path(sys.executable)
            script = (
                "@echo off\n"
                f"set PID={os.getpid()}\n"
                ":wait\n"
                'tasklist /FI "PID eq %PID%" | findstr /I "%PID%" >nul\n'
                "if not errorlevel 1 (\n"
                "  ping -n 2 127.0.0.1 >nul\n"
                "  goto wait\n"
                ")\n"
                f'move /y "{pending_path}" "{exe_path}"\n'
                f'start "" "{exe_path}"{launch_args}\n'
                'del "%~f0"\n'
            )
        script_path.write_text(script, encoding="utf-8")
        self.logger.info("Update install script ready: %s", script_path)
        self._launch_hidden_script(script_path, "Update install")
        with self._update_lock:
            self._update_install_prepared = True
            self._update_install_script_path = str(script_path)

    def _apply_update_now(self, pending_path: Path, *, request_exit: bool) -> None:
        if not getattr(sys, "frozen", False):
            self._append_notice(
                "Auto update is available only in the EXE build", level="WARN"
            )
            return
        self._prepare_update_install(pending_path)
        if not request_exit:
            return
        asset_name = (self.state.get("github_release_asset_name") or "").lower()
        is_setup = asset_name == "setup.exe" or asset_name.startswith("setup")
        if is_setup:
            restart_delay_seconds = 3
            self._restart_deadline = datetime.now() + timedelta(
                seconds=restart_delay_seconds
            )
            threading.Timer(
                restart_delay_seconds, lambda: self._request_exit(force=True)
            ).start()
        else:
            threading.Timer(0.2, lambda: self._request_exit(force=True)).start()

    def _launch_hidden_script(self, script_path: Path, label: str) -> None:
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        if os.name != "nt":
            subprocess.Popen([str(script_path)], creationflags=creationflags)
            return
        ps_cmd = f'Start-Process -FilePath "{script_path}" -WindowStyle Hidden'
        subprocess.Popen(
            [
                "powershell",
                "-NoProfile",
                "-WindowStyle",
                "Hidden",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                ps_cmd,
            ],
            creationflags=creationflags,
        )
        if label:
            self.logger.info("%s script launched: %s", label, script_path)
