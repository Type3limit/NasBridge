param(
  [switch]$EnableTurn,
  [string]$ServerEnvPath = "server/.env",
  [string]$ClientEnvPath = "storage-client/.env",
  [string]$WebEnvPath = "web/.env"
)

$ErrorActionPreference = "Stop"

function Ensure-FileFromExample {
  param(
    [string]$Target,
    [string]$Example
  )

  if (-not (Test-Path $Target)) {
    Copy-Item -Path $Example -Destination $Target
    Write-Host "Created $Target from $Example" -ForegroundColor Yellow
  }
}

function Ensure-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $Name"
  }
}

function Get-EnvValue {
  param(
    [string]$Path,
    [string]$Name
  )
  if (-not (Test-Path $Path)) {
    return ""
  }
  $line = Get-Content $Path | Where-Object { $_ -match "^$Name=" } | Select-Object -First 1
  if (-not $line) {
    return ""
  }
  return ($line -replace "^$Name=", "").Trim()
}

function Set-EnvValue {
  param(
    [string]$Path,
    [string]$Name,
    [string]$Value
  )
  if (-not (Test-Path $Path)) {
    return
  }
  $content = Get-Content $Path
  $matched = $false
  $updated = foreach ($line in $content) {
    if ($line -match "^$Name=") {
      $matched = $true
      "$Name=$Value"
    } else {
      $line
    }
  }
  if (-not $matched) {
    $updated += "$Name=$Value"
  }
  Set-Content -Path $Path -Value $updated
}

Write-Host "[1/6] Checking prerequisites..." -ForegroundColor Cyan
Ensure-Command -Name "node"
Ensure-Command -Name "npm"

Write-Host "[2/6] Preparing env files..." -ForegroundColor Cyan
Ensure-FileFromExample -Target $ServerEnvPath -Example "server/.env.example"
Ensure-FileFromExample -Target $ClientEnvPath -Example "storage-client/.env.example"
Ensure-FileFromExample -Target $WebEnvPath -Example "web/.env.example"

$serverJwt = Get-EnvValue -Path $ServerEnvPath -Name "JWT_SECRET"
$clientJwt = Get-EnvValue -Path $ClientEnvPath -Name "JWT_SECRET"
if ($serverJwt -and (-not $clientJwt -or $clientJwt -eq "replace-this-with-the-same-secret-as-server")) {
  Set-EnvValue -Path $ClientEnvPath -Name "JWT_SECRET" -Value $serverJwt
  Write-Host "Synced JWT_SECRET from $ServerEnvPath to $ClientEnvPath for share-token validation." -ForegroundColor Yellow
}

if ($EnableTurn) {
  Write-Host "[3/6] Starting TURN (coturn) with Docker..." -ForegroundColor Cyan
  Ensure-Command -Name "docker"
  $turnEnv = "deploy/turn/.env"
  if (-not (Test-Path $turnEnv)) {
    Copy-Item -Path "deploy/turn/.env.example" -Destination $turnEnv
    Write-Host "Created $turnEnv from deploy/turn/.env.example" -ForegroundColor Yellow
    Write-Host "Please edit $turnEnv and set TURN_EXTERNAL_IP before production use." -ForegroundColor Yellow
  }
  docker compose --env-file deploy/turn/.env -f deploy/turn/docker-compose.yml up -d
} else {
  Write-Host "[3/6] Skipping TURN startup (use -EnableTurn to enable)." -ForegroundColor DarkYellow
}

Write-Host "[4/6] Installing dependencies..." -ForegroundColor Cyan
npm install

Write-Host "[5/6] Building web..." -ForegroundColor Cyan
npm run build -w web

Write-Host "[6/6] Starting server and storage client..." -ForegroundColor Cyan
$serverCmd = "Set-Location '$PWD'; npm run start -w server"
$clientCmd = "Set-Location '$PWD'; npm run start -w storage-client"

Start-Process powershell -ArgumentList "-NoExit", "-Command", $serverCmd | Out-Null
Start-Process powershell -ArgumentList "-NoExit", "-Command", $clientCmd | Out-Null

Write-Host "All services started." -ForegroundColor Green
Write-Host "- Server URL: http://localhost:8080" -ForegroundColor Green
Write-Host "- If web/.env uses localhost, open http://localhost:8080" -ForegroundColor Green
Write-Host "- For TURN, set TURN_URL/TURN_USERNAME/TURN_CREDENTIAL in web/.env and storage-client/.env" -ForegroundColor Green
