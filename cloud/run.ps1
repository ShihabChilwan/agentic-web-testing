# Starts one job execution = one repeat. -Tasks 1 runs task 0 only (golden). Each run is a new execution and costs money,
# so it asks first; it creates nothing else. -DryRun prints the exact gcloud arguments and starts nothing.
# How to run (PowerShell, from the project folder):  powershell -ExecutionPolicy Bypass -File cloud\run.ps1 -Tasks 1 [-DryRun]
param([int]$Tasks = 1, [switch]$DryRun)
. "$PSScriptRoot\config.ps1"

if ($Tasks -lt 1 -or $Tasks -gt $JobTasks) { throw "-Tasks must be between 1 and $JobTasks, got $Tasks" }
# --async returns at once; the execution name it prints is the repeat id (the results folder in the bucket).
$gcloudArgs = @('run', 'jobs', 'execute', $Job, '--region', $Region, '--project', $Project, '--tasks', "$Tasks", '--async', '--format', 'value(metadata.name)')
$last = $Tasks - 1
Write-Host "Will start job $Job with --tasks $Tasks (task indexes 0..$last; 0 = golden), ~`$0.16 per task-hour at $Cpu vCPU / $Memory"
if ($DryRun) {
  Show-ToolArgs 'Execute job' 'gcloud' $gcloudArgs
  Write-Host 'Dry run: nothing was started.'
  exit 0
}
if ((Read-Host "Start $Tasks task(s) now? (y/n)") -ne 'y') { exit 1 }
$execution = Get-ToolOutput 'Execute job' 'gcloud' $gcloudArgs
Write-Host "Repeat id: $execution"
Write-Host "Status:    gcloud run jobs executions describe $execution --region $Region --project $Project"
Write-Host "Download:  powershell -ExecutionPolicy Bypass -File cloud\download.ps1 -Repeat $execution"
