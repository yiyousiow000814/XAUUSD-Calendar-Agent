param(
    [string]$SetupPath = (Join-Path (Resolve-Path ".") "Setup.exe")
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path "."

if (-not (Test-Path $SetupPath)) {
    throw "Setup.exe not found at $SetupPath. Run app/installer/build_installer.ps1 first."
}

$pythonCmd = Get-Command python -ErrorAction SilentlyContinue
if (-not $pythonCmd) {
    throw "python not found in PATH."
}

$root = Join-Path $env:TEMP ("xauusd_update_selftest_" + [guid]::NewGuid().ToString("N"))
$installDir = Join-Path $root "install"
$stagingRoot = Join-Path $root "staging_root"
$stagedDir = Join-Path $stagingRoot "stage"
$backupDir = Join-Path $root "backup"
$logPath = Join-Path $root "setup.log"

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$userDataDir = Join-Path $installDir "user-data"
New-Item -ItemType Directory -Force -Path $userDataDir | Out-Null
Set-Content -Path (Join-Path $userDataDir "marker.txt") -Value "keep"

$setupArgs = "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR=`"$installDir`" /LOG=`"$logPath`""
$proc = Start-Process -FilePath $SetupPath -ArgumentList $setupArgs -PassThru -WindowStyle Hidden
$waited = Wait-Process -Id $proc.Id -Timeout 120 -ErrorAction SilentlyContinue
if (-not $waited) {
    if (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        throw "Setup.exe timed out. Log: $logPath"
    }
}
if ($proc.ExitCode -ne 0) {
    throw "Setup.exe failed with exit code $($proc.ExitCode). Log: $logPath"
}

$exePath = Join-Path $installDir "XAUUSD Calendar Agent.exe"
$dllDir = Join-Path $installDir "_internal"
$dllPath = Join-Path $dllDir "python312.dll"
if (-not (Test-Path $exePath)) {
    throw "Installed EXE missing: $exePath"
}
if (-not (Test-Path $dllPath)) {
    throw "python312.dll missing: $dllPath"
}

$pythonCheck = @"
import os
import ctypes

dll_dir = r"$dllDir"
dll_path = r"$dllPath"
os.add_dll_directory(dll_dir)
ctypes.WinDLL(dll_path)
print("ok")
"@
$pythonCheck | python -
if ($LASTEXITCODE -ne 0) {
    throw "Python DLL load failed for $dllPath"
}

$stagedLogPath = Join-Path $root "setup_staged.log"
$stagedArgs = "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR=`"$stagedDir`" /LOG=`"$stagedLogPath`""
$stagedProc = Start-Process -FilePath $SetupPath -ArgumentList $stagedArgs -PassThru -WindowStyle Hidden
$waited = Wait-Process -Id $stagedProc.Id -Timeout 120 -ErrorAction SilentlyContinue
if (-not $waited) {
    if (Get-Process -Id $stagedProc.Id -ErrorAction SilentlyContinue) {
        Stop-Process -Id $stagedProc.Id -Force -ErrorAction SilentlyContinue
        throw "Staged Setup.exe timed out. Log: $stagedLogPath"
    }
}
if ($stagedProc.ExitCode -ne 0) {
    throw "Staged Setup.exe failed with exit code $($stagedProc.ExitCode). Log: $stagedLogPath"
}

if (-not (Test-Path (Join-Path $stagedDir "XAUUSD Calendar Agent.exe"))) {
    throw "Staged EXE missing: $stagedDir"
}

$testDesktop = Join-Path $root "desktop"
$testStartMenu = Join-Path $root "startmenu"
New-Item -ItemType Directory -Force -Path $testDesktop | Out-Null
New-Item -ItemType Directory -Force -Path $testStartMenu | Out-Null
$env:TEST_DESKTOP_DIR = $testDesktop
$env:TEST_START_MENU_DIR = $testStartMenu

$shell = New-Object -ComObject WScript.Shell
$legacyDesktopShortcut = Join-Path $testDesktop "XAUUSD Calendar Agent.lnk"
$legacyStartShortcut = Join-Path $testStartMenu "XAUUSD Calendar Agent\\XAUUSD Calendar Agent.lnk"
New-Item -ItemType Directory -Force -Path (Split-Path $legacyStartShortcut) | Out-Null
$legacyDesktop = $shell.CreateShortcut($legacyDesktopShortcut)
$legacyDesktop.TargetPath = Join-Path $stagedDir "XAUUSD Calendar Agent.exe"
$legacyDesktop.WorkingDirectory = $stagedDir
$legacyDesktop.Save()
$legacyStart = $shell.CreateShortcut($legacyStartShortcut)
$legacyStart.TargetPath = Join-Path $stagedDir "XAUUSD Calendar Agent.exe"
$legacyStart.WorkingDirectory = $stagedDir
$legacyStart.Save()

$switchLogPath = Join-Path $root "update_switch_test.log"
$switchScriptPath = Join-Path $root "apply_staged_update_test.cmd"
$userDataBackup = Join-Path $root "user_data_backup"
$pythonScript = @"
import sys
from pathlib import Path

repo_root = Path(r"$RepoRoot")
sys.path.insert(0, str(repo_root / "app"))
from web_backend import WebAgentBackend

stage_root = Path(r"$stagedDir")
install_dir = Path(r"$installDir")
backup_dir = Path(r"$backupDir")
user_data_backup = Path(r"$userDataBackup")
log_path = Path(r"$switchLogPath")
script_path = Path(r"$switchScriptPath")

script = WebAgentBackend._build_staged_update_script(
    stage_root,
    install_dir,
    backup_dir,
    user_data_backup,
    log_path,
    "3F6B2F3A-2A0F-4A93-9C5D-7E1D1C7F7D0E",
    "",
    999999,
    Path(r"$SetupPath"),
)
script_path.write_text(script, encoding="utf-8")
"@
$pythonScript | python -
if ($LASTEXITCODE -ne 0) {
    throw "Failed to generate update switch script."
}

if (-not (Test-Path $switchScriptPath)) {
    throw "Update switch script missing: $switchScriptPath"
}
$switchProc = Start-Process -FilePath $switchScriptPath -PassThru -WindowStyle Hidden
$waited = Wait-Process -Id $switchProc.Id -Timeout 120 -ErrorAction SilentlyContinue
if (-not $waited) {
    if (Get-Process -Id $switchProc.Id -ErrorAction SilentlyContinue) {
        Stop-Process -Id $switchProc.Id -Force -ErrorAction SilentlyContinue
        throw "Update switch script timed out."
    }
}
if (Test-Path $switchLogPath) {
    $switchLog = Get-Content -Path $switchLogPath -ErrorAction SilentlyContinue
    if ($switchLog -match "Failed to move" -or $switchLog -match "Staged exe missing") {
        throw "Update switch script reported errors. Log: $switchLogPath"
    }
    if ($switchLog -match "SHORTCUTS_FAILED") {
        throw "Update switch script failed to update shortcuts. Log: $switchLogPath"
    }
}

$removed = $false
for ($i = 0; $i -lt 5; $i++) {
    if (-not (Test-Path $stagedDir)) {
        $removed = $true
        break
    }
    Start-Sleep -Seconds 1
}
if (-not $removed) {
    throw "Staged dir still exists after swap: $stagedDir"
}

$rootRemoved = $false
for ($i = 0; $i -lt 5; $i++) {
    if (-not (Test-Path $stagingRoot)) {
        $rootRemoved = $true
        break
    }
    Start-Sleep -Seconds 1
}
if (-not $rootRemoved) {
    throw "Staging root still exists after swap: $stagingRoot"
}

$backupUserData = Join-Path $backupDir "user-data"
$installUserData = Join-Path $installDir "user-data"
if (Test-Path $backupUserData) {
    if (-not (Test-Path $installUserData)) {
        New-Item -ItemType Directory -Force -Path $installUserData | Out-Null
    }
    Move-Item -Path $backupUserData\* -Destination $installUserData -Force
}

$markerPath = Join-Path $installDir "user-data\\marker.txt"
if (-not (Test-Path $markerPath)) {
    throw "user-data marker missing after swap"
}

$desktopShortcut = Join-Path $testDesktop "XAUUSD Calendar Agent.lnk"
$startShortcut = Join-Path $testStartMenu "XAUUSD Calendar Agent\\XAUUSD Calendar Agent.lnk"
foreach ($shortcutPath in @($desktopShortcut, $startShortcut)) {
    if (-not (Test-Path $shortcutPath)) {
        throw "Shortcut missing after swap: $shortcutPath"
    }
    $shortcut = $shell.CreateShortcut($shortcutPath)
    if ($shortcut.TargetPath -ne $exePath) {
        throw "Shortcut target mismatch: $shortcutPath"
    }
}

$stagingRoot2 = Join-Path $root "staging_root_2"
$stagedDir2 = Join-Path $stagingRoot2 "stage"
$stagedLogPath2 = Join-Path $root "setup_staged_2.log"
$stagedArgs2 = "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR=`"$stagedDir2`" /LOG=`"$stagedLogPath2`""
$stagedProc2 = Start-Process -FilePath $SetupPath -ArgumentList $stagedArgs2 -PassThru -WindowStyle Hidden
$waited = Wait-Process -Id $stagedProc2.Id -Timeout 120 -ErrorAction SilentlyContinue
if (-not $waited) {
    if (Get-Process -Id $stagedProc2.Id -ErrorAction SilentlyContinue) {
        Stop-Process -Id $stagedProc2.Id -Force -ErrorAction SilentlyContinue
        throw "Staged Setup.exe timed out (mirror). Log: $stagedLogPath2"
    }
}
if ($stagedProc2.ExitCode -ne 0) {
    throw "Staged Setup.exe failed with exit code $($stagedProc2.ExitCode) (mirror). Log: $stagedLogPath2"
}
if (-not (Test-Path (Join-Path $stagedDir2 "XAUUSD Calendar Agent.exe"))) {
    throw "Staged EXE missing (mirror): $stagedDir2"
}

$env:SIMULATE_MOVE_FAIL = "1"
$switchLogPath2 = Join-Path $root "update_switch_test_mirror.log"
$switchScriptPath2 = Join-Path $root "apply_staged_update_test_mirror.cmd"
$userDataBackup2 = Join-Path $root "user_data_backup_mirror"
$pythonScript2 = @"
import sys
from pathlib import Path

repo_root = Path(r"$RepoRoot")
sys.path.insert(0, str(repo_root / "app"))
from web_backend import WebAgentBackend

stage_root = Path(r"$stagedDir2")
install_dir = Path(r"$installDir")
backup_dir = Path(r"$backupDir")
user_data_backup = Path(r"$userDataBackup2")
log_path = Path(r"$switchLogPath2")
script_path = Path(r"$switchScriptPath2")

script = WebAgentBackend._build_staged_update_script(
    stage_root,
    install_dir,
    backup_dir,
    user_data_backup,
    log_path,
    "3F6B2F3A-2A0F-4A93-9C5D-7E1D1C7F7D0E",
    "",
    999998,
    Path(r"$SetupPath"),
)
script_path.write_text(script, encoding="utf-8")
"@
$pythonScript2 | python -
if ($LASTEXITCODE -ne 0) {
    throw "Failed to generate update switch script (mirror)."
}

if (-not (Test-Path $switchScriptPath2)) {
    throw "Update switch script missing (mirror): $switchScriptPath2"
}
$switchProc2 = Start-Process -FilePath $switchScriptPath2 -PassThru -WindowStyle Hidden
$waited = Wait-Process -Id $switchProc2.Id -Timeout 120 -ErrorAction SilentlyContinue
if (-not $waited) {
    if (Get-Process -Id $switchProc2.Id -ErrorAction SilentlyContinue) {
        Stop-Process -Id $switchProc2.Id -Force -ErrorAction SilentlyContinue
        throw "Update switch script timed out (mirror)."
    }
}
if (Test-Path $switchLogPath2) {
    $switchLog2 = Get-Content -Path $switchLogPath2 -ErrorAction SilentlyContinue
    if ($switchLog2 -match "MIRROR_SWAP_FAILED") {
        throw "Mirror swap failed. Log: $switchLogPath2"
    }
    if ($switchLog2 -match "SHORTCUTS_FAILED") {
        throw "Mirror swap failed to update shortcuts. Log: $switchLogPath2"
    }
}
Remove-Item Env:SIMULATE_MOVE_FAIL -ErrorAction SilentlyContinue

$removed = $false
for ($i = 0; $i -lt 5; $i++) {
    if (-not (Test-Path $stagedDir2)) {
        $removed = $true
        break
    }
    Start-Sleep -Seconds 1
}
if (-not $removed) {
    throw "Staged dir still exists after mirror swap: $stagedDir2"
}

$rootRemoved = $false
for ($i = 0; $i -lt 5; $i++) {
    if (-not (Test-Path $stagingRoot2)) {
        $rootRemoved = $true
        break
    }
    Start-Sleep -Seconds 1
}
if (-not $rootRemoved) {
    throw "Staging root still exists after mirror swap: $stagingRoot2"
}

foreach ($shortcutPath in @($desktopShortcut, $startShortcut)) {
    if (-not (Test-Path $shortcutPath)) {
        throw "Shortcut missing after mirror swap: $shortcutPath"
    }
    $shortcut = $shell.CreateShortcut($shortcutPath)
    if ($shortcut.TargetPath -ne $exePath) {
        throw "Shortcut target mismatch after mirror swap: $shortcutPath"
    }
}

$uninstallKey = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{3F6B2F3A-2A0F-4A93-9C5D-7E1D1C7F7D0E}_is1"
if (Test-Path $uninstallKey) {
    $installLocation = (Get-ItemProperty -Path $uninstallKey -Name InstallLocation -ErrorAction SilentlyContinue).InstallLocation
    if ($installLocation) {
        $normalized = $installLocation.TrimEnd("\", "/")
        if ($normalized -ne $installDir) {
            throw "InstallLocation registry mismatch: $installLocation"
        }
    }
}

$uninstaller = Join-Path $installDir "unins000.exe"
if (Test-Path $uninstaller) {
    $uninstallProc = Start-Process -FilePath $uninstaller -ArgumentList "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART" -PassThru -WindowStyle Hidden
    $waited = Wait-Process -Id $uninstallProc.Id -Timeout 60 -ErrorAction SilentlyContinue
    if (-not $waited) {
        if (Get-Process -Id $uninstallProc.Id -ErrorAction SilentlyContinue) {
            Stop-Process -Id $uninstallProc.Id -Force -ErrorAction SilentlyContinue
            throw "Uninstaller timed out."
        }
    }
}
for ($i = 0; $i -lt 10; $i++) {
    if (-not (Test-Path $installDir)) {
        break
    }
    Start-Sleep -Seconds 1
}
if (Test-Path $installDir) {
    throw "Uninstall did not remove install dir: $installDir"
}

Remove-Item -Recurse -Force $testDesktop -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $testStartMenu -ErrorAction SilentlyContinue
Remove-Item Env:TEST_DESKTOP_DIR -ErrorAction SilentlyContinue
Remove-Item Env:TEST_START_MENU_DIR -ErrorAction SilentlyContinue

Remove-Item -Recurse -Force $root
Write-Host "Update install self-test passed."
