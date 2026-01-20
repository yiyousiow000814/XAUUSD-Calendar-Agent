from __future__ import annotations

from typing import Callable


class TimerManager:
    def __init__(self, root) -> None:
        self._root = root
        self._timers: dict[str, str] = {}

    def schedule(self, key: str, delay_ms: int, callback: Callable[[], None]) -> None:
        self.cancel(key)
        if delay_ms <= 0:
            return

        def _run() -> None:
            self._timers.pop(key, None)
            callback()

        self._timers[key] = self._root.after(delay_ms, _run)

    def schedule_interval(
        self, key: str, delay_ms: int, callback: Callable[[], None]
    ) -> None:
        self.cancel(key)
        if delay_ms <= 0:
            return

        def _tick() -> None:
            try:
                callback()
            finally:
                self._timers[key] = self._root.after(delay_ms, _tick)

        self._timers[key] = self._root.after(delay_ms, _tick)

    def cancel(self, key: str) -> None:
        timer_id = self._timers.pop(key, None)
        if timer_id is None:
            return
        try:
            self._root.after_cancel(timer_id)
        except Exception:
            pass

    def cancel_all(self) -> None:
        for key in list(self._timers.keys()):
            self.cancel(key)
