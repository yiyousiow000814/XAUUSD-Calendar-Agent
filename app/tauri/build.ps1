param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\\.."))
)

$ErrorActionPreference = "Stop"

$cargoBin = Join-Path $env:USERPROFILE ".cargo\\bin"
if (Test-Path $cargoBin) {
    $env:PATH = "$cargoBin;$env:PATH"
}

Push-Location $PSScriptRoot
try {
    npm install
    npm run build
} finally {
    Pop-Location
}
