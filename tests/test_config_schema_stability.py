import sys
from pathlib import Path


def _ensure_app_on_path() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    app_dir = repo_root / "app"
    if str(app_dir) not in sys.path:
        sys.path.insert(0, str(app_dir))


def test_config_schema_keys_are_stable_subset():
    """
    Guardrail: persisted config keys are a compatibility contract.

    We can add new keys, but renaming/removing existing keys requires an explicit
    migration (and should be rare).
    """

    _ensure_app_on_path()
    from agent.config import get_default_config

    expected_minimum_keys = {
        "schema_version",
        "repo_path",
        "output_dir",
        "output_dir_last_sync_at",
        "auto_pull_days",
        "check_interval_minutes",
        "auto_sync_after_pull",
        "debug",
        "last_pull_at",
        "last_pull_sha",
        "auto_update_enabled",
        "auto_update_interval_minutes",
        "theme_preference",
        "settings_auto_save",
        "calendar_timezone_mode",
        "calendar_utc_offset_minutes",
        "github_repo",
        "github_branch",
        "github_release_asset_name",
        "github_token",
        # Dev-mode settings (UI label can change; persisted keys must remain stable).
        "temporary_path",
        "enable_temporary_path",
        "temporary_path_confirmed_path",
        "temporary_path_confirmed_repo",
        "temporary_path_confirmed_mode",
        "temporary_path_confirmed_at",
        "temporary_path_history",
    }

    defaults = get_default_config()
    assert expected_minimum_keys.issubset(set(defaults)), (
        "Some persisted config keys were renamed/removed. "
        "If this is intentional, add an explicit migration in agent.config.load_config()."
    )
