# XAUUSD Calendar Agent (Windows)

Lightweight desktop agent to keep `data/Economic_Calendar` synced with the latest
`main` branch and mirror the calendar output into a user-selected folder.

## Features
- Pulls the calendar repo from GitHub on demand.
- Mirrors `data/Economic_Calendar` to `<output_dir>\\data\\Economic_Calendar` (add/replace/delete).
- Shows last pull/sync time and an activity log.

## Default Paths
- App config: `%APPDATA%\\XAUUSDCalendar\\config.json`
- Logs: `%APPDATA%\\XAUUSDCalendar\\logs\\app.log`

## Build (Windows)
Recommended: build an installer so users run a single setup file.

1) Install Node.js (for the web UI build).
2) Install Rust (rustup) for the Tauri build.
3) Run:

```powershell
.\app\installer\build_installer.ps1
```

The installer will be written to `Setup.exe` in the repo root.

## Update Channel
Installer builds are published via GitHub Releases as `Setup.exe`.

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
- Uninstall the app from Windows “Apps & features” / “Installed apps”.
- Remove config and logs: `%APPDATA%\\XAUUSDCalendar\\`.
