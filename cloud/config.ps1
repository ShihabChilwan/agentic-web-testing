# Shared settings for the eval-9b scripts (step 9b executor). Edit values here, not in the scripts.
# Not run on its own: every script loads it with `. "$PSScriptRoot\config.ps1"` AFTER its param() block, so a name
# defined here overwrites a script parameter of the same name: never reuse a parameter name (Tasks, Repeat, Index, DryRun...).

$Project     = 'extension-project-489222'
$Region      = 'us-central1'
$LabelKey    = 'purpose'
$LabelValue  = 'eval-9b'
$Label       = "$LabelKey=$LabelValue"
$Repo        = 'eval-9b'                                   # Artifact Registry repository
$Bucket      = "$Project-eval-9b"                          # results bucket (mounted at /mnt/results)
$SaName      = 'eval-9b-runner'
$Sa          = "$SaName@$Project.iam.gserviceaccount.com"  # the job's identity: object read/write on $Bucket only
$Job         = 'eval-9b'
$Cpu         = '2'
$Memory      = '4Gi'
$JobTasks    = 18                                          # the job's task count: golden + 12 code + 5 environment versions
$Parallelism = 6                                           # 6 x 2 vCPU = 12 vCPU, under the regional Cloud Run CPU quota of a shared project; raise after checking the quota page
$TaskTimeout = '90m'                                       # env-01 is estimated at 60-65 min (SPEC 0.2)

$Root        = Split-Path -Parent $PSScriptRoot           # the project folder (may contain spaces)
$BuildDir    = Join-Path $Root 'build\cloud'
$ResultsDir  = Join-Path $Root 'runs\cloud'
$ImageName   = "$Region-docker.pkg.dev/$Project/$Repo/runner"

function Get-ImageTag {
  $file = Join-Path $BuildDir 'image\build.json'
  if (-not (Test-Path $file)) { throw "No ${file}: run 'npm run eval -- cloud-context ...' in the dev container first" }
  (Get-Content $file -Raw | ConvertFrom-Json).imageTag
}

# Every gcloud and docker call passes its arguments as an array of strings held in a VARIABLE and splatted (@name).
# Two PowerShell traps: `a,b` unquoted on a command line is an array, and an inline array such as
# `& gcloud @('run', 'jobs')` reaches the tool as ONE argument "run jobs". Only `& $tool @variable` spreads the elements.

# Prints the arguments a tool would receive, one per line in brackets, so each argument's boundaries are visible.
function Show-ToolArgs([string]$What, [string]$Tool, [string[]]$ToolArgs) {
  Write-Host "$What - $Tool would receive $($ToolArgs.Count) arguments:"
  foreach ($a in $ToolArgs) { Write-Host "  [$a]" }
}

# Runs `$Tool` with exactly these arguments and stops the script when it fails (-DryRun: only prints them).
function Invoke-Tool([string]$What, [string]$Tool, [string[]]$ToolArgs, [switch]$DryRun) {
  if ($DryRun) { Show-ToolArgs $What $Tool $ToolArgs; return }
  & $Tool @ToolArgs
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit $LASTEXITCODE)" }
}

# Like Invoke-Tool, but returns the tool's output (stdout) for the caller to use. -AllowFailure returns $null instead
# of stopping when the tool fails (e.g. "describe" of something that does not exist); its error output is hidden then.
function Get-ToolOutput([string]$What, [string]$Tool, [string[]]$ToolArgs, [switch]$AllowFailure) {
  if ($AllowFailure) { $out = & $Tool @ToolArgs 2> $null } else { $out = & $Tool @ToolArgs }
  if ($LASTEXITCODE -ne 0) {
    if ($AllowFailure) { return $null }
    throw "$What failed (exit $LASTEXITCODE)"
  }
  return $out
}

# True when a gcloud describe-style command succeeds (the resource exists). Output is discarded.
function Test-Gcloud([string[]]$GcloudArgs) {
  & gcloud @GcloudArgs *> $null
  return ($LASTEXITCODE -eq 0)
}
