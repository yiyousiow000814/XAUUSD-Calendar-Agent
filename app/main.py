from tkinter import BooleanVar, StringVar, Tk

from agent.config import load_config
from agent.logger import setup_logger
from agent.version import APP_VERSION
from ui.calendar import CalendarMixin
from ui.layout import LayoutMixin
from ui.notice import NoticeMixin
from ui.repo import RepoMixin
from ui.settings import SettingsMixin
from ui.shortcut import ShortcutMixin
from ui.sync import SyncMixin
from ui.tray import TrayMixin
from ui.uninstall import UninstallMixin
from ui.update import UpdateMixin


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
        self.update_in_progress = False
        self.update_timer_id = None

        self.repo_var = StringVar(value=self.state.get("repo_path", ""))
        self.sync_repo_var = StringVar(value=self.state.get("sync_repo_path", ""))
        self.output_var = StringVar(value=self.state.get("output_dir", ""))
        self.last_pull_var = StringVar(value="Not yet")
        self.last_sync_var = StringVar(value="Not yet")
        self.status_var = StringVar(value="Idle")
        self.version_var = StringVar(value=APP_VERSION)
        self.update_button_var = StringVar(value="Check for updates")
        self.update_status_var = StringVar(value="")
        self.settings_status_var = StringVar(value="")
        self.update_available_version = ""
        self.update_download_url = ""
        self._autosave_after_id = None
        self.calendar_events: list[dict] = []
        self.calendar_timer_id = None
        self.currency_var = StringVar(value="USD")
        self.notice_entries: list[dict] = []
        self.log_filter_var = StringVar(value="All")

        self.auto_sync_var = BooleanVar(
            value=self.state.get("auto_sync_after_pull", True)
        )
        self.debug_var = BooleanVar(value=self.state.get("debug", False))
        self.startup_var = BooleanVar(value=self.state.get("run_on_startup", True))
        self.auto_update_var = BooleanVar(
            value=self.state.get("auto_update_enabled", False)
        )

        self._build_ui()
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
