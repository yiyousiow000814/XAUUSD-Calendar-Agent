import sys
import threading

try:
    import pystray
    from PIL import Image
    from pystray._util import win32 as pystray_win32
except Exception:  # noqa: BLE001
    pystray = None
    pystray_win32 = None
    Image = None

from .constants import APP_ICON, APP_TITLE, get_asset_path


class TrayMixin:

    def _shutdown_scheduler(self) -> None:
        scheduler = getattr(self, "scheduler", None)
        if scheduler:
            scheduler.shutdown()

    def _on_close(self) -> None:
        self._hide_to_tray()

    def _hide_to_tray(self) -> None:
        if not sys.platform.startswith("win"):
            self._shutdown_scheduler()
            self.root.destroy()
            return
        if not pystray or not Image:
            self._append_notice("Tray support missing (pystray not installed)")
            self.root.iconify()
            return
        self._ensure_tray()
        self.root.withdraw()
        if self.tray_icon:
            self.tray_icon.visible = True
            self.tray_visible = True
        self._append_notice("Minimized to tray")

    def _show_window(self, icon=None, item=None) -> None:
        def _restore() -> None:
            self.root.deiconify()
            self.root.state("normal")
            self.root.lift()
            self.root.focus_force()

        self.root.after(0, _restore)
        if self.tray_icon:
            self.tray_icon.visible = False
        self.tray_visible = False

    def _exit_app(self, icon=None, item=None) -> None:
        def _exit() -> None:
            if self.tray_icon:
                self.tray_icon.stop()
            self._shutdown_scheduler()
            self.root.quit()
            self.root.destroy()

        self.root.after(0, _exit)

    def _tray_pull(self, icon=None, item=None) -> None:
        self.root.after(0, self._pull_now)

    def _tray_sync(self, icon=None, item=None) -> None:
        self.root.after(0, self._sync_now)

    def _tray_update(self, icon=None, item=None) -> None:
        self.root.after(0, self._check_updates)

    def _ensure_tray(self) -> None:
        if self.tray_icon:
            return
        wm_lbutton_dblclk = 0x0203
        icon_path = get_asset_path(APP_ICON)
        try:
            image = Image.open(icon_path)
        except Exception:  # noqa: BLE001
            image = Image.new("RGB", (64, 64), "#0b1f2a")

        menu = pystray.Menu(
            pystray.MenuItem("Open", self._show_window),
            pystray.MenuItem("Pull Now", self._tray_pull),
            pystray.MenuItem("Sync Now", self._tray_sync),
            pystray.MenuItem("Check for updates", self._tray_update),
            pystray.MenuItem("Exit", self._exit_app),
        )
        self.tray_icon = pystray.Icon(APP_TITLE, image, APP_TITLE, menu)
        if (
            sys.platform.startswith("win")
            and pystray_win32
            and hasattr(self.tray_icon, "_message_handlers")
        ):
            original_notify = self.tray_icon._message_handlers.get(
                pystray_win32.WM_NOTIFY
            )

            def on_notify(wparam, lparam):  # type: ignore[no-untyped-def]
                try:
                    if lparam == wm_lbutton_dblclk:
                        self._show_window()
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

            self.tray_icon._message_handlers[pystray_win32.WM_NOTIFY] = on_notify
        self.tray_thread = threading.Thread(target=self.tray_icon.run, daemon=True)
        self.tray_thread.start()
