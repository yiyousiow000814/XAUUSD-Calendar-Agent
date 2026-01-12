import os
import threading
from datetime import datetime, timedelta
from pathlib import Path

from agent.calendar_update import update_calendar_from_github
from agent.config import get_default_repo_path, parse_iso_time, save_config, to_iso_time
from agent.git_ops import fetch_origin, get_head_sha, get_origin_sha, pull_origin_main
from agent.sync import mirror_sync


class SyncMixin:

    def _run_task(self, func, label: str) -> None:
        def wrapper() -> None:
            self._set_status(f"Running: {label}")
            try:
                func()
            finally:
                self._set_status("Idle")

        thread = threading.Thread(target=wrapper, daemon=True)
        thread.start()

    def _pull_now(self) -> None:
        self._run_task(self._pull_and_sync, "Manual pull")

    def _sync_now(self) -> None:
        self._run_task(self._sync_only, "Manual sync")

    def _schedule_periodic_check(self) -> None:
        interval = int(self.state.get("check_interval_minutes", 360))
        delay_ms = max(interval, 10) * 60 * 1000

        def periodic() -> None:
            self._run_task(self._maybe_pull_and_sync, "Auto check")
            self.root.after(delay_ms, periodic)

        self.root.after(delay_ms, periodic)

    def _maybe_pull_and_sync(self) -> None:
        repo_path = self._resolve_repo_path()
        if not repo_path:
            self._append_notice("Repo path not set")
            return
        if not (repo_path / ".git").exists():
            install_dir = (
                Path(get_default_repo_path()) if get_default_repo_path() else None
            )
            if not install_dir or not self._is_installed_dir(install_dir):
                self._append_notice(
                    "Pull skipped: this copy is not installed via Setup.exe"
                )
                return

            last_pull = parse_iso_time(self.state.get("last_pull_at", ""))
            stale = True
            if last_pull:
                stale = datetime.now() - last_pull > timedelta(
                    days=self.state.get("auto_pull_days", 1)
                )
            if not stale:
                self._append_notice("Calendar already up to date")
                return

            repo = (self.state.get("github_repo") or "").strip()
            if not repo:
                self._append_notice("GitHub repo not configured")
                return
            result = update_calendar_from_github(repo, "main", install_dir)
            if not result.ok:
                self._append_notice(result.message)
                return

            self.state["last_pull_at"] = to_iso_time(datetime.now())
            save_config(self.state)
            self._append_notice(f"Calendar updated (+{result.files} files)")
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
            self._append_notice("Failed to read git state")
            return

        needs_pull = head.output.strip() != origin.output.strip()
        if stale or needs_pull:
            self._pull_and_sync()
        else:
            self._append_notice("Repo already up to date")

    def _pull_and_sync(self) -> None:
        repo_path = self._resolve_repo_path()
        if not repo_path:
            return
        if not (repo_path / ".git").exists():
            install_dir = (
                Path(get_default_repo_path()) if get_default_repo_path() else None
            )
            if not install_dir or not self._is_installed_dir(install_dir):
                self._append_notice(
                    "Pull skipped: this copy is not installed via Setup.exe"
                )
                return
            repo = (self.state.get("github_repo") or "").strip()
            if not repo:
                self._append_notice("GitHub repo not configured")
                return
            result = update_calendar_from_github(repo, "main", install_dir)
            if not result.ok:
                self._append_notice(result.message)
                return

            self.state["last_pull_at"] = to_iso_time(datetime.now())
            save_config(self.state)
            self._append_notice(f"Calendar updated (+{result.files} files)")
            if self.auto_sync_var.get():
                output_dir = self._get_output_dir()
                if output_dir:
                    self._sync_only()
                else:
                    self._append_notice("Auto sync skipped: output dir not set")
            self._refresh_calendar_data()
            return
        result = pull_origin_main(repo_path)
        if not result.ok:
            self._append_notice(f"Pull failed: {result.output}")
            self.logger.error(result.output)
            return
        self._track_successful_repo(repo_path)
        self._append_notice("Pull completed")
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
                self._append_notice("Auto sync skipped: output dir not set")
        self._refresh_calendar_data()

    def _sync_only(self) -> None:
        repo_path = self._resolve_repo_path()
        output_dir = self._get_output_dir()
        if not repo_path:
            return
        if not output_dir:
            self._append_notice("Output dir not set")
            return

        src_dir = repo_path / "data" / "Economic_Calendar"
        try:
            result = mirror_sync(src_dir, output_dir)
        except FileNotFoundError:
            self._append_notice("Calendar source not found in repo")
            return
        self._track_successful_repo(repo_path)
        self._append_notice(
            f"Sync ok: +{result.copied} / -{result.deleted} / = {result.skipped}"
        )
        self.state["last_sync_at"] = to_iso_time(datetime.now())
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
