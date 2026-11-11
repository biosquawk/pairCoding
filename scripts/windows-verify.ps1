# Run by ROOT/operator on Windows, NEVER via an agent escaping its sandbox.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{40}$')][string]$Revision,
  [string]$Node = 'C:\Program Files\nodejs\node.exe',
  [string]$EvidenceParent = $env:TEMP,
  [string]$TrustedManifest,
  [ValidatePattern('^[a-f0-9]{64}$')][string]$ManifestSha256
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'This is a Windows validation, WSL is not Windows evidence.' }
if (-not (Test-Path -LiteralPath $Node -PathType Leaf)) { throw 'Missing Windows node.exe' }
$Source = (Resolve-Path -LiteralPath $Source).Path
if (-not (Test-Path -LiteralPath (Join-Path $Source 'package-lock.json') -PathType Leaf)) { throw 'Source needs the integrated lockfile.' }
# A unique disposable copy: no changes to source, user workspace, platform services or unrelated processes.
$Work = Join-Path $EvidenceParent ('paircoach-verify-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Work | Out-Null
$Repo = Join-Path $Work 'repo'
$Logs = Join-Path $Work 'evidence'
$Temp = Join-Path $Work 'temp'
New-Item -ItemType Directory -Path $Logs, $Temp | Out-Null
# The operator-side helper is trusted code; do not run a helper taken from an untrusted ZIP.
# It compares actual HEAD (exact intended root) or an externally trusted manifest digest,
# validates all source bytes, copies only the finite package closure, then rechecks the copy.
$Helper = Join-Path $PSScriptRoot 'verify-source-revision.mjs'
if (-not (Test-Path -LiteralPath $Helper -PathType Leaf)) { throw 'Missing trusted revision helper' }
$Preflight = @($Helper, '--source', $Source, '--revision', $Revision, '--destination', $Repo,
  '--evidence', (Join-Path $Logs 'source-verification.json'))
if ($TrustedManifest -or $ManifestSha256) {
  if (-not $TrustedManifest -or -not $ManifestSha256) { throw 'Supply both TrustedManifest and ManifestSha256 from K/operator trusted channel' }
  $Preflight += @('--trusted-manifest', $TrustedManifest, '--manifest-sha256', $ManifestSha256)
}
& $Node @Preflight 2>&1 | Out-File -LiteralPath (Join-Path $Logs 'source-verification.log') -Encoding utf8
if ($LASTEXITCODE -ne 0) { throw "Source revision/byte verification FAIL; npm NOT_RUN; evidence: $Logs" }
$Identity = Get-Content -LiteralPath (Join-Path $Logs 'source-verification.json') -Raw | ConvertFrom-Json
if ($Identity.byteVerification -ne 'PASS' -or $Identity.actualRevision -ne $Revision) { throw 'Missing verified source identity; npm NOT_RUN' }
$OldEnvironment = @{}
foreach ($Key in @('TEMP','TMP','TMPDIR','npm_config_cache','PATH')) { $OldEnvironment[$Key] = [Environment]::GetEnvironmentVariable($Key, 'Process') }
Get-ChildItem -LiteralPath $Repo -File -Recurse | Sort-Object FullName | Get-FileHash -Algorithm SHA256 |
  Select-Object Path, Hash | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Logs 'input-sha256.json') -Encoding utf8
[pscustomobject]@{ requestedRevision = $Revision; actualRevision = $Identity.actualRevision; trustMode = $Identity.trustMode; manifestDigest = $Identity.manifestDigest; byteVerification = $Identity.byteVerification; source = $Source; copiedCandidate = $Repo; windowsVersion = [Environment]::OSVersion.VersionString; powershell = $PSVersionTable.PSVersion.ToString() } |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Logs 'environment.json') -Encoding utf8
$Results = New-Object System.Collections.Generic.List[object]
function Invoke-NodeCheck([string]$Name, [string[]]$Arguments) {
  $Previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Node @Arguments 2>&1 | Out-File -LiteralPath (Join-Path $Logs ($Name + '.log')) -Encoding utf8
    $Code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $Previous }
  $Results.Add([pscustomobject]@{ check = $Name; exitCode = $Code; result = $(if ($Code -eq 0) {'PASS'} else {'FAIL'}) })
  if ($Code -ne 0) { Write-Warning "$Name failed ($Code); retained $Logs" }
}
$PreviousCwd = Get-Location
try {
  $env:TEMP = $Temp; $env:TMP = $Temp; $env:TMPDIR = $Temp
  $env:npm_config_cache = Join-Path $Work 'npm-cache'
  $env:PATH = (Split-Path -Parent $Node) + ';' + $env:PATH
  Set-Location -LiteralPath $Repo
  Invoke-NodeCheck 'node-version' @('--version')
  $Npm = Join-Path (Split-Path -Parent $Node) 'node_modules\npm\bin\npm-cli.js'
  if (-not (Test-Path -LiteralPath $Npm -PathType Leaf)) { throw 'Missing npm CLI next to node.exe' }
  Invoke-NodeCheck 'npm-ci' @($Npm, 'ci', '--no-audit', '--no-fund')
  if (($Results | Where-Object { $_.check -eq 'npm-ci' }).exitCode -ne 0) { throw 'npm ci failed; do not run partial dependencies.' }
  Invoke-NodeCheck 'tsc' @('node_modules/typescript/bin/tsc','--noEmit')
  Invoke-NodeCheck 'build' @('node_modules/vite/bin/vite.js','build')
  $Tests = @(Get-ChildItem -LiteralPath 'tests/execution' -Filter '*.test.ts' -File | Sort-Object Name | ForEach-Object { $_.FullName })
  if ($Tests.Count -eq 0) { throw 'No execution tests; cannot claim Windows run/stop evidence.' }
  Invoke-NodeCheck 'execution' (@('--import','tsx','--test') + $Tests)
  # Mandatory existing crash/restart suite; its child/helpers are required preflight inputs.
  $RecoveryTests = @('tests/snapshots/snapshot-crash.test.ts')
  $Recovery = @($RecoveryTests | ForEach-Object {
    $File = Join-Path $Repo $_
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { throw 'Missing required snapshot-recovery test; cannot claim Windows PASS.' }
    $File
  })
  Invoke-NodeCheck 'snapshot-recovery' (@('--import','tsx','--test') + $Recovery)
} finally {
  Set-Location $PreviousCwd
  foreach ($Key in $OldEnvironment.Keys) { [Environment]::SetEnvironmentVariable($Key, $OldEnvironment[$Key], 'Process') }
  # No process-name kill. Tests own their process trees and retain unrelated sentinel proof.
  $Results | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Logs 'results.json') -Encoding utf8
  Get-ChildItem -LiteralPath $Repo -File -Recurse | Where-Object { $_.FullName -notmatch '[\\/]node_modules[\\/]' } |
    Get-FileHash -Algorithm SHA256 | Select-Object Path, Hash | ConvertTo-Json -Depth 4 |
    Set-Content -LiteralPath (Join-Path $Logs 'candidate-sha256.json') -Encoding utf8
  Write-Host "Evidence retained: $Logs"
}
if (@($Results | Where-Object { $_.result -eq 'FAIL' }).Count -gt 0) { exit 1 }
if (@($Results | Where-Object { $_.result -eq 'NOT_RUN' }).Count -gt 0) { exit 2 }
Write-Host 'PASS Windows execution/recovery candidate tests. Browser E2E, real AI (Codex/Gemini) and full campaign acceptance are separate evidence.'
exit 0
