$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$BridgeRoot = Join-Path $RepoRoot "music-lib-bridge"
$GoBin = Join-Path $RepoRoot ".local\tools\go1.26.4\go\bin"
$GoExe = Join-Path $GoBin "go.exe"
$RefreshCookieScript = Join-Path $PSScriptRoot "Refresh-QqMusicCookie.ps1"

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
$env:QQ_COOKIE_AUTO_REFRESH = if ($env:QQ_COOKIE_AUTO_REFRESH) { $env:QQ_COOKIE_AUTO_REFRESH } else { "1" }
$env:QQ_COOKIE_REFRESH_INTERVAL_MINUTES = if ($env:QQ_COOKIE_REFRESH_INTERVAL_MINUTES) { $env:QQ_COOKIE_REFRESH_INTERVAL_MINUTES } else { "60" }

New-Item -ItemType Directory -Force -Path $env:GOMODCACHE, $env:GOCACHE | Out-Null
Set-Location -LiteralPath $BridgeRoot

function Invoke-QqCookieRefresh {
  param([string]$Reason = "manual")

  if ($env:QQ_COOKIE_AUTO_REFRESH -eq "0") {
    return
  }
  if (-not (Test-Path -LiteralPath $RefreshCookieScript)) {
    Write-Warning "[music-lib-bridge] QQ cookie refresh script missing: $RefreshCookieScript"
    return
  }
  try {
    Write-Host "[music-lib-bridge] refreshing QQ_COOKIE ($Reason)..."
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $RefreshCookieScript -EnvFile (Join-Path $BridgeRoot ".env")
    if ($LASTEXITCODE -eq 0) {
      Write-Host "[music-lib-bridge] QQ_COOKIE refresh complete"
    } else {
      Write-Warning "[music-lib-bridge] QQ_COOKIE refresh exited with code $LASTEXITCODE"
    }
  } catch {
    Write-Warning "[music-lib-bridge] QQ_COOKIE refresh failed: $($_.Exception.Message)"
  }
}

Write-Host "[music-lib-bridge] cwd: $BridgeRoot"
Write-Host "[music-lib-bridge] url: http://$($env:MUSIC_LIB_BRIDGE_ADDR)"
Write-Host "[music-lib-bridge] QQ_COOKIE source: $BridgeRoot\.env"
Write-Host "[music-lib-bridge] cookie hot-reload: enabled when .env changes"
Write-Host "[music-lib-bridge] cookie auto-refresh: $($env:QQ_COOKIE_AUTO_REFRESH), interval=$($env:QQ_COOKIE_REFRESH_INTERVAL_MINUTES)m"
Write-Host ""

Invoke-QqCookieRefresh -Reason "startup"

$bridgeProcess = Start-Process -FilePath $GoExe -ArgumentList @("run", ".") -NoNewWindow -PassThru
$exitCode = 0
try {
  while (-not $bridgeProcess.HasExited) {
    $intervalSeconds = [Math]::Max(60, [int]([double]$env:QQ_COOKIE_REFRESH_INTERVAL_MINUTES * 60))
    try {
      Wait-Process -Id $bridgeProcess.Id -Timeout $intervalSeconds -ErrorAction Stop
    } catch {
    }
    if ($bridgeProcess.HasExited) {
      break
    }
    Invoke-QqCookieRefresh -Reason "timer"
  }
  $bridgeProcess.Refresh()
  $exitCode = if ($null -ne $bridgeProcess.ExitCode) { $bridgeProcess.ExitCode } else { 0 }
} finally {
  if ($bridgeProcess -and -not $bridgeProcess.HasExited) {
    Stop-Process -Id $bridgeProcess.Id -Force -ErrorAction SilentlyContinue
  }
}
exit $exitCode
