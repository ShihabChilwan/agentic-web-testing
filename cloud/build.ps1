# Builds the executor image from build\cloud (written by `npm run eval -- cloud-context` in the dev container);
# with -Push also pushes it. Safe to run twice: docker reuses its cache and a pushed tag is overwritten with the same image.
# How to run (PowerShell, from the project folder):  powershell -ExecutionPolicy Bypass -File cloud\build.ps1 [-Push]
param([switch]$Push)
. "$PSScriptRoot\config.ps1"

$image = "${ImageName}:$(Get-ImageTag)"
Write-Host "Will build $image (linux/amd64) from `"$BuildDir`"$(if ($Push) { ' and push it to Artifact Registry' } else { ' (local only)' })"

# Build for Cloud Run's platform; the build folder path (with spaces) is one argument.
Invoke-Tool 'docker build' 'docker' @('build', '--platform', 'linux/amd64', '-t', $image, $BuildDir)
# Image size as docker reports it (unpacked).
Get-ToolOutput 'docker image ls' 'docker' @('image', 'ls', $image, '--format', 'size: {{.Size}}')
if ($Push) {
  # Upload to the repository created by setup.ps1.
  Invoke-Tool 'docker push' 'docker' @('push', $image)
}
