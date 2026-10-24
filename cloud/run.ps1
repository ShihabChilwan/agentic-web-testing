# Starts one job execution = one repeat. -Tasks 1 runs task 0 only (golden). Each run is a new execution and costs money,
# so it asks first; it creates nothing else.
# How to run (PowerShell, from the project folder):  powershell -ExecutionPolicy Bypass -File cloud\run.ps1 -Tasks 1
param([int]$Tasks = 1)
. "$PSScriptRoot\config.ps1"

Write-Host "Will start job $Job with $Tasks task(s) (task 0 = golden; ~`$0.16 per task-hour at $Cpu vCPU / $Memory)"
if ((Read-Host 'Continue? (y/n)') -ne 'y') { exit 1 }
# --async returns at once; the execution name is the repeat id (the results folder in the bucket).
$execution = & gcloud @('run', 'jobs', 'execute', $Job, '--region', $Region, '--project', $Project, '--tasks', "$Tasks", '--async', '--format', 'value(metadata.name)')
if ($LASTEXITCODE -ne 0) { throw 'Execute failed' }
Write-Host "Repeat id: $execution"
Write-Host "Status:    gcloud run jobs executions describe $execution --region $Region --project $Project"
Write-Host "Download:  powershell -ExecutionPolicy Bypass -File cloud\download.ps1 -Repeat $execution"
