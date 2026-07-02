param(
  [string]$EnvFile = "D:\Code\Nas\music-lib-bridge\.env",
  [int]$Port = 9222,
  [switch]$Quiet,
  [switch]$AllowPartial,
  [switch]$BestEffort
)

$ErrorActionPreference = "Stop"

try {
  $Utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [Console]::InputEncoding = $Utf8NoBom
  [Console]::OutputEncoding = $Utf8NoBom
  $OutputEncoding = $Utf8NoBom
} catch {
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$NodeExe = Join-Path $RepoRoot ".local\tools\node-v22.23.1-win-x64\node.exe"
$RefreshScript = Join-Path $RepoRoot "music-lib-bridge\scripts\refresh-qq-cookie.mjs"
$SkillCheck = Join-Path $HOME ".codex\skills\web-access\scripts\check-deps.mjs"

function Write-RefreshMessage {
  param([string]$Message)

  if (-not $Quiet) {
    Write-Host "[qq-cookie-refresh] $Message"
  }
}

function Exit-RefreshFailure {
  param(
    [string]$Message,
    [int]$ExitCode = 1
  )

  if ($BestEffort) {
    Write-RefreshMessage "skipped: $Message"
    exit 0
  }
  Write-Host "[qq-cookie-refresh] failed: $Message" -ForegroundColor Red
  exit $ExitCode
}

if (-not (Test-Path -LiteralPath $NodeExe)) {
  $foundNode = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $foundNode) {
    Exit-RefreshFailure "node.exe not found. Expected portable Node at $NodeExe"
  }
  $NodeExe = $foundNode.Source
}

if (-not (Test-Path -LiteralPath $RefreshScript)) {
  Exit-RefreshFailure "refresh script not found: $RefreshScript"
}

if (Test-Path -LiteralPath $SkillCheck) {
  Write-RefreshMessage "checking web-access Edge CDP..."
  $checkOutput = & $NodeExe $SkillCheck 2>&1
  $checkExitCode = $LASTEXITCODE
  if ($checkExitCode -eq 0) {
    foreach ($line in $checkOutput) {
      if (-not $Quiet -and -not $BestEffort) {
        Write-Host "[web-access] $line"
      }
    }
  } elseif ($BestEffort) {
    Write-RefreshMessage "skipped: Edge CDP is not ready; keep current QQ_COOKIE. Open Edge and enable edge://inspect/#remote-debugging -> Allow remote debugging for this browser instance."
    exit 0
  } else {
    foreach ($line in $checkOutput) {
      if (-not $Quiet) {
        Write-Host "[web-access] $line"
      }
    }
    Exit-RefreshFailure "web-access CDP preflight failed. Open Edge and enable edge://inspect/#remote-debugging -> Allow remote debugging for this browser instance." $checkExitCode
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
$refreshExitCode = $LASTEXITCODE
if ($refreshExitCode -ne 0 -and $BestEffort) {
  Write-RefreshMessage "skipped: QQ_COOKIE refresh failed with exit code $refreshExitCode; keep current QQ_COOKIE."
  exit 0
}
exit $refreshExitCode
