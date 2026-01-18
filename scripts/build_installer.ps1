param(
    [string]$RepoRoot = (Resolve-Path ".")
)

$script = Join-Path $RepoRoot "app\installer\build_installer.ps1"
if (-not (Test-Path $script)) {
    throw "Missing installer script at $script"
}

& $script -RepoRoot $RepoRoot
