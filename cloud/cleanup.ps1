# Removes only the eval-9b resources: the job, the image repository, the results bucket (with all results) and the
# service account. Each is checked for the label $Label (or its description, for the service account) first.
# Never deletes the project and leaves the APIs enabled (the project is shared). Safe to run twice.
# How to run (PowerShell, from the project folder):  powershell -ExecutionPolicy Bypass -File cloud\cleanup.ps1
. "$PSScriptRoot\config.ps1"

Write-Host "Will delete, if they exist and carry $Label`: job $Job, repository $Repo (all images), bucket gs://$Bucket (ALL results), service account $Sa"
if ((Read-Host "Type 'delete eval-9b' to continue") -ne 'delete eval-9b') { exit 1 }

function Get-Label([string[]]$DescribeArgs, [string]$Format) {
  $value = & gcloud @($DescribeArgs + @('--format', $Format)) 2> $null
  if ($LASTEXITCODE -ne 0) { return $null }
  return "$value"
}

# The job.
$label = Get-Label @('run', 'jobs', 'describe', $Job, '--region', $Region, '--project', $Project) "value(metadata.labels.$LabelKey)"
if ($label -eq $LabelValue) { Invoke-Tool 'Delete job' 'gcloud' @('run', 'jobs', 'delete', $Job, '--region', $Region, '--project', $Project, '--quiet') }
elseif ($null -eq $label) { Write-Host "Job ${Job}: not found" } else { Write-Host "Job ${Job}: label is '$label', not deleted" }

# The image repository and every image in it.
$label = Get-Label @('artifacts', 'repositories', 'describe', $Repo, '--location', $Region, '--project', $Project) "value(labels.$LabelKey)"
if ($label -eq $LabelValue) { Invoke-Tool 'Delete repository' 'gcloud' @('artifacts', 'repositories', 'delete', $Repo, '--location', $Region, '--project', $Project, '--quiet') }
elseif ($null -eq $label) { Write-Host "Repository ${Repo}: not found" } else { Write-Host "Repository ${Repo}: label is '$label', not deleted" }

# The bucket with all results (download what you need first).
$label = Get-Label @('storage', 'buckets', 'describe', "gs://$Bucket", '--project', $Project) "value(labels.$LabelKey)"
if ($label -eq $LabelValue) { Invoke-Tool 'Delete bucket' 'gcloud' @('storage', 'rm', '-r', "gs://$Bucket", '--project', $Project) }
elseif ($null -eq $label) { Write-Host "Bucket gs://${Bucket}: not found" } else { Write-Host "Bucket gs://${Bucket}: label is '$label', not deleted" }

# The service account (service accounts have no labels; its description names the label).
$description = Get-Label @('iam', 'service-accounts', 'describe', $Sa, '--project', $Project) 'value(description)'
if ($description -and $description.StartsWith($Label)) { Invoke-Tool 'Delete service account' 'gcloud' @('iam', 'service-accounts', 'delete', $Sa, '--project', $Project, '--quiet') }
elseif ($null -eq $description) { Write-Host "Service account ${Sa}: not found" } else { Write-Host "Service account ${Sa}: description does not start with $Label, not deleted" }
Write-Host 'Cleanup done. The project and its APIs are untouched.'
