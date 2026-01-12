import os
import subprocess
import sys
from pathlib import Path

from agent.config import get_update_dir
from agent.updater import download_update, fetch_github_release
from agent.version import APP_VERSION

from .constants import APP_TITLE, parse_version


class UpdateMixin:
    _UPDATE_CTA_CHECK = "Check for updates"
    _UPDATE_CTA_UPDATE = "Update now"

    def _check_updates(self) -> None:
        if self.update_download_url:
            self._run_task(self._apply_update_action, self._UPDATE_CTA_UPDATE)
            return
        self._run_task(lambda: self._update_check(manual=True), "Update check")

    def _schedule_update_check(self) -> None:
        interval = 60
        if self.update_timer_id is not None:
            try:
                self.root.after_cancel(self.update_timer_id)
            except Exception:
                pass
            self.update_timer_id = None
        if interval <= 0:
            return
        delay_ms = max(interval, 10) * 60 * 1000

        def periodic() -> None:
            self._run_task(
                lambda: self._update_check(manual=False), "Auto update check"
            )
            self.update_timer_id = self.root.after(delay_ms, periodic)

        self.update_timer_id = self.root.after(delay_ms, periodic)

    def _update_check(self, manual: bool) -> None:
        repo = self.state.get("github_repo", "")
        if not repo:
            self._set_update_ui(self._UPDATE_CTA_CHECK, "Update channel not configured")
            return
        self._set_update_ui(self._UPDATE_CTA_CHECK, "Checking...")
        asset_name = self.state.get("github_release_asset_name", "") or None
        info = fetch_github_release(repo, asset_name=asset_name)

        if not info.ok:
            self._set_update_ui(self._UPDATE_CTA_CHECK, info.message)
            return
        current_version = APP_VERSION
        if parse_version(info.version) <= parse_version(current_version):
            self._set_update_ui(self._UPDATE_CTA_CHECK, "Up to date")
            return

        if not info.download_url:
            self._set_update_ui(self._UPDATE_CTA_CHECK, "Release missing download URL")
            return

        self.update_available_version = info.version or ""
        self.update_download_url = info.download_url
        self._set_update_ui(
            self._UPDATE_CTA_UPDATE, f"Update available: {info.version}"
        )

        if manual:
            return
        if not self.state.get("auto_update_enabled", False):
            return
        self._download_and_apply_update(info.download_url, info.version or "")

    def _apply_update_action(self) -> None:
        if not self.update_download_url:
            return
        self._download_and_apply_update(
            self.update_download_url, self.update_available_version
        )

    def _download_and_apply_update(self, download_url: str, version: str) -> None:
        self._append_notice(f"Downloading update {version}")
        try:
            target = download_update(download_url, get_update_dir())
        except Exception as exc:  # noqa: BLE001
            self._append_notice(f"Update download failed: {exc}")
            self._set_update_ui(self._UPDATE_CTA_UPDATE, f"Update failed: {exc}")
            return
        if version:
            self._notify_user(APP_TITLE, f"Update {version} downloaded, restarting")
        self._append_notice("Update downloaded, applying now")
        self.root.after(0, lambda: self._apply_update_now(target))

    def _set_update_ui(self, button_text: str, status: str) -> None:
        def _update() -> None:
            self.update_button_var.set(button_text)
            self.update_status_var.set(status)
            if button_text != self._UPDATE_CTA_UPDATE:
                self.update_download_url = ""
                self.update_available_version = ""

        self.root.after(0, _update)

    def _apply_update_now(self, pending_path: Path) -> None:
        if self.update_in_progress:
            return
        self.update_in_progress = True
        if not getattr(sys, "frozen", False):
            self._append_notice("Auto update is available in the EXE build only")
            self.update_in_progress = False
            return

        asset_name = (self.state.get("github_release_asset_name") or "").lower()
        is_setup = asset_name == "setup.exe" or asset_name.startswith("setup")

        exe_path = Path(sys.executable)
        script_path = pending_path.parent / f"apply_update_{os.getpid()}.cmd"
        if is_setup:
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
        self._exit_app()
