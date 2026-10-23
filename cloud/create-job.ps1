# Creates the Cloud Run job (or updates its image and size when it exists). Safe to run twice.
# Needs setup.ps1 and `build.ps1 -Push` first.
# How to run (PowerShell, from the project folder):  powershell -ExecutionPolicy Bypass -File cloud\create-job.ps1
. "$PSScriptRoot\config.ps1"

$image = "${ImageName}:$(Get-ImageTag)"
Write-Host "Job $Job ($Region): image $image, $Tasks tasks, parallelism $Parallelism, retries 0, task timeout $TaskTimeout,"
Write-Host "  $Cpu vCPU / $Memory per task, service account $Sa, gs://$Bucket mounted at /mnt/results, label $Label"
if ((Read-Host 'Continue? (y/n)') -ne 'y') { exit 1 }

if (Test-Gcloud @('run', 'jobs', 'describe', $Job, '--region', $Region, '--project', $Project)) {
  # Existing job: new image and size; the volume mount stays as created.
  Invoke-Native 'Update job' { gcloud run jobs update $Job --region $Region --project $Project --image $image --tasks $Tasks --parallelism $Parallelism --max-retries 0 --task-timeout $TaskTimeout --cpu $Cpu --memory $Memory --service-account $Sa --update-labels $Label }
} else {
  # Second-generation environment (needed for the bucket mount); uid/gid 1000 = the image's "node" user, which writes the results.
  Invoke-Native 'Create job' { gcloud run jobs create $Job --region $Region --project $Project --image $image --tasks $Tasks --parallelism $Parallelism --max-retries 0 --task-timeout $TaskTimeout --cpu $Cpu --memory $Memory --service-account $Sa --labels $Label --execution-environment gen2 "--add-volume=name=results,type=cloud-storage,bucket=$Bucket,mount-options=uid=1000;gid=1000" --add-volume-mount volume=results,mount-path=/mnt/results }
}
Write-Host 'Job ready.'
