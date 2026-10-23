# Runs one task of the image locally, like Cloud Run: 2 CPUs, 4 GB, no swap, and /tmp, the run folder and HOME
# in RAM (tmpfs), so disk writes count against the memory limit as they do in Cloud Run. Results go to runs\cloud\<repeat>\<version>\.
# Safe to run twice for a new -Repeat; the same repeat and index refuses to overwrite its results.
# How to run (PowerShell, from the project folder):  powershell -ExecutionPolicy Bypass -File cloud\local-run.ps1 -Index 0 -Repeat local-1
param([int]$Index = 0, [string]$Repeat = 'local-1', [string]$Cpus = '2', [string]$MemoryLimit = '4g', [string]$ShmSize = '1g')
. "$PSScriptRoot\config.ps1"

$image = "${ImageName}:$(Get-ImageTag)"
$name = "eval-9b-local-$Index"
New-Item -ItemType Directory -Force $ResultsDir | Out-Null
Write-Host "Will run task $Index of $image as container $name (cpus $Cpus, memory $MemoryLimit, shm $ShmSize), results in `"$ResultsDir\$Repeat`""

# Remove a container left over from an earlier attempt (no error when there is none).
docker rm -f $name *> $null
# --memory-swap equal to --memory: no swap, as in Cloud Run. tmpfs pages are charged to the container's memory.
docker run --name $name --platform linux/amd64 --cpus $Cpus --memory $MemoryLimit --memory-swap $MemoryLimit --shm-size $ShmSize `
  --tmpfs /tmp:rw,exec,mode=1777 --tmpfs /app/runs:rw,exec,mode=1777 --tmpfs /home/node:rw,mode=1777 `
  -e CLOUD_RUN_TASK_INDEX=$Index -e CLOUD_RUN_EXECUTION=$Repeat `
  --mount "type=bind,source=$ResultsDir,target=/mnt/results" $image
$code = $LASTEXITCODE

# Exit code and whether the kernel killed the container for memory.
docker inspect $name --format 'exit code {{.State.ExitCode}}, OOMKilled {{.State.OOMKilled}}'
# Files written outside the RAM folders: not counted locally, but counted in Cloud Run (whose whole disk is RAM).
$changed = docker diff $name
Write-Host "Writes outside tmpfs: $(@($changed).Count) paths (first 20 below)"
$changed | Select-Object -First 20
docker rm $name | Out-Null
Write-Host "Peak memory and timings: $ResultsDir\$Repeat\<version>\status.json"
exit $code
