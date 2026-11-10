# Run by ROOT/operator on Windows, NEVER via an agent escaping its sandbox.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{40}$')][string]$Revision,
  [string]$Node = 'C:\Program Files\nodejs\node.exe',
  [string]$EvidenceParent = $env:TEMP
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
New-Item -ItemType Directory -Path $Repo, $Logs, $Temp | Out-Null
function Copy-SafeTree([string]$From, [string]$To) {
  if ((Get-Item -LiteralPath $From).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse source refused: $From" }
  New-Item -ItemType Directory -Path $To -Force | Out-Null
  foreach ($Item in Get-ChildItem -LiteralPath $From -Force) {
    if ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse source refused: $($Item.Name)" }
    if ($Item.Name -match '^\.env' -or $Item.Name -match '\.(pem|key|pfx)$' -or $Item.Name -in @('.git','node_modules','.paircoach','artifacts','test-results')) { continue }
    $Target = Join-Path $To $Item.Name
    if ($Item.PSIsContainer) { Copy-SafeTree $Item.FullName $Target }
    else { Copy-Item -LiteralPath $Item.FullName -Destination $Target }
  }
}
foreach ($Dir in @('src','tests','scripts','docs')) {
  $Path = Join-Path $Source $Dir
  if (Test-Path -LiteralPath $Path -PathType Container) { Copy-SafeTree $Path (Join-Path $Repo $Dir) }
}
foreach ($Name in @('package.json','package-lock.json','tsconfig.json','vite.config.ts','index.html','metadata.json','playwright.config.ts')) {
  $Path = Join-Path $Source $Name
  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    if ((Get-Item -LiteralPath $Path).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse file refused' }
    Copy-Item -LiteralPath $Path -Destination (Join-Path $Repo $Name)
  }
}
$OldEnvironment = @{}
foreach ($Key in @('TEMP','TMP','TMPDIR','npm_config_cache','PATH')) { $OldEnvironment[$Key] = [Environment]::GetEnvironmentVariable($Key, 'Process') }
Get-ChildItem -LiteralPath $Repo -File -Recurse | Sort-Object FullName | Get-FileHash -Algorithm SHA256 |
  Select-Object Path, Hash | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Logs 'input-sha256.json') -Encoding utf8
[pscustomobject]@{ expectedRevision = $Revision; source = $Source; copiedCandidate = $Repo; windowsVersion = [Environment]::OSVersion.VersionString; powershell = $PSVersionTable.PSVersion.ToString() } |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Logs 'environment.json') -Encoding utf8
$env:TEMP = $Temp; $env:TMP = $Temp; $env:TMPDIR = $Temp
$env:npm_config_cache = Join-Path $Work 'npm-cache'
$env:PATH = (Split-Path -Parent $Node) + ';' + $env:PATH
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
  $Recovery = Join-Path $Repo 'tests/core/recovery.test.ts'
  if (Test-Path -LiteralPath $Recovery -PathType Leaf) {
    Invoke-NodeCheck 'snapshot-recovery' @('--import','tsx','--test',$Recovery)
  } else {
    $Results.Add([pscustomobject]@{ check = 'snapshot-recovery'; exitCode = $null; result = 'NOT_RUN'; reason = 'GATE003 recovery implementation/test not present in candidate' })
  }
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
Write-Host 'PASS Windows execution/recovery candidate tests. Browser E2E and real Gemini are separate evidence.'
exit 0
