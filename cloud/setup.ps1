# One-time cloud setup for step 9b. Safe to run twice: existing resources are kept.
# How to run (PowerShell, from the project folder):  powershell -ExecutionPolicy Bypass -File cloud\setup.ps1
. "$PSScriptRoot\config.ps1"

Write-Host "Project $Project, region $Region. This script will create (or keep, if they exist):"
Write-Host "  - APIs: run, artifactregistry, storage, iam (enabled; never disabled by cleanup, the project is shared)"
Write-Host "  - Artifact Registry repository '$Repo' (docker, $Region, label $Label)"
Write-Host "  - Bucket gs://$Bucket ($Region, uniform access, public access prevented, label $Label)"
Write-Host "  - Service account $Sa, with roles/storage.objectUser on gs://$Bucket only"
Write-Host "  - Docker login for $Region-docker.pkg.dev"
if ((Read-Host 'Continue? (y/n)') -ne 'y') { exit 1 }

# Enable the APIs the job, the image registry and the bucket need (no-op when already enabled).
Invoke-Tool 'Enable APIs' 'gcloud' @('services', 'enable', 'run.googleapis.com', 'artifactregistry.googleapis.com', 'storage.googleapis.com', 'iam.googleapis.com', '--project', $Project)

# Image repository for the executor image.
if (Test-Gcloud @('artifacts', 'repositories', 'describe', $Repo, '--location', $Region, '--project', $Project)) { Write-Host "Repository $Repo exists" }
else { Invoke-Tool 'Create repository' 'gcloud' @('artifacts', 'repositories', 'create', $Repo, '--repository-format', 'docker', '--location', $Region, '--labels', $Label, '--description', 'eval-9b executor images', '--project', $Project) }

# Results bucket; each task writes <repeat>/<version>/ into it through the mount.
if (Test-Gcloud @('storage', 'buckets', 'describe', "gs://$Bucket", '--project', $Project)) { Write-Host "Bucket gs://$Bucket exists" }
else { Invoke-Tool 'Create bucket' 'gcloud' @('storage', 'buckets', 'create', "gs://$Bucket", '--project', $Project, '--location', $Region, '--uniform-bucket-level-access', '--public-access-prevention') }
# Label the bucket (repeating it changes nothing).
Invoke-Tool 'Label bucket' 'gcloud' @('storage', 'buckets', 'update', "gs://$Bucket", '--update-labels', $Label, '--project', $Project)

# The job's own identity (no keys are ever created for it).
if (Test-Gcloud @('iam', 'service-accounts', 'describe', $Sa, '--project', $Project)) { Write-Host "Service account $Sa exists" }
else { Invoke-Tool 'Create service account' 'gcloud' @('iam', 'service-accounts', 'create', $SaName, '--display-name', 'eval-9b runner', '--description', "${Label}: Cloud Run job $Job writes results to gs://$Bucket", '--project', $Project) }

# Read/write objects in this one bucket (the mount needs read too); nothing else in the project. Adding it twice is harmless.
# A "does not exist" error right after creating the account is propagation delay: wait a minute and run the script again.
Invoke-Tool 'Grant bucket access' 'gcloud' @('storage', 'buckets', 'add-iam-policy-binding', "gs://$Bucket", '--member', "serviceAccount:$Sa", '--role', 'roles/storage.objectUser', '--project', $Project)

# Let docker push to the repository with your gcloud login.
Invoke-Tool 'Docker login' 'gcloud' @('auth', 'configure-docker', "$Region-docker.pkg.dev", '--quiet')
Write-Host 'Setup done.'
