import os
from datetime import datetime, timedelta
from pathlib import Path

from agent.calendar_update import update_calendar_from_github
from agent.config import (
    get_default_repo_path,
    get_github_token,
    parse_iso_time,
    save_config,
    set_output_dir_last_sync_at,
    to_iso_time,
)
from agent.git_ops import fetch_origin, get_head_sha, get_origin_sha, pull_origin_main
from agent.sync import mirror_sync
from agent.updater import fetch_github_branch_head_sha


class SyncMixin:
    @staticmethod
    def _calendar_refreshed_message(files: int, reason: str = "") -> str:
        return "Events updated to latest"

    def _run_task(self, func, label: str) -> None:
        def wrapper() -> None:
            self._set_status(f"Running: {label}")
            try:
                func()
            finally:
                self._set_status("Idle")

        self.scheduler.run_in_background(wrapper)

    def _pull_now(self) -> None:
        self._run_task(self._pull_and_sync, "Manual pull")

    def _sync_now(self) -> None:
        self._run_task(self._sync_only, "Manual sync")

    def _schedule_periodic_check(self) -> None:
        interval = int(self.state.get("check_interval_minutes", 360))
        min_interval = int(self.state.get("ui_min_interval_minutes", 10) or 10)
        delay_ms = max(interval, min_interval) * 60 * 1000
        if interval <= 0:
            self.scheduler.cancel("periodic_check")
            return

        def periodic() -> None:
            self._run_task(self._maybe_pull_and_sync, "Auto check")

        self.scheduler.schedule_interval("periodic_check", delay_ms, periodic)

    def _maybe_pull_and_sync(self) -> None:
        if not self.state.get("enable_temporary_path", False):
            self._maybe_refresh_calendar_only()
            return
        repo_path = self._resolve_repo_path()
        if not repo_path:
            self._append_notice("Repository path not configured")
            return
        if not (repo_path / ".git").exists():
            install_dir = (
                Path(get_default_repo_path()) if get_default_repo_path() else None
            )
            if not install_dir or not self._is_installed_dir(install_dir):
                self._append_notice(
                    "Update skipped: this installation does not support auto-update"
                )
                return

            last_pull = parse_iso_time(self.state.get("last_pull_at", ""))
            stale = True
            if last_pull:
                stale = datetime.now() - last_pull > timedelta(
                    days=self.state.get("auto_pull_days", 1)
                )
            if not stale:
                self._append_notice("Calendar is up to date")
                return

            repo = (self.state.get("github_repo") or "").strip()
            branch = (self.state.get("github_branch") or "main").strip() or "main"
            if not repo:
                self._append_notice("GitHub repo not configured")
                return
            result = update_calendar_from_github(
                repo, branch, install_dir, token=get_github_token(self.state)
            )
            if not result.ok:
                self._append_notice(result.message)
                return

            self.state["last_pull_at"] = to_iso_time(datetime.now())
            save_config(self.state)
            self._append_notice(self._calendar_refreshed_message(result.files))
            if self.auto_sync_var.get() and self._get_output_dir():
                self._sync_only()
            self._refresh_calendar_data()
            return

        last_pull = parse_iso_time(self.state.get("last_pull_at", ""))
        stale = True
        if last_pull:
            stale = datetime.now() - last_pull > timedelta(
                days=self.state.get("auto_pull_days", 1)
            )

        self.logger.info("Checking remote updates (stale=%s)", stale)
        fetch = fetch_origin(repo_path)
        if not fetch.ok:
            self._append_notice(f"Fetch failed: {fetch.output}")
            self.logger.error(fetch.output)
            return
        self._track_successful_repo(repo_path)

        head = get_head_sha(repo_path)
        origin = get_origin_sha(repo_path)
        if not head.ok or not origin.ok:
            self._append_notice("Failed to read Git repository state")
            return

        needs_pull = head.output.strip() != origin.output.strip()
        if stale or needs_pull:
            self._pull_and_sync()
        else:
            self._append_notice("Repo already up to date")

    def _pull_and_sync(self) -> None:
        if not self.state.get("enable_temporary_path", False):
            self._pull_calendar_only(force=True)
            return
        repo_path = self._resolve_repo_path()
        if not repo_path:
            return
        if not (repo_path / ".git").exists():
            install_dir = (
                Path(get_default_repo_path()) if get_default_repo_path() else None
            )
            if not install_dir or not self._is_installed_dir(install_dir):
                self._append_notice(
                    "Update skipped: this installation does not support auto-update"
                )
                return
            repo = (self.state.get("github_repo") or "").strip()
            branch = (self.state.get("github_branch") or "main").strip() or "main"
            if not repo:
                self._append_notice("GitHub repo not configured")
                return
            result = update_calendar_from_github(
                repo, branch, install_dir, token=get_github_token(self.state)
            )
            if not result.ok:
                self._append_notice(result.message)
                return

            self.state["last_pull_at"] = to_iso_time(datetime.now())
            save_config(self.state)
            self._append_notice(self._calendar_refreshed_message(result.files))
            if self.auto_sync_var.get():
                output_dir = self._get_output_dir()
                if output_dir:
                    self._sync_only()
                else:
                    self._append_notice(
                        "Auto sync skipped: output directory not configured"
                    )
            self._refresh_calendar_data()
            return
        result = pull_origin_main(repo_path)
        if not result.ok:
            self._append_notice(f"Pull failed: {result.output}")
            self.logger.error(result.output)
            return
        self._track_successful_repo(repo_path)
        self._append_notice("Data update completed")
        self.logger.info(result.output)

        sha = get_head_sha(repo_path)
        if sha.ok:
            self.state["last_pull_sha"] = sha.output.strip()

        self.state["last_pull_at"] = to_iso_time(datetime.now())
        save_config(self.state)
        self._refresh_times()

        if self.auto_sync_var.get():
            output_dir = self._get_output_dir()
            if output_dir:
                self._sync_only()
            else:
                self._append_notice(
                    "Auto sync skipped: output directory not configured"
                )
        self._refresh_calendar_data()

    def _maybe_refresh_calendar_only(self) -> None:
        last_pull = parse_iso_time(self.state.get("last_pull_at", ""))
        stale = True
        if last_pull:
            stale = datetime.now() - last_pull > timedelta(
                days=self.state.get("auto_pull_days", 1)
            )
        if not stale:
            self._append_notice("Calendar is up to date")
            return
        self._pull_calendar_only(force=False)

    def _pull_calendar_only(self, force: bool) -> None:
        raw = (self.state.get("repo_path") or "").strip()
        if not raw:
            self._append_notice("Repository path not configured")
            return
        repo_path = Path(raw)
        repo = (self.state.get("github_repo") or "").strip()
        branch = (self.state.get("github_branch") or "main").strip() or "main"
        if not repo:
            self._append_notice("GitHub repo not configured")
            return
        token = get_github_token(self.state)
        sha_ok, sha_message, sha = fetch_github_branch_head_sha(
            repo, branch, token=token
        )
        if not sha_ok:
            self._append_notice(sha_message)
            return
        calendar_dir = repo_path / "data" / "Economic_Calendar"
        has_local_calendar = False
        try:
            has_local_calendar = calendar_dir.exists() and any(calendar_dir.iterdir())
        except OSError:
            has_local_calendar = False

        if sha and sha == (self.state.get("last_pull_sha") or "").strip():
            if (not force) and has_local_calendar:
                self.state["last_pull_at"] = to_iso_time(datetime.now())
                save_config(self.state)
                self._append_notice("Calendar is up to date")
                self._refresh_times()
                self._refresh_calendar_data()
                return
        result = update_calendar_from_github(repo, branch, repo_path, token=token)
        if not result.ok:
            self._append_notice(result.message)
            return
        self.state["last_pull_at"] = to_iso_time(datetime.now())
        self.state["last_pull_sha"] = sha
        save_config(self.state)
        self._append_notice(self._calendar_refreshed_message(result.files))
        if self.auto_sync_var.get() and self._get_output_dir():
            self._sync_only()
        self._refresh_times()
        self._refresh_calendar_data()

    def _sync_only(self) -> None:
        repo_path = self._resolve_repo_path()
        output_dir = self._get_output_dir()
        if not repo_path:
            return
        if not output_dir:
            self._append_notice("Output directory not configured")
            return

        src_dir = repo_path / "data" / "Economic_Calendar"
        managed_dir = output_dir / "data" / "Economic_Calendar"
        try:
            result = mirror_sync(src_dir, managed_dir)
        except FileNotFoundError:
            self._append_notice("Calendar source not found in repository")
            return
        self._track_successful_repo(repo_path)
        self._append_notice(
            f"Sync ok: +{result.copied} / -{result.deleted} / = {result.skipped}"
        )
        now = to_iso_time(datetime.now())
        self.state["last_sync_at"] = now
        set_output_dir_last_sync_at(self.state, output_dir, now)
        save_config(self.state)
        self._refresh_times()
        self._refresh_calendar_data()

    @staticmethod
    def _is_installed_dir(path: Path) -> bool:
        local = os.environ.get("LOCALAPPDATA") or ""
        if not local:
            return False
        expected = (Path(local) / "XAUUSDCalendarAgent").resolve()
        try:
            return path.resolve() == expected
        except OSError:
            return False
