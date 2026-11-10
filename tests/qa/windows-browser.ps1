param(
  [Parameter(Mandatory=$true)][string]$RepoPath,
  [string]$BrowserExecutable = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
  [switch]$ReferenceMetrics
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $RepoPath
if (-not (Test-Path -LiteralPath $BrowserExecutable)) { throw "Browser absent: $BrowserExecutable" }
$runtime = Join-Path (Get-Location) 'tests\qa\.runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$env:PAIRCOACH_QA_BROWSER = $BrowserExecutable
$env:PAIRCOACH_QA_REVISION = (& git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot determine exact revision' }
$env:npm_config_cache = Join-Path $runtime 'npm-cache'
$env:TEMP = Join-Path $runtime 'tmp'; $env:TMP = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
Write-Host "Revision $env:PAIRCOACH_QA_REVISION; Node: $(& node --version); browser=$BrowserExecutable"
# No install or downloads. K/ROOT supplies the integrated candidate with npm ci already completed.
# Do not reuse an unrelated listener on8080: Playwright reuseExistingServer=false fails safely.
& node node_modules\playwright\cli.js test --config playwright.config.ts
$smoke = $LASTEXITCODE
if ($smoke -ne 0) { throw "Real browser GATE001 failed exit=$smoke; retain .runtime traces/reports" }
if ($ReferenceMetrics) {
  & node node_modules\playwright\cli.js test --config tests\qa\metrics.config.ts
  $metrics = $LASTEXITCODE
  if ($metrics -ne 0) { throw "Windows reference metrics failed exit=$metrics; retain raw evidence" }
}
Write-Host 'PASS only for the commands executed above. Gemini, process-tree and recovery need separate evidence.'
