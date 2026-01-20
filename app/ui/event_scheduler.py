from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Callable

from .timers import TimerManager


class EventScheduler:
    def __init__(self, root, max_workers: int = 4) -> None:
        self._root = root
        self._timers = TimerManager(root)
        self._executor = ThreadPoolExecutor(
            max_workers=max(1, max_workers),
            thread_name_prefix="ui-worker",
        )

    def schedule(self, key: str, delay_ms: int, callback: Callable[[], None]) -> None:
        self._timers.schedule(key, delay_ms, callback)

    def schedule_interval(
        self, key: str, delay_ms: int, callback: Callable[[], None]
    ) -> None:
        self._timers.schedule_interval(key, delay_ms, callback)

    def cancel(self, key: str) -> None:
        self._timers.cancel(key)

    def cancel_all(self) -> None:
        self._timers.cancel_all()

    def call_soon(self, callback: Callable[[], None]) -> None:
        self._root.after(0, callback)

    def run_in_background(self, func: Callable[[], None]) -> None:
        self._executor.submit(func)

    def shutdown(self) -> None:
        self._executor.shutdown(wait=False)
