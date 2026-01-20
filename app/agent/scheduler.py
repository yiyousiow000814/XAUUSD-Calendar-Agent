import sys
from dataclasses import dataclass

try:
    import winreg
except ImportError:  # pragma: no cover - non-Windows platforms
    winreg = None

TASK_NAME = "XAUUSDCalendarAgent"


@dataclass
class TaskResult:
    ok: bool
    message: str
    output: str = ""


def create_startup_task(command: str) -> TaskResult:
    if not sys.platform.startswith("win") or not winreg:
        return TaskResult(False, "startup entry is supported on Windows only")
    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            0,
            winreg.KEY_SET_VALUE,
        ) as key:
            winreg.SetValueEx(key, TASK_NAME, 0, winreg.REG_SZ, command)
    except OSError as exc:
        return TaskResult(False, "create startup entry failed", str(exc))
    return TaskResult(True, "startup entry created")


def remove_startup_task() -> TaskResult:
    if not sys.platform.startswith("win") or not winreg:
        return TaskResult(False, "startup entry is supported on Windows only")
    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            0,
            winreg.KEY_SET_VALUE,
        ) as key:
            winreg.DeleteValue(key, TASK_NAME)
    except FileNotFoundError:
        return TaskResult(True, "startup entry already removed")
    except OSError as exc:
        return TaskResult(False, "remove startup entry failed", str(exc))
    return TaskResult(True, "startup entry removed")
