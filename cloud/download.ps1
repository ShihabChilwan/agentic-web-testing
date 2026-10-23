# Downloads one repeat's results from the bucket to runs\cloud\<repeat>\ (then run `npm run eval -- import` in the dev container).
# Safe to run twice: files are overwritten with the same content.
# How to run (PowerShell, from the project folder):  powershell -ExecutionPolicy Bypass -File cloud\download.ps1 -Repeat <execution name>
param([Parameter(Mandatory = $true)][string]$Repeat)
. "$PSScriptRoot\config.ps1"

New-Item -ItemType Directory -Force $ResultsDir | Out-Null
Write-Host "Will copy gs://$Bucket/$Repeat to `"$ResultsDir\$Repeat`""
# Recursive copy of the repeat's folder.
Invoke-Native 'Download' { gcloud storage cp -r "gs://$Bucket/$Repeat" "$ResultsDir" --project $Project }
Write-Host "Next, in the dev container: npm run eval -- import --from runs/cloud/$Repeat"
