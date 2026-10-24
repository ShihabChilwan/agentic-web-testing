# Creates the Cloud Run job (or updates its image and size when it exists). Safe to run twice.
# Needs setup.ps1 and `build.ps1 -Push` first. -DryRun prints the exact gcloud arguments and creates nothing.
# How to run (PowerShell, from the project folder):  powershell -ExecutionPolicy Bypass -File cloud\create-job.ps1 [-DryRun]
param([switch]$DryRun)
. "$PSScriptRoot\config.ps1"

$image = "${ImageName}:$(Get-ImageTag)"
Write-Host "Job $Job ($Region): image $image, $Tasks tasks, parallelism $Parallelism, retries 0, task timeout $TaskTimeout,"
Write-Host "  $Cpu vCPU / $Memory per task, service account $Sa, gs://$Bucket mounted at /mnt/results, label $Label"

# Settings shared by create and update; each element is exactly one argument for gcloud.
$common = @(
  '--region', $Region,
  '--project', $Project,
  '--image', $image,
  '--tasks', "$Tasks",
  '--parallelism', "$Parallelism",
  '--max-retries', '0',
  '--task-timeout', $TaskTimeout,
  '--cpu', $Cpu,
  '--memory', $Memory,
  '--service-account', $Sa
)
$exists = Test-Gcloud @('run', 'jobs', 'describe', $Job, '--region', $Region, '--project', $Project)
if ($exists) {
  # Existing job: new image and size; the volume mount stays as created.
  $what = 'Update job'
  $gcloudArgs = @('run', 'jobs', 'update', $Job) + $common + @('--update-labels', $Label)
} else {
  # Second-generation environment (needed for the bucket mount); uid/gid 1000 = the image's "node" user, which writes the results.
  $what = 'Create job'
  $gcloudArgs = @('run', 'jobs', 'create', $Job) + $common + @(
    '--labels', $Label,
    '--execution-environment', 'gen2',
    '--add-volume', "name=results,type=cloud-storage,bucket=$Bucket,mount-options=uid=1000;gid=1000",
    '--add-volume-mount', 'volume=results,mount-path=/mnt/results'
  )
}
if ($DryRun) {
  Invoke-Tool $what 'gcloud' $gcloudArgs -DryRun
  Write-Host 'Dry run: nothing was created or changed.'
  exit 0
}
if ((Read-Host "$what now? (y/n)") -ne 'y') { exit 1 }
Invoke-Tool $what 'gcloud' $gcloudArgs
Write-Host 'Job ready.'
