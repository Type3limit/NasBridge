$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$StorageRoot = Join-Path $RepoRoot "storage-client"
$NodeBin = Join-Path $RepoRoot ".local\tools\node-v22.23.1-win-x64"
$NpmExe = Join-Path $NodeBin "npm.cmd"
$FfmpegBin = Join-Path $RepoRoot ".local\tools\ffmpeg\ffmpeg-master-latest-win64-gpl-shared\bin"
$YtDlpDir = Join-Path $RepoRoot ".local\tools\yt-dlp"
$PlaywrightBrowsers = Join-Path $RepoRoot ".local\ms-playwright"

if (-not (Test-Path -LiteralPath $StorageRoot)) {
  throw "storage-client directory not found: $StorageRoot"
}
if (-not (Test-Path -LiteralPath (Join-Path $StorageRoot ".env"))) {
  throw "storage-client .env not found: $(Join-Path $StorageRoot ".env")"
}
if (-not (Test-Path -LiteralPath $NpmExe)) {
  $foundNpm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $foundNpm) {
    throw "npm.cmd not found. Expected portable Node at $NodeBin"
  }
  $NpmExe = $foundNpm.Source
} else {
  $env:PATH = "$NodeBin;$env:PATH"
}

$env:PATH = "$FfmpegBin;$YtDlpDir;$env:PATH"
$env:npm_config_cache = Join-Path $RepoRoot ".local\npm-cache"
$env:PLAYWRIGHT_BROWSERS_PATH = $PlaywrightBrowsers
$env:MUSIC_LIB_BRIDGE_URL = "http://127.0.0.1:46231"
$env:MUSIC_LIB_BRIDGE_WORKDIR = Join-Path $RepoRoot "music-lib-bridge"
$env:MUSIC_LIB_BRIDGE_AUTO_START = "0"
$env:MUSIC_PLAYER_DEFAULT_SOURCE = "qq"
$env:MUSIC_PLAYER_FORCE_DEFAULT_SOURCE = "1"

New-Item -ItemType Directory -Force -Path $env:npm_config_cache | Out-Null
Set-Location -LiteralPath $RepoRoot

Write-Host "[storage-client] cwd: $RepoRoot"
Write-Host "[storage-client] .env: $StorageRoot\.env"
Write-Host "[storage-client] music bridge: $env:MUSIC_LIB_BRIDGE_URL"
Write-Host "[storage-client] music default source: $env:MUSIC_PLAYER_DEFAULT_SOURCE"
Write-Host ""

& $NpmExe run start -w storage-client
exit $LASTEXITCODE
