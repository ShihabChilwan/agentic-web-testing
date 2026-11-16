# Scenario measurement: tooling used for the runs of 16 Nov 2026

Files used to run the measurement described in `../PROTOCOL.md`, kept so each step can be repeated. Nothing here is part of the framework under `src/`.

| File | What it is |
|---|---|
| `mern-ecommerce-sealed-2.json`, `kutt-sealed-2.json` | Copies of `targets/<app>/sealed-2/variants.json` with `sealed-2/` put in front of every `patch` path; all other fields identical. `eval cloud-context --variants` resolves patch paths from `targets/<app>/`, so the original lists point at the earlier draw in `targets/<app>/variants/`. |
| `s1.build.json`, `s2.build.json`, `s3.build.json`, `kutt.build.json` | The `build/cloud/image/build.json` of each suite's image (image tag, source run, versions). |
| `jobs.ps1` | Host script: one Cloud Run job per suite image (`-Action Create|Run|Status|Delete`, `-DryRun`), reusing `cloud/config.ps1`. Copied from `build/scn-cloud/`, where it ran. |
| `kutt-import/` | One-off import of the Kutt repeat: `import.mts` is `src/eval/cloud/import.ts` with only its import lines changed; `leaks-every-line.mts` applies the same leak pattern to every line of every file and skips HTTP PATCH calls (`api.patch(`), which the original check reads as the leak word `.patch`. |
| `detect.sh` | Noise from the three noise runs (responses and pages) and a comparison of every other execution with the base run. |
| `crash.cjs` | Backend crash check over the four correct-version runs of one suite. |
