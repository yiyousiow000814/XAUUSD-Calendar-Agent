from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from agent.config import get_github_token, get_update_dir
from agent.updater import download_update, fetch_github_release
from agent.version import APP_VERSION

from .constants import APP_TITLE, parse_version
from .event_scheduler import EventScheduler


@dataclass
class UpdateState:
    available_version: str = ""
    download_url: str = ""
    in_progress: bool = False


class UpdateService:
    _UPDATE_CTA_CHECK = "Check for updates"
    _UPDATE_CTA_UPDATE = "Update now"

    def __init__(
        self,
        *,
        scheduler: EventScheduler,
        state: dict,
        set_ui: Callable[[str, str], None],
        append_notice: Callable[[str], None],
        notify_user: Callable[[str, str], None],
        apply_update: Callable[[object], None],
        run_task: Callable[[Callable[[], None], str], None],
    ) -> None:
        self._scheduler = scheduler
        self._state = state
        self._set_ui = set_ui
        self._append_notice = append_notice
        self._notify_user = notify_user
        self._apply_update = apply_update
        self._run_task = run_task
        self.state = UpdateState()

    def schedule_update_check(self, interval_minutes: int) -> None:
        if interval_minutes <= 0:
            self._scheduler.cancel("update_check")
            return
        min_interval = int(self._state.get("ui_min_interval_minutes", 10) or 10)
        delay_ms = max(interval_minutes, min_interval) * 60 * 1000

        def periodic() -> None:
            self._run_task(
                lambda: self.check_updates(manual=False), "Auto update check"
            )

        self._scheduler.schedule_interval("update_check", delay_ms, periodic)

    def request_manual_check(self) -> None:
        self._run_task(lambda: self.check_updates(manual=True), "Update check")

    def check_updates(self, manual: bool) -> None:
        repo = self._state.get("github_repo", "")
        if not repo:
            self._set_ui(self._UPDATE_CTA_CHECK, "Update channel not configured")
            return
        self._set_ui(self._UPDATE_CTA_CHECK, "Checking...")
        asset_name = self._state.get("github_release_asset_name", "") or None
        token = get_github_token(self._state)
        info = fetch_github_release(repo, asset_name=asset_name, token=token)

        if not info.ok:
            self._set_ui(self._UPDATE_CTA_CHECK, info.message)
            return
        current_version = APP_VERSION
        if parse_version(info.version) <= parse_version(current_version):
            self._set_ui(self._UPDATE_CTA_CHECK, "Up to date")
            return

        if not info.download_url:
            self._set_ui(self._UPDATE_CTA_CHECK, "Release missing download URL")
            return

        self.state.available_version = info.version or ""
        self.state.download_url = info.download_url
        self._set_ui(self._UPDATE_CTA_UPDATE, f"Update available: {info.version}")

        if manual:
            return
        if not self._state.get("auto_update_enabled", False):
            return
        self.download_and_apply_update(info.download_url, info.version or "")

    def download_and_apply_update(self, download_url: str, version: str) -> None:
        self._append_notice(f"Downloading update {version}")
        try:
            token = get_github_token(self._state)
            target = download_update(download_url, get_update_dir(), token=token)
        except Exception as exc:  # noqa: BLE001
            self._append_notice(f"Update download failed: {exc}")
            self._set_ui(self._UPDATE_CTA_UPDATE, f"Update failed: {exc}")
            return
        if version:
            self._notify_user(APP_TITLE, f"Update {version} downloaded, restarting")
        self._append_notice("Update downloaded. Applying now…")
        self._scheduler.call_soon(lambda: self._apply_update(target))
