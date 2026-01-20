import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_DIR))

from ui import tray  # noqa: E402


class DummyScheduler:
    def __init__(self) -> None:
        self.shutdown_called = False

    def shutdown(self) -> None:
        self.shutdown_called = True


class DummyRoot:
    def __init__(self) -> None:
        self.quit_called = False
        self.destroy_called = False

    def after(self, _delay, callback):
        callback()

    def quit(self):
        self.quit_called = True

    def destroy(self):
        self.destroy_called = True


class DummyTray(tray.TrayMixin):
    def __init__(self) -> None:
        self.scheduler = DummyScheduler()
        self.root = DummyRoot()
        self.tray_icon = None


def test_exit_app_shuts_down_scheduler():
    subject = DummyTray()
    subject._exit_app()
    assert subject.scheduler.shutdown_called is True
    assert subject.root.quit_called is True
    assert subject.root.destroy_called is True


def test_hide_to_tray_shuts_down_on_non_windows(monkeypatch):
    subject = DummyTray()
    monkeypatch.setattr(tray.sys, "platform", "linux")
    subject._hide_to_tray()
    assert subject.scheduler.shutdown_called is True
    assert subject.root.destroy_called is True
