import os
import shutil
import subprocess
import sys
from pathlib import Path
from tkinter import messagebox

try:
    import winreg
except Exception:  # noqa: BLE001
    winreg = None

from agent.config import get_config_path, get_log_dir, get_update_dir

from .constants import APP_TITLE


class UninstallMixin:

    def _uninstall_app(self) -> None:
        if not sys.platform.startswith("win"):
            messagebox.showinfo(APP_TITLE, "Uninstall is supported on Windows only.")
            return
        uninstaller = self._find_uninstaller()
        if not uninstaller:
            messagebox.showinfo(
                APP_TITLE,
                "Uninstaller not found. This copy may not be installed via Setup.exe.\n"
                "App data cleanup completed; delete the EXE manually if needed.",
            )
            self._cleanup_appdata(scan_history=False)
            return
        answer = messagebox.askyesno(
            APP_TITLE, "This will start the uninstaller. Continue?"
        )
        if not answer:
            return
        scan = messagebox.askyesno(
            APP_TITLE,
            "Scan previously used folders and remove empty ones?\n"
            "Only successful repo paths are checked.",
        )
        self._cleanup_appdata(scan_history=scan)
        if os.name != "nt":
            messagebox.showinfo(APP_TITLE, "Uninstall is supported on Windows only.")
            return

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
            f"set UNINS={uninstaller}\r\n"
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
        subprocess.Popen(
            ["cmd", "/c", "start", "", "/min", str(script_path)],
            creationflags=creationflags,
        )
        self.root.after(0, self._exit_app)

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

    def _cleanup_appdata(self, scan_history: bool) -> None:
        for path in (get_config_path(), get_log_dir(), get_update_dir()):
            try:
                if path.is_file():
                    path.unlink()
                elif path.is_dir():
                    shutil.rmtree(path, ignore_errors=True)
            except OSError:
                continue
        for path_str in self.state.get("created_paths", []):
            path = Path(path_str)
            if not path.exists() or not path.is_dir():
                continue
            try:
                if not any(path.iterdir()):
                    path.rmdir()
            except OSError:
                continue
        if not scan_history:
            return
        for path_str in self.state.get("successful_repo_paths", []):
            path = Path(path_str)
            if not path.exists() or not path.is_dir():
                continue
            try:
                if not any(path.iterdir()):
                    path.rmdir()
            except OSError:
                continue

    def _find_uninstaller(self) -> str | None:
        if getattr(sys, "frozen", False):
            exe_dir = Path(sys.executable).resolve().parent
            for candidate in exe_dir.glob("unins*.exe"):
                return f'"{candidate}"'
        if not winreg:
            return None
        uninstall_paths = [
            r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
        ]
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
                                    return uninstall
                            except OSError:
                                continue
                except OSError:
                    continue
        return None
