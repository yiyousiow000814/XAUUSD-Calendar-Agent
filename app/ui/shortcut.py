import os
import subprocess
import sys
from pathlib import Path
from tkinter import messagebox

from agent.config import save_config
from agent.git_ops import GitResult

from .constants import APP_ICON, APP_TITLE, get_asset_path


class ShortcutMixin:

    def _maybe_prompt_shortcut(self) -> None:
        if not sys.platform.startswith("win"):
            return
        if self.state.get("shortcut_prompted", False):
            return
        self.state["shortcut_prompted"] = True
        save_config(self.state)
        answer = messagebox.askyesno(
            APP_TITLE, "Create a desktop shortcut for this app?"
        )
        if not answer:
            return
        result = self._create_desktop_shortcut()
        if result.ok:
            self._append_notice(result.message)
        else:
            self._append_notice(f"{result.message}: {result.output}")

    def _create_desktop_shortcut(self) -> "GitResult":
        if not sys.platform.startswith("win"):
            return GitResult(False, "Desktop shortcut is supported on Windows only")

        desktop = Path(os.environ.get("USERPROFILE", str(Path.home()))) / "Desktop"
        shortcut_path = desktop / f"{APP_TITLE}.lnk"
        icon_path = get_asset_path(APP_ICON)

        if getattr(sys, "frozen", False):
            target = Path(sys.executable)
            args = ""
            working_dir = target.parent
        else:
            target = Path(sys.executable)
            script_path = Path(__file__).resolve()
            args = f'"{script_path}"'
            working_dir = script_path.parent

        command = (
            "$ws = New-Object -ComObject WScript.Shell; "
            f"$s = $ws.CreateShortcut('{shortcut_path}'); "
            f"$s.TargetPath = '{target}'; "
            f"$s.Arguments = '{args}'; "
            f"$s.WorkingDirectory = '{working_dir}'; "
            f"$s.IconLocation = '{icon_path}'; "
            "$s.Save()"
        )
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", command],
            capture_output=True,
            text=True,
            creationflags=creationflags,
        )
        if result.returncode != 0:
            output = result.stderr.strip() or result.stdout.strip()
            return GitResult(False, "Create shortcut failed", output)
        return GitResult(True, "Desktop shortcut created")
