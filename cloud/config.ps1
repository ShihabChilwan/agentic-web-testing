# Shared settings for the eval-9b scripts (step 9b executor). Edit values here, not in the scripts.
# Not run on its own: every script loads it with `. "$PSScriptRoot\config.ps1"`.

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
$Tasks       = 18                                          # golden + 12 code + 5 environment versions
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

# Runs a native command and stops the script when it fails.
function Invoke-Native([string]$What, [scriptblock]$Command) {
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit $LASTEXITCODE)" }
}

# True when a gcloud describe-style command succeeds (the resource exists). Output is discarded.
function Test-Gcloud([string[]]$GcloudArgs) {
  & gcloud @GcloudArgs *> $null
  return ($LASTEXITCODE -eq 0)
}
