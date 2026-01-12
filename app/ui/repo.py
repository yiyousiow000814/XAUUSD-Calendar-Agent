from pathlib import Path

from agent.config import get_repo_dir, save_config
from agent.git_ops import clone_repo


class RepoMixin:

    def _get_repo_path(self) -> Path | None:
        value = self.repo_var.get().strip()
        if not value:
            return None
        return Path(value)

    def _resolve_repo_path(self) -> Path | None:
        sync_value = self.sync_repo_var.get().strip()
        repo_value = self.repo_var.get().strip()
        if sync_value:
            return self._ensure_git_repo(Path(sync_value))
        if repo_value:
            repo_path = Path(repo_value)
            calendar_root = repo_path / "data" / "Economic_Calendar"
            if (repo_path / ".git").exists() or calendar_root.exists():
                return repo_path
            managed = get_repo_dir()
            self.sync_repo_var.set(str(managed))
            self.state["sync_repo_path"] = str(managed)
            save_config(self.state)
            return self._ensure_git_repo(managed)
        return None

    def _ensure_git_repo(self, repo_path: Path) -> Path | None:
        if (repo_path / ".git").exists():
            return repo_path
        repo = self.state.get("github_repo", "")
        if not repo:
            self._append_notice("GitHub repo not configured")
            return None
        if repo_path.exists():
            try:
                if any(repo_path.iterdir()):
                    self._append_notice(
                        "Selected folder is not a Git repository. Please choose an empty folder."
                    )
                    return None
                repo_path.rmdir()
            except OSError:
                self._append_notice(
                    "Selected folder is not a Git repository. Please choose an empty folder."
                )
                return None
        repo_path.parent.mkdir(parents=True, exist_ok=True)
        result = clone_repo(f"https://github.com/{repo}.git", repo_path)
        if not result.ok:
            self._append_notice(f"{result.message}: {result.output}")
            return None
        self._append_notice("Repo cloned for sync")
        return repo_path

    def _get_output_dir(self) -> Path | None:
        value = self.output_var.get().strip()
        if not value:
            return None
        return Path(value)
