from tkinter import BooleanVar, StringVar, Tk

from agent.config import load_config
from agent.logger import setup_logger
from agent.timezone import clamp_utc_offset_minutes, format_utc_offset_label
from agent.version import APP_VERSION
from ui.calendar import CalendarMixin
from ui.event_scheduler import EventScheduler
from ui.layout import LayoutMixin
from ui.notice import NoticeMixin
from ui.repo import RepoMixin
from ui.settings import SettingsMixin
from ui.shortcut import ShortcutMixin
from ui.sync import SyncMixin
from ui.tray import TrayMixin
from ui.ui_state import UiStateService
from ui.uninstall import UninstallMixin
from ui.update import UpdateMixin
from ui.update_service import UpdateService


class App(
    LayoutMixin,
    NoticeMixin,
    CalendarMixin,
    SettingsMixin,
    TrayMixin,
    UpdateMixin,
    SyncMixin,
    UninstallMixin,
    RepoMixin,
    ShortcutMixin,
):

    def __init__(self, root: Tk, background: bool) -> None:
        self.root = root
        self.state = load_config()
        self.logger = setup_logger(self.state.get("debug", False))
        self.background = background
        self.tray_icon = None
        self.tray_thread = None
        self.tray_visible = False
        max_workers = int(self.state.get("background_max_workers", 4) or 4)
        self.scheduler = EventScheduler(self.root, max_workers=max_workers)

        self.repo_var = StringVar(value=self.state.get("repo_path", ""))
        self.temporary_path_var = StringVar(value=self.state.get("temporary_path", ""))
        self.output_var = StringVar(value=self.state.get("output_dir", ""))
        self.last_pull_var = StringVar(value="Not yet")
        self.last_sync_var = StringVar(value="Not yet")
        self.status_var = StringVar(value="Idle")
        self.version_var = StringVar(value=APP_VERSION)
        self.update_button_var = StringVar(value="Check for updates")
        self.update_status_var = StringVar(value="")
        self.settings_status_var = StringVar(value="")
        self.calendar_events: list[dict] = []
        self.currency_var = StringVar(value="USD")
        self.notice_entries: list[dict] = []
        self.log_filter_var = StringVar(value="All")
        self.ui_state = UiStateService(
            scheduler=self.scheduler,
            status_var=self.status_var,
            settings_status_var=self.settings_status_var,
            update_button_var=self.update_button_var,
            update_status_var=self.update_status_var,
        )

        self.auto_sync_var = BooleanVar(
            value=self.state.get("auto_sync_after_pull", True)
        )
        self.debug_var = BooleanVar(value=self.state.get("debug", False))
        self.startup_var = BooleanVar(value=self.state.get("run_on_startup", True))
        self.auto_update_var = BooleanVar(
            value=self.state.get("auto_update_enabled", False)
        )
        tz_mode = (self.state.get("calendar_timezone_mode") or "system").strip().lower()
        self.calendar_follow_system_var = BooleanVar(value=tz_mode == "system")
        offset_minutes = clamp_utc_offset_minutes(
            int(self.state.get("calendar_utc_offset_minutes", 0))
        )
        self.calendar_utc_offset_label_var = StringVar(
            value=format_utc_offset_label(offset_minutes)
        )

        self._build_ui()
        self.update_service = UpdateService(
            scheduler=self.scheduler,
            state=self.state,
            set_ui=self._set_update_ui,
            append_notice=self._append_notice,
            notify_user=self._notify_user,
            apply_update=self._apply_update_now,
            run_task=self._run_task,
        )
        self._register_settings_traces()
        self.log_filter_var.trace_add("write", self._on_log_filter_changed)
        self._refresh_times()
        self._refresh_calendar_data()
        self._schedule_calendar_tick()
        self._schedule_periodic_check()
        self._schedule_update_check()
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

        if self.startup_var.get():
            self._apply_startup_task()

        self._run_task(self._maybe_pull_and_sync, "Startup check")
        self._run_task(lambda: self._update_check(manual=False), "Startup update check")

        if not self.background:
            self._maybe_prompt_shortcut()

        if self.background:
            self._hide_to_tray()
