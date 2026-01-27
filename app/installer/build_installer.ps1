param(
    [string]$RepoRoot = (Resolve-Path ".")
)

$ErrorActionPreference = "Stop"

$cargoBin = Join-Path $env:USERPROFILE ".cargo\\bin"
if (Test-Path $cargoBin) {
    $env:PATH = "$cargoBin;$env:PATH"
}

$setupOut = Join-Path $RepoRoot "Setup.exe"
$appOut = Join-Path $RepoRoot "XAUUSD Calendar Agent.exe"
$tauriRoot = Join-Path $RepoRoot "app\\tauri"
$bundleRoot = Join-Path $tauriRoot "src-tauri\\target\\release\\bundle"
$releaseExe = Join-Path $tauriRoot "src-tauri\\target\\release\\xauusd_calendar_agent.exe"

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm not found. Install Node.js first."
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw "cargo not found. Install Rust (rustup) first."
}
if (-not (Get-Command link.exe -ErrorAction SilentlyContinue)) {
    throw @"
MSVC linker not found (link.exe). Install Visual Studio Build Tools with C++ support, then re-run.

Recommended (winget):
  winget install -e --id Microsoft.VisualStudio.2022.BuildTools --accept-package-agreements --accept-source-agreements

Then open "Developer PowerShell for VS 2022" (or restart the terminal) and run this script again.
"@
}
if (-not (Test-Path (Join-Path $RepoRoot "app\\webui\\package.json"))) {
    throw "Web UI not found at app\\webui."
}
if (-not (Test-Path (Join-Path $tauriRoot "package.json"))) {
    throw "Tauri project not found at tauri\\package.json."
}

# Best-effort: close any previous running instance so the build can overwrite artifacts.
Get-Process |
    Where-Object {
        $_.ProcessName -like "XAUUSD*" -or
        $_.ProcessName -like "xauusd_calendar_agent*"
    } |
    Stop-Process -Force -ErrorAction SilentlyContinue

if (-not (Test-Path (Join-Path $RepoRoot "app\\webui\\node_modules"))) {
    Push-Location (Join-Path $RepoRoot "app\\webui")
    try {
        npm install
    } finally {
        Pop-Location
    }
}

Push-Location $tauriRoot
try {
    npm install
    npm run build
} finally {
    Pop-Location
}

if (-not (Test-Path $bundleRoot)) {
    throw "Tauri bundle output not found at $bundleRoot"
}

$candidates = @()
$nsisDir = Join-Path $bundleRoot "nsis"
if (Test-Path $nsisDir) {
    $candidates += Get-ChildItem -Path $nsisDir -Filter *.exe -Recurse -ErrorAction SilentlyContinue
}
$msiDir = Join-Path $bundleRoot "msi"
if (Test-Path $msiDir) {
    $candidates += Get-ChildItem -Path $msiDir -Filter *.msi -Recurse -ErrorAction SilentlyContinue
}

if (-not $candidates -or $candidates.Count -eq 0) {
    throw "No installer artifacts found under $bundleRoot (expected nsis/*.exe or msi/*.msi)."
}

$picked = $candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Copy-Item -Force $picked.FullName $setupOut

if (-not (Test-Path $setupOut)) {
    throw "Failed to write Setup.exe to repo root."
}

if (-not (Test-Path $releaseExe)) {
    throw "Built app executable not found at $releaseExe"
}
Copy-Item -Force $releaseExe $appOut
if (-not (Test-Path $appOut)) {
    throw "Failed to write XAUUSD Calendar Agent.exe to repo root."
}

Write-Host "OK: $setupOut"
Write-Host "OK: $appOut"
