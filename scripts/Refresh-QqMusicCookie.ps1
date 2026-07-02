param(
  [string]$EnvFile = "D:\Code\Nas\music-lib-bridge\.env",
  [int]$Port = 9222,
  [switch]$Quiet,
  [switch]$AllowPartial
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$NodeExe = Join-Path $RepoRoot ".local\tools\node-v22.23.1-win-x64\node.exe"
$RefreshScript = Join-Path $RepoRoot "music-lib-bridge\scripts\refresh-qq-cookie.mjs"
$SkillCheck = Join-Path $HOME ".codex\skills\web-access\scripts\check-deps.mjs"

if (-not (Test-Path -LiteralPath $NodeExe)) {
  $foundNode = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $foundNode) {
    throw "node.exe not found. Expected portable Node at $NodeExe"
  }
  $NodeExe = $foundNode.Source
}

if (-not (Test-Path -LiteralPath $RefreshScript)) {
  throw "refresh script not found: $RefreshScript"
}

if (Test-Path -LiteralPath $SkillCheck) {
  if (-not $Quiet) {
    Write-Host "[qq-cookie-refresh] checking web-access Edge CDP..."
  }
  & $NodeExe $SkillCheck | ForEach-Object {
    if (-not $Quiet) {
      Write-Host "[web-access] $_"
    }
  }
  if ($LASTEXITCODE -ne 0) {
    throw "web-access CDP preflight failed. Open edge://inspect/#remote-debugging and enable Allow remote debugging for this browser instance."
  }
}

$argsList = @(
  $RefreshScript,
  "--env", $EnvFile,
  "--port", [string]$Port
)
if ($Quiet) {
  $argsList += "--quiet"
}
if ($AllowPartial) {
  $argsList += "--allow-partial"
}

& $NodeExe @argsList
exit $LASTEXITCODE
