import argparse
import multiprocessing
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import webview
from web_backend import WebAgentBackend

try:
    import pystray
    from PIL import Image
    from pystray._util import win32 as pystray_win32
except Exception:  # noqa: BLE001
    pystray = None
    pystray_win32 = None
    Image = None

APP_TITLE = "XAUUSD Calendar Agent"
APP_ICON = "assets/xauusd.ico"
IPC_HOST = "127.0.0.1"
IPC_PORT = 48732


def terminate_webview_descendants(timeout_s: float = 2.0) -> None:
    """
    Best-effort cleanup for PyInstaller onefile builds.

    When the app exits very early, WebView2 processes may still hold open handles
    in the PyInstaller extraction directory, which can trigger:
      "Failed to remove temporary directory: ...\\_MEIxxxxx"
    """
    if not sys.platform.startswith("win"):
        return

    try:
        creationflags = subprocess.CREATE_NO_WINDOW
    except Exception:  # noqa: BLE001
        creationflags = 0

    try:
        script = (
            "Get-CimInstance Win32_Process | "
            "Select-Object ProcessId,ParentProcessId,Name | "
            "ConvertTo-Json -Compress"
        )
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", script],
            check=False,
            capture_output=True,
            text=True,
            creationflags=creationflags,
        )
        if result.returncode != 0:
            return
        raw = (result.stdout or "").strip()
        if not raw:
            return
        import json  # local import to keep startup light

        data = json.loads(raw)
    except Exception:  # noqa: BLE001
        return

    items = data if isinstance(data, list) else [data]
    parents: dict[int, int] = {}
    names: dict[int, str] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        try:
            pid = int(item.get("ProcessId"))
            ppid = int(item.get("ParentProcessId") or 0)
        except Exception:  # noqa: BLE001
            continue
        parents[pid] = ppid
        names[pid] = str(item.get("Name") or "")

    root_pid = os.getpid()
    # Collect all descendants.
    descendants: set[int] = set()
    frontier = [root_pid]
    while frontier:
        current = frontier.pop()
        for pid, ppid in parents.items():
            if ppid != current or pid in descendants or pid == root_pid:
                continue
            descendants.add(pid)
            frontier.append(pid)

    targets = {"msedgewebview2.exe", "msedge.exe", "webviewhost.exe"}
    to_kill = [pid for pid in descendants if names.get(pid, "").lower() in targets]
    if not to_kill:
        return

    deadline = time.time() + max(0.2, float(timeout_s))
    for pid in to_kill:
        try:
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                check=False,
                capture_output=True,
                text=True,
                creationflags=creationflags,
            )
        except Exception:  # noqa: BLE001
            continue

    # Give Windows a moment to tear down the process tree and release file locks.
    while time.time() < deadline:
        remaining = []
        for pid in to_kill:
            try:
                os.kill(pid, 0)
            except OSError:
                continue
            remaining.append(pid)
        if not remaining:
            return
        time.sleep(0.05)


def patch_pywebview_winforms_move_resize() -> None:
    """
    WinForms backend wires `Form.Move`/`Form.Resize` to Python callbacks for every pixel movement.
    When the form is being dragged/resized, these high-frequency callbacks can stall the UI thread
    and freeze global input if the Python side is busy or the bridge is slow.

    The app does not rely on these events, so we detach them to keep drag/resize responsive.
    """
    if not sys.platform.startswith("win"):
        return
    try:
        import webview.platforms.winforms as winforms  # type: ignore
    except Exception:  # noqa: BLE001
        return
    try:
        if not getattr(winforms, "is_chromium", False) or getattr(
            winforms, "is_cef", False
        ):
            return
        if getattr(winforms, "_xauusd_detached_move_resize", False):
            return
        setattr(winforms, "_xauusd_detached_move_resize", True)
        browser_form = winforms.BrowserView.BrowserForm
        original_init = browser_form.__init__

        def patched_init(self, window, cache_dir):  # type: ignore[no-untyped-def]
            original_init(self, window, cache_dir)
            try:
                self.Resize -= self.on_resize
            except Exception:  # noqa: BLE001
                pass
            try:
                self.Move -= self.on_move
            except Exception:  # noqa: BLE001
                pass

        browser_form.__init__ = patched_init  # type: ignore[assignment]
    except Exception:  # noqa: BLE001
        return


def acquire_single_instance_lock() -> object | None:
    if not sys.platform.startswith("win"):
        return object()
    try:
        import msvcrt  # type: ignore[import-not-found]
    except Exception:  # noqa: BLE001
        return object()
    lock_dir = Path(os.environ.get("APPDATA", Path.home())) / "XAUUSDCalendar"
    lock_dir.mkdir(parents=True, exist_ok=True)
    lock_path = lock_dir / "app.lock"
    handle = open(lock_path, "a+")
    try:
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        handle.close()
        return None
    return handle


def notify_existing_instance() -> None:
    try:
        with socket.create_connection((IPC_HOST, IPC_PORT), timeout=0.3) as client:
            client.sendall(b"show")
    except OSError:
        pass


class TrayController:
    def __init__(
        self, backend: WebAgentBackend, icon_path: Path, exit_event: threading.Event
    ) -> None:
        self.backend = backend
        self.icon_path = icon_path
        self.icon: pystray.Icon | None = None
        self.thread: threading.Thread | None = None
        self.window: webview.Window | None = None
        self.exit_event = exit_event

    def start(self, window: webview.Window) -> None:
        if not pystray or not Image or not self.icon_path.exists():
            return
        self.window = window
        with Image.open(self.icon_path) as handle:
            image = handle.copy()
        wm_lbutton_dblclk = 0x0203

        def open_window() -> None:
            try:
                window.show()
            except Exception:  # noqa: BLE001
                return
            try:
                window.restore()
            except Exception:  # noqa: BLE001
                pass
            try:
                window.bring_to_front()
            except Exception:  # noqa: BLE001
                pass

        menu = pystray.Menu(
            pystray.MenuItem("Open", lambda icon, item: open_window()),
            pystray.MenuItem("Pull Now", lambda icon, item: self.backend.pull_now()),
            pystray.MenuItem("Sync Now", lambda icon, item: self.backend.sync_now()),
            pystray.MenuItem("Exit", lambda icon, item: self.request_exit()),
        )
        self.icon = pystray.Icon(APP_TITLE, image, APP_TITLE, menu)
        if (
            sys.platform.startswith("win")
            and pystray_win32
            and hasattr(self.icon, "_message_handlers")
        ):
            original_notify = self.icon._message_handlers.get(pystray_win32.WM_NOTIFY)

            def on_notify(wparam, lparam):  # type: ignore[no-untyped-def]
                try:
                    if lparam == wm_lbutton_dblclk:
                        open_window()
                        return
                    if lparam == pystray_win32.WM_LBUTTONUP:
                        if original_notify:
                            return original_notify(wparam, lparam)
                        return None
                    if original_notify:
                        return original_notify(wparam, lparam)
                    return None
                except Exception:  # noqa: BLE001
                    return None

            self.icon._message_handlers[pystray_win32.WM_NOTIFY] = on_notify
        self.thread = threading.Thread(target=self.icon.run, daemon=True)
        self.thread.start()

    def show(self) -> None:
        if self.icon:
            self.icon.visible = True

    def hide(self) -> None:
        if self.icon:
            self.icon.visible = False

    def stop(self) -> None:
        if self.icon:
            self.icon.stop()

    def request_exit(self) -> None:
        self.exit_event.set()
        try:
            self.backend.shutdown()
        except Exception:  # noqa: BLE001
            pass
        if self.window:
            try:
                self.window.destroy()
            except Exception:  # noqa: BLE001
                pass
        self.stop()


def get_asset_path(relative: str) -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    return base / relative


def main() -> None:
    multiprocessing.freeze_support()
    parser = argparse.ArgumentParser()
    parser.add_argument("--debug", action="store_true")
    parser.add_argument(
        "--autostart",
        action="store_true",
        help="Indicates the app was launched via the Windows startup entry.",
    )
    parser.add_argument(
        "--start-hidden",
        action="store_true",
        help="Start hidden (tray/background), used for silent update restarts.",
    )
    args = parser.parse_args()

    lock_handle = acquire_single_instance_lock()
    if lock_handle is None:
        notify_existing_instance()
        return

    backend = WebAgentBackend()
    ui_root = get_asset_path("webui")
    index_path = ui_root / "index.html"
    if not index_path.exists():
        raise FileNotFoundError(f"UI not found: {index_path}")

    icon_path = get_asset_path(APP_ICON)
    tray_supported = bool(pystray and Image and icon_path.exists())
    backend.set_tray_supported(tray_supported)
    autostart_launch_mode = (
        (backend.state.get("autostart_launch_mode") or "tray").strip().lower()
    )
    if autostart_launch_mode not in ("tray", "show"):
        autostart_launch_mode = "tray"
    should_hide_on_autostart = bool(
        (args.autostart and tray_supported and autostart_launch_mode == "tray")
        or (tray_supported and args.start_hidden)
    )
    try:
        backend.set_ui_state(
            {
                "visible": not should_hide_on_autostart,
                "focused": not should_hide_on_autostart,
                "lastInputAt": int(time.time() * 1000),
            }
        )
    except Exception:  # noqa: BLE001
        pass
    try:
        window = webview.create_window(
            APP_TITLE,
            url=index_path.as_uri(),
            width=1440,
            height=900,
            min_size=(1200, 760),
            text_select=True,
            resizable=True,
            confirm_close=False,
            background_color="#0b0d10",
            frameless=False,
            js_api=backend,
            hidden=should_hide_on_autostart,
        )
    except TypeError:
        # Older/broken pywebview installs may not support `hidden`.
        # Fall back to a normal window instead of crashing at startup.
        should_hide_on_autostart = False
        window = webview.create_window(
            APP_TITLE,
            url=index_path.as_uri(),
            width=1440,
            height=900,
            min_size=(1200, 760),
            text_select=True,
            resizable=True,
            confirm_close=False,
            background_color="#0b0d10",
            frameless=False,
            js_api=backend,
        )
    backend.set_window(window)
    exit_event = threading.Event()
    window_loaded = threading.Event()
    pending_hide_to_tray = threading.Event()
    pending_exit = threading.Event()
    tray = TrayController(backend, icon_path, exit_event)
    tray.start(window)
    ipc_stop = threading.Event()
    if should_hide_on_autostart:
        pending_hide_to_tray.set()

    def start_ipc_listener() -> None:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                server.bind((IPC_HOST, IPC_PORT))
            except OSError:
                return
            server.listen(1)
            server.settimeout(0.5)
            while not exit_event.is_set() and not ipc_stop.is_set():
                try:
                    conn, _addr = server.accept()
                except socket.timeout:
                    continue
                with conn:
                    data = conn.recv(32)
                    if data.strip().lower().startswith(b"show"):
                        try:
                            window.show()
                        except Exception:  # noqa: BLE001
                            pass

    ipc_thread = threading.Thread(target=start_ipc_listener, daemon=True)
    ipc_thread.start()

    def on_closing(*_args) -> bool:
        if exit_event.is_set():
            return True
        close_behavior = (backend.state.get("close_behavior") or "exit").strip().lower()
        if close_behavior not in ("exit", "tray"):
            close_behavior = "exit"
        if close_behavior == "exit" and not window_loaded.is_set():
            # Avoid exiting before WebView2 fully spins up; early exits can leave
            # file locks behind in PyInstaller's _MEI folder.
            pending_exit.set()
            return False
        tray_ready = (
            tray.icon is not None and tray.thread is not None and tray.thread.is_alive()
        )
        if close_behavior == "tray" and tray_supported:
            if not tray_ready:
                pending_hide_to_tray.set()
                return False
            if not window_loaded.is_set():
                pending_hide_to_tray.set()
                return False
            try:
                window.hide()
            except Exception:  # noqa: BLE001
                exit_event.set()
                try:
                    backend.shutdown()
                except Exception:  # noqa: BLE001
                    pass
                return True
            try:
                tray.show()
            except Exception:  # noqa: BLE001
                exit_event.set()
                try:
                    backend.shutdown()
                except Exception:  # noqa: BLE001
                    pass
                return True
            return False
        exit_event.set()
        try:
            backend.shutdown()
        except Exception:  # noqa: BLE001
            pass
        return True

    try:
        window.events.closing += on_closing
    except Exception:  # noqa: BLE001
        pass
    try:

        def on_loaded(*_args) -> None:
            window_loaded.set()
            if exit_event.is_set():
                return
            if tray.icon and pending_hide_to_tray.is_set():
                try:
                    window.hide()
                except Exception:  # noqa: BLE001
                    return
                try:
                    tray.show()
                except Exception:  # noqa: BLE001
                    return
            if pending_exit.is_set():
                exit_event.set()
                try:
                    backend.shutdown()
                except Exception:  # noqa: BLE001
                    pass
                try:
                    window.destroy()
                except Exception:  # noqa: BLE001
                    return

        window.events.loaded += on_loaded
    except Exception:  # noqa: BLE001
        pass
    try:

        def on_closed(*_args) -> None:
            exit_event.set()
            try:
                backend.shutdown()
            except Exception:  # noqa: BLE001
                pass
            try:
                tray.stop()
            except Exception:  # noqa: BLE001
                pass
            ipc_stop.set()

        window.events.closed += on_closed
    except Exception:  # noqa: BLE001
        pass

    try:
        patch_pywebview_winforms_move_resize()
        webview.start(
            debug=args.debug,
            gui="edgechromium",
            icon=str(icon_path) if icon_path.exists() else None,
            # Use the built-in HTTP server so JS→Python calls do not block the GUI thread.
            http_server=True,
            private_mode=False,
            user_agent="XAUUSDCalendar/1.0",
            func=None,
        )
    finally:
        terminate_webview_descendants()
        tray.stop()
        ipc_stop.set()
        if lock_handle and hasattr(lock_handle, "close"):
            try:
                lock_handle.close()
            except Exception:  # noqa: BLE001
                pass
        if tray.thread:
            try:
                tray.thread.join(timeout=1.5)
            except Exception:  # noqa: BLE001
                pass


if __name__ == "__main__":
    main()
