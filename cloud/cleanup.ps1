# Removes only the eval-9b resources: the job, the image repository, the results bucket (with all results) and the
# service account. Each is checked for the label purpose=eval-9b (or its description, for the service account) first.
# Never deletes the project and leaves the APIs enabled (the project is shared). Safe to run twice.
# -DryRun runs only the read-only checks and prints the exact delete arguments; it deletes nothing.
# How to run (PowerShell, from the project folder):  powershell -ExecutionPolicy Bypass -File cloud\cleanup.ps1 [-DryRun]
param([switch]$DryRun)
. "$PSScriptRoot\config.ps1"

Write-Host "Will delete, if they exist and carry ${Label}: job $Job, repository $Repo (all images), bucket gs://$Bucket (ALL results), service account $Sa"
if (-not $DryRun -and (Read-Host "Type 'delete eval-9b' to continue") -ne 'delete eval-9b') { exit 1 }

# A resource's label (or description) from a read-only describe; $null when it does not exist.
function Get-Field([string[]]$DescribeArgs, [string]$Format) {
  $value = Get-ToolOutput 'Describe' 'gcloud' ($DescribeArgs + @('--format', $Format)) -AllowFailure
  if ($null -eq $value) { return $null }
  return "$value"
}

# Deletes one resource when its label matches (prints the arguments instead with -DryRun).
function Remove-Labelled([string]$Name, $Found, [bool]$IsOurs, [string[]]$DeleteArgs) {
  if ($null -eq $Found) { Write-Host "${Name}: not found"; return }
  if (-not $IsOurs) { Write-Host "${Name}: label or description is '$Found', not deleted"; return }
  Invoke-Tool "Delete $Name" 'gcloud' $DeleteArgs -DryRun:$DryRun
}

# The job.
$found = Get-Field @('run', 'jobs', 'describe', $Job, '--region', $Region, '--project', $Project) "value(metadata.labels.$LabelKey)"
Remove-Labelled "job $Job" $found ($found -eq $LabelValue) @('run', 'jobs', 'delete', $Job, '--region', $Region, '--project', $Project, '--quiet')

# The image repository and every image in it.
$found = Get-Field @('artifacts', 'repositories', 'describe', $Repo, '--location', $Region, '--project', $Project) "value(labels.$LabelKey)"
Remove-Labelled "repository $Repo" $found ($found -eq $LabelValue) @('artifacts', 'repositories', 'delete', $Repo, '--location', $Region, '--project', $Project, '--quiet')

# The bucket with all results (download what you need first).
$found = Get-Field @('storage', 'buckets', 'describe', "gs://$Bucket", '--project', $Project) "value(labels.$LabelKey)"
Remove-Labelled "bucket gs://$Bucket" $found ($found -eq $LabelValue) @('storage', 'rm', '-r', "gs://$Bucket", '--project', $Project)

# The service account (service accounts have no labels; its description starts with the label).
$found = Get-Field @('iam', 'service-accounts', 'describe', $Sa, '--project', $Project) 'value(description)'
Remove-Labelled "service account $Sa" $found ($null -ne $found -and $found.StartsWith($Label)) @('iam', 'service-accounts', 'delete', $Sa, '--project', $Project, '--quiet')

if ($DryRun) { Write-Host 'Dry run: nothing was deleted.' } else { Write-Host 'Cleanup done. The project and its APIs are untouched.' }
