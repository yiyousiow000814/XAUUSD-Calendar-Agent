import os
import subprocess
import sys
from pathlib import Path


class UpdateMixin:
    def _check_updates(self) -> None:
        if self.update_service.state.download_url:
            self._run_task(
                self._apply_update_action,
                self.update_service._UPDATE_CTA_UPDATE,
            )
            return
        self.update_service.request_manual_check()

    def _schedule_update_check(self) -> None:
        interval = int(self.state.get("auto_update_interval_minutes", 60) or 60)
        self.update_service.schedule_update_check(interval)

    def _update_check(self, manual: bool) -> None:
        self.update_service.check_updates(manual=manual)

    def _apply_update_action(self) -> None:
        if not self.update_service.state.download_url:
            return
        self.update_service.download_and_apply_update(
            self.update_service.state.download_url,
            self.update_service.state.available_version,
        )

    def _set_update_ui(self, button_text: str, status: str) -> None:
        if button_text != self.update_service._UPDATE_CTA_UPDATE:
            self.update_service.state.download_url = ""
            self.update_service.state.available_version = ""
        self.ui_state.set_update_ui(button_text, status)

    def _apply_update_now(self, pending_path: Path) -> None:
        if self.update_service.state.in_progress:
            return
        self.update_service.state.in_progress = True
        if not getattr(sys, "frozen", False):
            self._append_notice("Auto update is available only in the EXE build")
            self.update_service.state.in_progress = False
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
