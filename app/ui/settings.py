import os
import sys
from pathlib import Path
from tkinter import Toplevel, filedialog, messagebox, ttk

from agent.config import get_log_dir, save_config
from agent.logger import setup_logger
from agent.scheduler import create_startup_task, remove_startup_task
from agent.timezone import (
    SUPPORTED_UTC_OFFSET_MINUTES,
    clamp_utc_offset_minutes,
    format_utc_offset_label,
    parse_utc_offset_label,
)

from .constants import APP_TITLE, UI_COLORS


class SettingsMixin:

    def _save_paths(self, notify: bool = True) -> None:
        repo_path = self.repo_var.get().strip()
        temporary_path = self.temporary_path_var.get().strip()
        output_dir = self.output_var.get().strip()
        self.state["repo_path"] = repo_path
        self.state["temporary_path"] = temporary_path
        self.state["output_dir"] = output_dir
        self._ensure_dir(temporary_path)
        self._track_path("repo_path_history", repo_path)
        self._track_path("temporary_path_history", temporary_path)
        self._track_path("output_dir_history", output_dir)
        save_config(self.state)
        self._set_settings_status("Saved (auto save)")

    def _toggle_debug(self) -> None:
        self.state["debug"] = self.debug_var.get()
        save_config(self.state)
        self.logger = setup_logger(self.debug_var.get())
        self._append_notice("Debug logging updated")
        self._set_settings_status("Saved (auto save)")

    def _toggle_startup(self) -> None:
        self.state["run_on_startup"] = self.startup_var.get()
        save_config(self.state)
        self._apply_startup_task()
        self._set_settings_status("Saved (auto save)")

    def _apply_startup_task(self) -> None:
        if not sys.platform.startswith("win"):
            self._append_notice("Startup task is supported on Windows only")
            return
        if self.startup_var.get():
            command = self._build_start_command()
            result = create_startup_task(command)
        else:
            result = remove_startup_task()
        if not result.ok:
            self._append_notice(f"{result.message}: {result.output}")

    def _build_start_command(self) -> str:
        if getattr(sys, "frozen", False):
            exe_path = Path(sys.executable)
            return f'"{exe_path}" --background'
        python_path = Path(sys.executable)
        script_path = Path(__file__).resolve()
        return f'"{python_path}" "{script_path}" --background'

    def _browse_repo(self) -> None:
        path = filedialog.askdirectory()
        if path:
            self.repo_var.set(path)
            self._save_paths()

    def _browse_output(self) -> None:
        initial = self.output_var.get().strip()
        path = filedialog.askdirectory(
            initialdir=initial if initial and Path(initial).exists() else None
        )
        if path:
            self.output_var.set(path)
            self._save_paths()

    def _browse_temporary_path(self) -> None:
        initial = self.temporary_path_var.get().strip()
        if not initial:
            initial = self.repo_var.get().strip()
        path = filedialog.askdirectory(
            initialdir=initial if initial and Path(initial).exists() else None
        )
        if path:
            self.temporary_path_var.set(path)
            self._save_paths()

    def _register_settings_traces(self) -> None:
        for variable in (
            self.repo_var,
            self.temporary_path_var,
            self.output_var,
            self.auto_sync_var,
            self.auto_update_var,
            self.calendar_follow_system_var,
            self.calendar_utc_offset_label_var,
        ):
            variable.trace_add("write", self._on_setting_changed)
        self.currency_var.trace_add("write", self._on_currency_changed)

    def _on_setting_changed(self, *_args) -> None:
        self._apply_calendar_tz_controls()
        self._schedule_settings_autosave()

    @staticmethod
    def _calendar_tz_offset_options() -> list[str]:
        return [
            format_utc_offset_label(minutes)
            for minutes in sorted(SUPPORTED_UTC_OFFSET_MINUTES)
        ]

    def _apply_calendar_tz_controls(self) -> None:
        combo = getattr(self, "calendar_tz_combo", None)
        if not combo:
            return
        try:
            combo.configure(
                state=(
                    "disabled" if self.calendar_follow_system_var.get() else "readonly"
                )
            )
        except Exception:
            return

    def _schedule_settings_autosave(self) -> None:
        if self._autosave_after_id is not None:
            try:
                self.root.after_cancel(self._autosave_after_id)
            except Exception:
                pass
            self._autosave_after_id = None
        self._set_settings_status("Saving... (auto save)")
        self._autosave_after_id = self.root.after(400, self._autosave_settings)

    def _autosave_settings(self) -> None:
        self._autosave_after_id = None
        self._save_settings(notify=False)
        self._save_paths(notify=False)
        try:
            self._update_calendar_view(self.calendar_events)
        except Exception:
            pass
        self._set_settings_status("Saved (auto save)")

    def _set_settings_status(self, text: str) -> None:
        self.root.after(0, lambda: self.settings_status_var.set(text))

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
        key = "successful_repo_paths"
        history = self.state.get(key, [])
        value = str(repo_path)
        if value in history:
            return
        history.append(value)
        self.state[key] = history
        save_config(self.state)

    def _open_logs(self) -> None:
        log_dir = get_log_dir()
        try:
            os.startfile(log_dir)  # type: ignore[attr-defined]
        except Exception:
            messagebox.showinfo("Logs", f"Logs are located at: {log_dir}")

    def _open_settings(self) -> None:
        settings = Toplevel(self.root)
        settings.title(f"{APP_TITLE} Settings")
        settings.configure(bg=UI_COLORS["bg"])
        settings.minsize(720, 680)
        settings.resizable(True, True)
        settings.transient(self.root)
        settings.grab_set()
        settings.withdraw()

        container = ttk.Frame(settings, style="Root.TFrame")
        container.pack(fill="both", expand=True, padx=24, pady=24)

        header = ttk.Frame(container, style="Card.TFrame")
        header.pack(fill="x", padx=0, pady=(0, 12))
        ttk.Label(header, text="Settings", style="Hero.TLabel").pack(
            anchor="w", padx=20, pady=(16, 6)
        )
        ttk.Label(
            header,
            text="Update cadence, startup behavior, and maintenance tools",
            style="Subtitle.TLabel",
        ).pack(anchor="w", padx=20, pady=(0, 16))
        ttk.Label(
            header, textvariable=self.settings_status_var, style="Muted.TLabel"
        ).pack(anchor="w", padx=20, pady=(0, 16))
        self._set_settings_status("Saved (auto save)")

        updates = ttk.Frame(container, style="Card.TFrame")
        updates.pack(fill="x", padx=0, pady=(0, 12))
        ttk.Label(updates, text="Updates", style="Section.TLabel").grid(
            row=0, column=0, sticky="w", padx=20, pady=(14, 8)
        )
        update_action = ttk.Frame(updates, style="Card.TFrame")
        update_action.grid(row=1, column=0, sticky="ew", padx=20, pady=(0, 10))
        update_action.columnconfigure(1, weight=1)
        ttk.Button(
            update_action,
            textvariable=self.update_button_var,
            command=self._check_updates,
        ).grid(row=0, column=0, sticky="w")
        ttk.Label(
            update_action, textvariable=self.update_status_var, style="Muted.TLabel"
        ).grid(row=0, column=1, sticky="w", padx=(12, 0))
        ttk.Checkbutton(
            updates,
            text="Enable auto update",
            variable=self.auto_update_var,
        ).grid(row=2, column=0, sticky="w", padx=20, pady=(0, 6))
        ttk.Label(updates, text="App Version", style="Muted.TLabel").grid(
            row=3, column=0, sticky="w", padx=20, pady=(0, 4)
        )
        ttk.Label(updates, textvariable=self.version_var, style="Body.TLabel").grid(
            row=4, column=0, sticky="w", padx=20, pady=(0, 14)
        )

        system = ttk.Frame(container, style="Card.TFrame")
        system.pack(fill="x", padx=0, pady=(0, 12))
        system.columnconfigure(0, weight=1)
        ttk.Label(system, text="System", style="Section.TLabel").grid(
            row=0, column=0, sticky="w", padx=20, pady=(14, 8)
        )
        ttk.Label(system, text="Repository Path", style="Muted.TLabel").grid(
            row=1, column=0, sticky="w", padx=20, pady=(0, 4)
        )
        ttk.Label(system, textvariable=self.repo_var, style="Body.TLabel").grid(
            row=2, column=0, sticky="w", padx=20, pady=(0, 8)
        )

        ttk.Label(
            system,
            text="Sync Repo (dev-only: separate repo used for pull/sync)",
            style="Muted.TLabel",
        ).grid(row=3, column=0, sticky="w", padx=20, pady=(6, 4))
        sync_row = ttk.Frame(system, style="Card.TFrame")
        sync_row.grid(row=4, column=0, sticky="ew", padx=20, pady=(0, 12))
        sync_row.columnconfigure(0, weight=1)
        ttk.Entry(sync_row, textvariable=self.temporary_path_var).grid(
            row=0, column=0, sticky="ew"
        )
        ttk.Button(sync_row, text="Browse", command=self._browse_temporary_path).grid(
            row=0, column=1, padx=(10, 0)
        )

        ttk.Checkbutton(
            system,
            text="Run on startup",
            variable=self.startup_var,
            command=self._toggle_startup,
        ).grid(row=5, column=0, sticky="w", padx=20, pady=(0, 6))
        ttk.Checkbutton(
            system,
            text="Auto sync after pull",
            variable=self.auto_sync_var,
        ).grid(row=6, column=0, sticky="w", padx=20, pady=(0, 6))
        ttk.Checkbutton(
            system,
            text="Debug logging (extra diagnostics)",
            variable=self.debug_var,
            command=self._toggle_debug,
        ).grid(row=7, column=0, sticky="w", padx=20, pady=(0, 6))
        ttk.Label(system, text="Calendar time", style="Muted.TLabel").grid(
            row=8, column=0, sticky="w", padx=20, pady=(10, 4)
        )
        ttk.Checkbutton(
            system,
            text="Follow system time zone",
            variable=self.calendar_follow_system_var,
        ).grid(row=9, column=0, sticky="w", padx=20, pady=(0, 6))
        tz_row = ttk.Frame(system, style="Card.TFrame")
        tz_row.grid(row=10, column=0, sticky="ew", padx=20, pady=(0, 12))
        tz_row.columnconfigure(1, weight=1)
        ttk.Label(tz_row, text="UTC Offset", style="Muted.TLabel").grid(
            row=0, column=0, sticky="w"
        )
        self.calendar_tz_combo = ttk.Combobox(
            tz_row,
            textvariable=self.calendar_utc_offset_label_var,
            values=self._calendar_tz_offset_options(),
            width=12,
            state="readonly",
        )
        self.calendar_tz_combo.grid(row=0, column=1, sticky="w", padx=(12, 0))
        self._apply_calendar_tz_controls()
        ttk.Button(system, text="Open Logs", command=self._open_logs).grid(
            row=11, column=0, sticky="w", padx=20, pady=(0, 12)
        )
        ttk.Button(system, text="Uninstall", command=self._uninstall_app).grid(
            row=12, column=0, sticky="w", padx=20, pady=(0, 16)
        )

        footer = ttk.Frame(container, style="Root.TFrame")
        footer.pack(fill="x", padx=0, pady=0)

        self._finalize_settings_window(settings)

    def _save_settings(self, notify: bool = True) -> None:
        self.state["auto_update_enabled"] = self.auto_update_var.get()
        self.state["calendar_timezone_mode"] = (
            "system" if self.calendar_follow_system_var.get() else "utc"
        )
        offset_label = self.calendar_utc_offset_label_var.get()
        parsed = parse_utc_offset_label(offset_label)
        if parsed is None:
            parsed = 0
        self.state["calendar_utc_offset_minutes"] = clamp_utc_offset_minutes(parsed)
        save_config(self.state)
        self._schedule_update_check()
