# Scenario measurement (scoring/scenarios/PROTOCOL.md): one Cloud Run job per suite image.
# Reads build\scn-cloud\<suite>.build.json (a copy of build\cloud\image\build.json saved after each suite's build)
# for the image tag and the task count. Reuses cloud\config.ps1 for project, region, bucket, service account and size.
# Every gcloud call goes through Invoke-Tool with a splatted argument array; -DryRun prints the arguments only.
# How to run (PowerShell, from the project folder):
#   powershell -ExecutionPolicy Bypass -File build\scn-cloud\jobs.ps1 -Action <Create|Run|Status|Delete> -Suite <s1|s2|s3|kutt|all> [-DryRun]
param(
  [Parameter(Mandatory = $true)][ValidateSet('Create', 'Run', 'Status', 'Delete')][string]$Action,
  [Parameter(Mandatory = $true)][ValidateSet('s1', 's2', 's3', 'kutt', 'all')][string]$Suite,
  [switch]$DryRun
)
. "$PSScriptRoot\..\..\cloud\config.ps1"

# Parallel tasks per job: 3 x 24 + 16 = 88 tasks x 2 vCPU = 176 vCPU, under the region's 200 vCPU quota.
$MaxParallel = @{ s1 = 24; s2 = 24; s3 = 24; kutt = 16 }
$MeasureLabel = 'measurement=scenarios-v1'
$suites = if ($Suite -eq 'all') { @('s1', 's2', 's3', 'kutt') } else { @($Suite) }

function Get-SuiteBuild([string]$Name) {
  $file = Join-Path $PSScriptRoot "$Name.build.json"
  if (-not (Test-Path $file)) { throw "No ${file}: that suite's image is not built yet" }
  return (Get-Content $file -Raw | ConvertFrom-Json)
}

foreach ($s in $suites) {
  $build = Get-SuiteBuild $s
  $jobName = "eval-scn-$s"
  $image = "${ImageName}:$($build.imageTag)"
  $taskCount = @($build.versions).Count
  $parallel = [Math]::Min($taskCount, $MaxParallel[$s])
  Write-Host "== $jobName : image $image, $taskCount tasks (parallelism $parallel), run $($build.sourceRunId)"

  if ($Action -eq 'Create') {
    # Same settings as cloud\create-job.ps1 (gen2, results bucket mounted at /mnt/results, retries 0), one job per suite.
    $gcloudArgs = @('run', 'jobs', 'create', $jobName,
      '--region', $Region, '--project', $Project, '--image', $image,
      '--tasks', "$taskCount", '--parallelism', "$parallel", '--max-retries', '0', '--task-timeout', $TaskTimeout,
      '--cpu', $Cpu, '--memory', $Memory, '--service-account', $Sa,
      '--labels', "$Label,$MeasureLabel",
      '--execution-environment', 'gen2',
      '--add-volume', "name=results,type=cloud-storage,bucket=$Bucket,mount-options=uid=1000;gid=1000",
      '--add-volume-mount', 'volume=results,mount-path=/mnt/results')
    Invoke-Tool "Create $jobName" 'gcloud' $gcloudArgs -DryRun:$DryRun
  }
  elseif ($Action -eq 'Run') {
    # One execution = one repeat; its name is the results folder in the bucket.
    $gcloudArgs = @('run', 'jobs', 'execute', $jobName, '--region', $Region, '--project', $Project, '--tasks', "$taskCount", '--async', '--format', 'value(metadata.name)')
    if ($DryRun) { Show-ToolArgs "Execute $jobName" 'gcloud' $gcloudArgs; continue }
    $execution = Get-ToolOutput "Execute $jobName" 'gcloud' $gcloudArgs
    Write-Host "Repeat id ($s): $execution"
  }
  elseif ($Action -eq 'Status') {
    # Read-only: the job's executions with their task counts.
    $gcloudArgs = @('run', 'jobs', 'executions', 'list', '--job', $jobName, '--region', $Region, '--project', $Project,
      '--format', 'table(metadata.name,status.runningCount,status.succeededCount,status.failedCount,status.completionTime)')
    Invoke-Tool "Status $jobName" 'gcloud' $gcloudArgs -DryRun:$DryRun
  }
  elseif ($Action -eq 'Delete') {
    # Only this measurement's job and image tag; the repository, bucket and service account stay.
    $jobLabel = Get-ToolOutput 'Describe job' 'gcloud' @('run', 'jobs', 'describe', $jobName, '--region', $Region, '--project', $Project, '--format', 'value(metadata.labels.measurement)') -AllowFailure
    if ("$jobLabel" -eq 'scenarios-v1') {
      Invoke-Tool "Delete job $jobName" 'gcloud' @('run', 'jobs', 'delete', $jobName, '--region', $Region, '--project', $Project, '--quiet') -DryRun:$DryRun
      if (-not $DryRun) { Write-Host "Deleted job $jobName" }
    } else { Write-Host "job ${jobName}: not found or not labelled measurement=scenarios-v1, not deleted" }
    Invoke-Tool "Delete image $image" 'gcloud' @('artifacts', 'docker', 'images', 'delete', $image, '--delete-tags', '--project', $Project, '--quiet') -DryRun:$DryRun
    if (-not $DryRun) { Write-Host "Deleted image $image" }
  }
}
if ($DryRun) { Write-Host 'Dry run: nothing was created, started or deleted.' }
