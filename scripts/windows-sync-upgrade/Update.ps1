param([ValidateSet('check', 'apply', 'rollback')][string]$Mode = 'apply')
$ErrorActionPreference = 'Stop'
try {
    $nodePath = (Get-Command node -ErrorAction Stop).Source
    Write-Host 'NasBridge web sync groups: multi-node bidirectional P2P + mirrored deletion'
    if ($Mode -ne 'check') { Write-Host 'Stop this storage client before continuing. Other applications can stay running.' }
    $projectPath = (Read-Host 'Enter the existing NasBridge folder (or storage-client folder)').Trim().Trim('"')
    if (-not $projectPath) { throw 'A project path is required.' }
    if ($Mode -eq 'rollback') {
        $backupId = Read-Host 'Enter the backup ID printed by the update'
        & $nodePath (Join-Path $PSScriptRoot 'update.cjs') $projectPath '--rollback' $backupId
    } else {
        & $nodePath (Join-Path $PSScriptRoot 'update.cjs') $projectPath "--$Mode"
    }
    if ($LASTEXITCODE -ne 0) { throw 'Update/check failed. Read the message above.' }
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
