from __future__ import annotations

from dataclasses import dataclass

from .event_scheduler import EventScheduler


@dataclass
class UiState:
    status_text: str = ""
    settings_status_text: str = ""
    update_button_text: str = ""
    update_status_text: str = ""


class UiStateService:
    def __init__(
        self,
        *,
        scheduler: EventScheduler,
        status_var,
        settings_status_var,
        update_button_var,
        update_status_var,
    ) -> None:
        self._scheduler = scheduler
        self._status_var = status_var
        self._settings_status_var = settings_status_var
        self._update_button_var = update_button_var
        self._update_status_var = update_status_var
        self.state = UiState()

    def set_status(self, text: str) -> None:
        self.state.status_text = text
        self._scheduler.call_soon(lambda: self._status_var.set(text))

    def set_settings_status(self, text: str) -> None:
        self.state.settings_status_text = text
        self._scheduler.call_soon(lambda: self._settings_status_var.set(text))

    def set_update_ui(self, button_text: str, status_text: str) -> None:
        self.state.update_button_text = button_text
        self.state.update_status_text = status_text

        def _update() -> None:
            self._update_button_var.set(button_text)
            self._update_status_var.set(status_text)

        self._scheduler.call_soon(_update)
