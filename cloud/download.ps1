# Downloads one repeat's results from the bucket to runs\cloud\<repeat>\ (then run `npm run eval -- import` in the dev container).
# Safe to run twice: files are overwritten with the same content. -DryRun prints the exact gcloud arguments and copies nothing.
# How to run (PowerShell, from the project folder):  powershell -ExecutionPolicy Bypass -File cloud\download.ps1 -Repeat <execution name> [-DryRun]
param([Parameter(Mandatory = $true)][string]$Repeat, [switch]$DryRun)
. "$PSScriptRoot\config.ps1"

Write-Host "Will copy gs://$Bucket/$Repeat to `"$ResultsDir\$Repeat`""
# Recursive copy of the repeat's folder; the local path (with spaces) is one argument.
$gcloudArgs = @('storage', 'cp', '-r', "gs://$Bucket/$Repeat", $ResultsDir, '--project', $Project)
if ($DryRun) {
  Show-ToolArgs 'Download' 'gcloud' $gcloudArgs
  Write-Host 'Dry run: nothing was copied.'
  exit 0
}
New-Item -ItemType Directory -Force $ResultsDir | Out-Null
Invoke-Tool 'Download' 'gcloud' $gcloudArgs
Write-Host "Next, in the dev container: npm run eval -- import --from runs/cloud/$Repeat"
