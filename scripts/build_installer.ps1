param(
    [string]$RepoRoot = (Resolve-Path ".")
)

$ErrorActionPreference = "Stop"

$exeName = "XAUUSD Calendar Agent.exe"
$icon = Join-Path $RepoRoot "app\assets\xauusd.ico"
$data = Join-Path $RepoRoot "app\assets"
$webuiRoot = Join-Path $RepoRoot "app\webui"
$webuiDist = Join-Path $webuiRoot "dist"
$buildRoot = Join-Path $env:TEMP "xauusd_build"
$issPath = Join-Path $RepoRoot "installer\XAUUSDCalendarAgent.iss"
$appRequirements = Join-Path $RepoRoot "requirements-app.txt"

New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null

Get-Process | Where-Object { $_.ProcessName -like "XAUUSD*" } | Stop-Process -Force -ErrorAction SilentlyContinue
$exePath = Join-Path $RepoRoot $exeName
if (Test-Path $exePath) {
    $removed = $false
    for ($attempt = 1; $attempt -le 10; $attempt++) {
        try {
            Remove-Item -Force $exePath -ErrorAction Stop
            $removed = $true
            break
        } catch {
            Start-Sleep -Milliseconds 400
        }
    }
    if (-not $removed -and (Test-Path $exePath)) {
        Write-Error "Failed to remove $exePath. Close any running instance and retry."
    }
}

cmd /c 'python -c "import webview" >nul 2>&1'
if ($LASTEXITCODE -ne 0) {
    $hint = "Missing dependency: pywebview. Install with: python -m pip install -r `"$appRequirements`""
    if (-not (Test-Path $appRequirements)) {
        $hint = "Missing dependency: pywebview. Install with: python -m pip install pywebview"
    }
    Write-Error $hint
}

cmd /c 'python -c "import pystray; from PIL import Image" >nul 2>&1'
if ($LASTEXITCODE -ne 0) {
    $hint = "Missing dependency: pystray/pillow. Install with: python -m pip install -r `"$appRequirements`""
    if (-not (Test-Path $appRequirements)) {
        $hint = "Missing dependency: pystray/pillow. Install with: python -m pip install pystray pillow"
    }
    Write-Error $hint
}

$appVersion = cmd /c 'python -c "import sys; sys.path.insert(0, ''app''); from agent.version import APP_VERSION; print(APP_VERSION)" 2>nul'
if ($LASTEXITCODE -ne 0) {
    throw "Failed to read app version (python exited with code $LASTEXITCODE)."
}
$appVersion = ($appVersion | Select-Object -First 1 | Out-String).Trim()
if (-not $appVersion) {
    throw "Failed to read app version from app\\agent\\version.py (empty output)."
}
if ($appVersion -notmatch '^\d+\.\d+\.\d+([+-].+)?$') {
    throw "Invalid app version '$appVersion' read from app\\agent\\version.py."
}

if (Test-Path (Join-Path $webuiRoot "package.json")) {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Error "npm not found. Install Node.js to build the web UI."
    }
    Push-Location $webuiRoot
    npm install
    npm run build
    Pop-Location
}
if (-not (Test-Path $webuiDist)) {
    Write-Error "Web UI dist not found at $webuiDist."
}

if (-not (Get-Command pyinstaller -ErrorAction SilentlyContinue)) {
    $hint = "pyinstaller not found. Install with: python -m pip install -r `"$appRequirements`""
    if (-not (Test-Path $appRequirements)) {
        $hint = "pyinstaller not found. Install with: python -m pip install pyinstaller"
    }
    Write-Error $hint
}

pyinstaller --onefile --noconsole --name "XAUUSD Calendar Agent" `
    --icon $icon `
    --add-data "$data;assets" `
    --add-data "$webuiDist;webui" `
    --hidden-import pystray._win32 `
    --distpath $RepoRoot `
    --workpath (Join-Path $buildRoot "build") `
    --specpath (Join-Path $buildRoot "spec") `
    (Join-Path $RepoRoot "app\web_app.py")

if ($LASTEXITCODE -ne 0) {
    Remove-Item -Recurse -Force $buildRoot -ErrorAction SilentlyContinue
    Write-Error "PyInstaller build failed."
}

Remove-Item -Recurse -Force $buildRoot

$pf86 = [Environment]::GetFolderPath("ProgramFilesX86")
$pf = [Environment]::GetFolderPath("ProgramFiles")
$isccCandidates = @(
    (Join-Path $pf86 "Inno Setup 6\ISCC.exe"),
    (Join-Path $pf "Inno Setup 6\ISCC.exe"),
    "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    "C:\Program Files\Inno Setup 6\ISCC.exe"
)
$iscc = $isccCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) {
    Write-Error "Inno Setup not found. Install it and try again."
}

Push-Location (Split-Path $issPath)
& $iscc "/DMyAppVersion=$appVersion" (Split-Path $issPath -Leaf)
Pop-Location

$setupPath = Join-Path $RepoRoot "Setup.exe"
if (-not (Test-Path $setupPath)) {
    Write-Error "Setup.exe not found in repo root after build."
}
