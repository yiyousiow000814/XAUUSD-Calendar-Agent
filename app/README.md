# XAUUSD Calendar Agent (Windows)

Lightweight desktop agent to keep `data/Economic_Calendar` synced with the latest
`main` branch and mirror the calendar output into a user-selected folder.

## Features
- Pulls `origin/main` on startup when the repo is stale (> 1 day) or has new commits.
- Mirrors `data/Economic_Calendar` to `<output_dir>\\data\\Economic_Calendar` (add/replace/delete).
- Shows last pull/sync time and a live activity log.
- Optional startup task via Windows Task Scheduler.
- Closing the window minimizes the app to the system tray.
- Optional desktop shortcut prompt on first launch.
- Debug logging to `%APPDATA%\\XAUUSDCalendar\\logs`.

## Default Paths
- App config: `%APPDATA%\\XAUUSDCalendar\\config.json`
- Logs: `%APPDATA%\\XAUUSDCalendar\\logs\\app.log`

## Build (Windows)
Recommended: build an installer so users only run a setup file.

1) Install Inno Setup 6 (one-time).
2) Install Node.js (for the web UI build).
3) Run the build script:

```powershell
pip install -r requirements-app.txt
.\scripts\build_installer.ps1
```

The installer will be under `installer\\output\\Setup-XAUUSD-Calendar-Agent.exe`.

## Update Channel
The agent checks GitHub Releases by default.

Requirements:
- Publish a release with the EXE asset named `XAUUSD Calendar Agent.exe` (or update
  `github_release_asset_name` in the config).
When auto update is enabled, the agent downloads the update and restarts to
apply it automatically.

The app checks for updates on startup. Periodic checks can be enabled by setting
`auto_update_interval_minutes` to a value greater than 0.

### Private Repos (GitHub Token)
If `github_repo` is private, provide a GitHub token so the app can access:
- Releases (`/releases/latest`) for update checks
- Repo archive (`/archive/refs/heads/<branch>.zip`) for calendar downloads in installed mode

Supported inputs:
- Config key: `github_token`

If the default branch is not `main`, set `github_branch` accordingly.

## Notes
- The sync is a mirror: files removed from the repo output are removed from the output dir.
- All timestamps shown in the UI are `DD-MM-YYYY HH:MM`.

## Uninstall (Manual)
- Delete the EXE file.
- Remove config and logs: `%APPDATA%\\XAUUSDCalendar\\`.
- If enabled, disable the startup task from the app or Windows Task Scheduler.
