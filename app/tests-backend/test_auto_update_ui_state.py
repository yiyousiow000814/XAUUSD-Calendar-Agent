import logging
import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest

APP_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_DIR))

import web_backend  # noqa: E402


@pytest.fixture()
def backend(monkeypatch):
    monkeypatch.setattr(
        web_backend, "load_config", lambda: {"settings_auto_save": True}
    )
    monkeypatch.setattr(web_backend, "save_config", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        web_backend, "get_selected_output_dir_last_sync_at", lambda _state: ""
    )
    logger = logging.getLogger("test-backend")
    logger.addHandler(logging.NullHandler())
    monkeypatch.setattr(web_backend, "setup_logger", lambda *_args, **_kwargs: logger)
    instance = web_backend.WebAgentBackend()
    instance._request_snapshot_rebuild = lambda *_args, **_kwargs: None
    instance._emit_modal_event = lambda *_args, **_kwargs: None
    return instance


def test_auto_update_skips_without_ui_state(backend):
    backend._ui_state_seen_at = None
    assert backend._should_auto_apply_update() == (False, False)


def test_auto_update_applies_when_hidden(backend):
    now = datetime.now()
    backend._ui_state_seen_at = now
    backend._ui_visible = False
    backend._ui_last_input_at = now
    assert backend._should_auto_apply_update() == (True, True)


def test_auto_update_applies_when_idle(backend):
    now = datetime.now()
    backend._ui_state_seen_at = now
    backend._ui_visible = True
    backend._ui_last_input_at = now - timedelta(
        minutes=web_backend.AUTO_UPDATE_IDLE_MINUTES + 1
    )
    assert backend._should_auto_apply_update() == (True, False)


def test_auto_update_skips_when_active(backend):
    now = datetime.now()
    backend._ui_state_seen_at = now
    backend._ui_visible = True
    backend._ui_last_input_at = now - timedelta(minutes=1)
    assert backend._should_auto_apply_update() == (False, False)


def test_prompt_update_available_sets_modal_and_notice(backend):
    now = datetime.now()
    backend._ui_state_seen_at = now
    backend._ui_visible = True
    backend._ui_focused = True
    backend._ui_last_input_at = now
    captured = {"modal": None, "notices": []}

    def capture_modal(title, message, tone="info"):
        captured["modal"] = {"title": title, "message": message, "tone": tone}

    def capture_notice(message, level="INFO"):
        captured["notices"].append({"message": message, "level": level})

    backend._set_ui_modal = capture_modal
    backend._append_notice = capture_notice

    backend._maybe_prompt_update_available("1.2.3")

    assert captured["modal"] is not None
    assert captured["modal"]["title"] == "Update available"
    assert "v1.2.3" in captured["modal"]["message"]
    assert captured["notices"] == [
        {"message": "Update available: 1.2.3", "level": "INFO"}
    ]


def test_prompt_update_available_skips_when_idle(backend):
    now = datetime.now()
    backend._ui_state_seen_at = now
    backend._ui_visible = True
    backend._ui_focused = True
    backend._ui_last_input_at = now - timedelta(seconds=120)
    backend._set_ui_modal = lambda *_args, **_kwargs: pytest.fail(
        "Modal should not be set"
    )
    backend._append_notice = lambda *_args, **_kwargs: pytest.fail(
        "Notice should not be added"
    )
    backend._maybe_prompt_update_available("1.2.3")
