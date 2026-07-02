param(
  [int]$StorageDelaySeconds = 3
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$MusicScript = Join-Path $PSScriptRoot "Run-MusicLibBridge.ps1"
$StorageScript = Join-Path $PSScriptRoot "Run-StorageClient.ps1"

foreach ($script in @($MusicScript, $StorageScript)) {
  if (-not (Test-Path -LiteralPath $script)) {
    throw "Missing startup script: $script"
  }
}

function Start-ServiceTerminal {
  param(
    [string]$Title,
    [string]$ScriptPath
  )

  $wt = Get-Command wt.exe -ErrorAction SilentlyContinue
  if ($wt) {
    Start-Process -FilePath $wt.Source -ArgumentList @(
      "-w", "new",
      "--title", $Title,
      "powershell.exe",
      "-NoExit",
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", $ScriptPath
    )
    return
  }

  Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoExit",
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $ScriptPath
  )
}

Write-Host "[nas-local] repo: $RepoRoot"
Write-Host "[nas-local] opening visible terminals..."
Start-ServiceTerminal -Title "NasBridge-music-lib" -ScriptPath $MusicScript
Start-Sleep -Seconds ([Math]::Max(0, $StorageDelaySeconds))
Start-ServiceTerminal -Title "NasBridge-storage-client" -ScriptPath $StorageScript
Write-Host "[nas-local] started. Keep the opened terminals visible for logs."
