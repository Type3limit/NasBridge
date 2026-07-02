$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$BridgeRoot = Join-Path $RepoRoot "music-lib-bridge"
$GoBin = Join-Path $RepoRoot ".local\tools\go1.26.4\go\bin"
$GoExe = Join-Path $GoBin "go.exe"

if (-not (Test-Path -LiteralPath $BridgeRoot)) {
  throw "music-lib-bridge directory not found: $BridgeRoot"
}

if (-not (Test-Path -LiteralPath $GoExe)) {
  $foundGo = Get-Command go.exe -ErrorAction SilentlyContinue
  if (-not $foundGo) {
    throw "go.exe not found. Expected portable Go at $GoExe"
  }
  $GoExe = $foundGo.Source
} else {
  $env:PATH = "$GoBin;$env:PATH"
}

$env:GOMODCACHE = Join-Path $RepoRoot ".local\go\pkg\mod"
$env:GOCACHE = Join-Path $RepoRoot ".local\go\build-cache"
$env:MUSIC_LIB_BRIDGE_PORT = if ($env:MUSIC_LIB_BRIDGE_PORT) { $env:MUSIC_LIB_BRIDGE_PORT } else { "46231" }
$env:MUSIC_LIB_BRIDGE_ADDR = if ($env:MUSIC_LIB_BRIDGE_ADDR) { $env:MUSIC_LIB_BRIDGE_ADDR } else { "127.0.0.1:$($env:MUSIC_LIB_BRIDGE_PORT)" }

New-Item -ItemType Directory -Force -Path $env:GOMODCACHE, $env:GOCACHE | Out-Null
Set-Location -LiteralPath $BridgeRoot

Write-Host "[music-lib-bridge] cwd: $BridgeRoot"
Write-Host "[music-lib-bridge] url: http://$($env:MUSIC_LIB_BRIDGE_ADDR)"
Write-Host "[music-lib-bridge] QQ_COOKIE source: $BridgeRoot\.env"
Write-Host "[music-lib-bridge] cookie hot-reload: enabled when .env changes"
Write-Host ""

& $GoExe run .
exit $LASTEXITCODE
