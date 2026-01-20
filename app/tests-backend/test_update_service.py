import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_DIR))

from ui import update_service  # noqa: E402


class DummyScheduler:
    def __init__(self) -> None:
        self.scheduled: list[tuple[str, int]] = []
        self.canceled: list[str] = []
        self.called_soon = False

    def schedule_interval(self, key: str, delay_ms: int, callback) -> None:
        self.scheduled.append((key, delay_ms))
        self._callback = callback

    def cancel(self, key: str) -> None:
        self.canceled.append(key)

    def call_soon(self, callback) -> None:
        self.called_soon = True
        callback()


def _service_for(state, scheduler, set_ui, apply_update, download_update):
    update_service.download_update = download_update
    return update_service.UpdateService(
        scheduler=scheduler,
        state=state,
        set_ui=set_ui,
        append_notice=lambda *_args, **_kwargs: None,
        notify_user=lambda *_args, **_kwargs: None,
        apply_update=apply_update,
        run_task=lambda func, _label: func(),
    )


def test_schedule_update_check_uses_min_interval():
    scheduler = DummyScheduler()
    state = {"ui_min_interval_minutes": 15}
    service = _service_for(
        state,
        scheduler,
        set_ui=lambda *_args, **_kwargs: None,
        apply_update=lambda *_args, **_kwargs: None,
        download_update=lambda *_args, **_kwargs: None,
    )
    service.schedule_update_check(5)
    assert scheduler.scheduled == [("update_check", 15 * 60 * 1000)]


def test_schedule_update_check_cancels_on_zero():
    scheduler = DummyScheduler()
    state = {"ui_min_interval_minutes": 10}
    service = _service_for(
        state,
        scheduler,
        set_ui=lambda *_args, **_kwargs: None,
        apply_update=lambda *_args, **_kwargs: None,
        download_update=lambda *_args, **_kwargs: None,
    )
    service.schedule_update_check(0)
    assert scheduler.canceled == ["update_check"]


def test_check_updates_without_repo_sets_message(monkeypatch):
    scheduler = DummyScheduler()
    state = {"github_repo": ""}
    seen = {}

    def capture(button_text, status):
        seen["button"] = button_text
        seen["status"] = status

    service = _service_for(
        state,
        scheduler,
        set_ui=capture,
        apply_update=lambda *_args, **_kwargs: None,
        download_update=lambda *_args, **_kwargs: None,
    )
    service.check_updates(manual=True)
    assert seen["status"] == "Update channel not configured"


def test_check_updates_triggers_download(monkeypatch):
    scheduler = DummyScheduler()
    state = {"github_repo": "owner/repo", "auto_update_enabled": True}
    applied = {"path": None}
    downloaded = {"count": 0}

    class Info:
        ok = True
        version = "9.9.9"
        download_url = "https://example.com/update"
        message = ""

    monkeypatch.setattr(update_service, "fetch_github_release", lambda *_a, **_k: Info)
    monkeypatch.setattr(update_service, "get_github_token", lambda *_a, **_k: "")

    def download_update(_url, _dir, token=""):
        downloaded["count"] += 1
        return "payload"

    def apply_update(path):
        applied["path"] = path

    service = _service_for(
        state,
        scheduler,
        set_ui=lambda *_args, **_kwargs: None,
        apply_update=apply_update,
        download_update=download_update,
    )
    service.check_updates(manual=False)
    assert downloaded["count"] == 1
    assert applied["path"] == "payload"


def test_check_updates_manual_does_not_auto_apply(monkeypatch):
    scheduler = DummyScheduler()
    state = {"github_repo": "owner/repo", "auto_update_enabled": True}
    downloaded = {"count": 0}

    class Info:
        ok = True
        version = "9.9.9"
        download_url = "https://example.com/update"
        message = ""

    monkeypatch.setattr(update_service, "fetch_github_release", lambda *_a, **_k: Info)
    monkeypatch.setattr(update_service, "get_github_token", lambda *_a, **_k: "")

    def download_update(_url, _dir, token=""):
        downloaded["count"] += 1
        return "payload"

    service = _service_for(
        state,
        scheduler,
        set_ui=lambda *_args, **_kwargs: None,
        apply_update=lambda *_args, **_kwargs: None,
        download_update=download_update,
    )
    service.check_updates(manual=True)
    assert downloaded["count"] == 0
