# Agentic Web Testing

An agentic framework in which LLM agents read the source code of Node.js web applications, generate API and end-to-end (browser) tests for them, run them, and diagnose every failure as an application defect, an environment issue or a faulty test. The repository also contains an empirical study of how well this works: planted bugs with known answers, three independent test suites, a pre-registered scoring protocol and held-out applications.

Given the source of an app, the framework:

1. writes a requirements document (PRD) from the code,
2. derives test cases from the requirements,
3. writes Playwright scripts and repairs them against the correct version of the app,
4. executes them against a running version (browser UI and REST API),
5. diagnoses each failure with a root cause, a code location and a suggested fix,
6. shows everything on a dashboard and in a static HTML report.

Out of scope: performance and load testing, security testing, direct database testing, live third-party integrations, visual regression, accessibility and mobile.

## Key results

All results use one model (`z-ai/glm-5.3-flash` through OpenRouter) and the framework frozen at the git tag `freeze-v1`. Exact figures come from `scoring/out/`; definitions are in the notes below the tables.

### Test generation

Three independent suites generated for mern-ecommerce after the freeze (S1, S2, S3):

| Measure | S1 | S2 | S3 |
|---|---|---|---|
| Test cases | 156 | 160 | 139 |
| Valid scripts¹ | 138 (88.5%) | 146 (91.3%) | 120 (86.3%) |
| Endpoints reached² | 66 / 67 | 66 / 73 | 69 / 69 |
| Golden execution (cloud) | 137 / 138 | 146 / 146 | 120 / 120 |

Generation cost per suite³: $0.37–0.44. Endpoint coverage on the final development measurement (before the freeze): 65 / 69 (94%).

### Fault detection (3 suites; 12 planted code bugs and 5 environment faults each)

| Measure | Per suite | Mean | Range |
|---|---|---|---|
| Mutation score (code bugs caught) | 16.7% / 33.3% / 33.3% | 27.8% | 16.7–33.3% |
| Mutation score, genuine catches only⁴ | 8.3% / 25.0% / 33.3% | 22.2% | 8.3–33.3% |
| Environment faults detected | 100% / 100% / 100% | 100% | – |

**Reached but not checked.** Of the 28 bug-suite combinations without a genuine catch, 20 were reached but not checked: a test ran the mutated code and no assertion looked at the changed behaviour (orderings, a `success` flag, an empty state, a duplicate name, the admin view). 5 were never reached and 3 were equivalent mutants. None was masked. The weakness is in what the generated tests assert, not in whether the failure can be diagnosed.

### Diagnosis (mean over 3 suites)

| Measure | With tools | Without tools |
|---|---|---|
| Classification correct (caught code bugs) | 91.7% | 0.0% |
| File correct | 75.0% | 0.0% |
| Line within ±5 | 75.0% | 0.0% |
| Environment faults classified correctly | 100% (15 / 15) | 93.3% (14 / 15) |
| Analysis cost per suite | $0.287 | $0.017 |

On genuine catches only (8 catches), classification, file and line were each 100%. Golden false-alarm rate: 0.0% (measured on the one suite where golden had a failure). "Without tools" gives the analyzer only the failing tests' titles and errors. The 0% classification without tools follows from a submit rule, not from weaker reasoning alone: an `app_defect` must name a file and line range that exist in the executed source, and without tools the analyzer sees no file names, so it cannot get an `app_defect` accepted and falls back to the other classes.

### Transfer to other applications

| App | Role | Golden all-pass | Valid scripts¹ | Endpoints reached² | Suspected defects |
|---|---|---|---|---|---|
| Kutt (SQLite), run 1 | development | 119 / 119 | 119 / 131 (90.8%) | 24 / 31 | 2 |
| Kutt (SQLite), run 2 | development | 123 / 123 | 123 / 141 (87.2%) | 25 / 31 | 6 |
| Kutt (PostgreSQL) | development | 117 / 117 | 117 / 136 (86.0%) | 24 / 31 | 3 |
| Planka, run 1 (configuration only) | **held out** | 69 / 69 | 69 / 139 (49.6%) | 43 / 102 | 6 |

Planka was not opened until the freeze. With a configuration file only, 64 of 139 scripts were invalid (12 of them from a missing browser login) and 13 of 27 browser cases were kept; none of its 6 suspected defects is an application defect. These figures are reported as measured.

<sub>¹ Valid scripts = scripts that passed their dry run against the correct version, divided by all test cases generated, including the coverage-round cases. Cases whose script was reviewed and kept as a suspected defect, and cases with no valid script, are not counted as valid.<br>
² Endpoints reached = PRD API endpoints that a passing script reached, measured by V8 coverage of the backend on the correct version, divided by the endpoints of the PRD; Planka also counts 27 endpoints by request.<br>
³ Cost = model calls for the PRD, test cases, scripts and the coverage round, as reported by the provider. The review of failed scripts adds $0.008–0.026 per suite (total $0.40–0.45).<br>
⁴ Two of the ten catches were accidental (the failing test did not run the mutated line) and are removed.</sub>

### Response comparator and scenario generator (after the freeze)

Two later additions, measured under their own pre-registered protocols:

- **Response comparator** (`comparator-v1`): records every response and page snapshot of an execution and compares a version with the correct one, after removing the fields that differ between three correct runs (noise). On the 12 code bugs × 3 suites it caught 20 bug-suite pairs against 10 for failing tests alone (22 by either). The analyzer, given the comparator's differences, classified 90.0% of the 20 cases correctly and named the right file and lines in 91.7% (3 repeats). Details: [`scoring/differential/`](scoring/differential/) (protocol, `out/scores.md`); a check on Kutt in [`scoring/differential-kutt/RESULTS.md`](scoring/differential-kutt/RESULTS.md).
- **Scenario generator** (`scenarios-v1`): adds up to 40 multi-step scenario tests to a generated suite. On a fresh set of 87 bugs (25 per mern-ecommerce suite, 12 for Kutt), the suites with the comparator caught 53, with scenarios 56 (3 added, all in one suite); 31 were caught by nothing. Details, false alarms and deviations: [`scoring/scenarios/RESULTS.md`](scoring/scenarios/RESULTS.md).

## How it works

```
source code ─▶ requirements ─▶ test cases ─▶ scripts ─▶ coverage round ─▶ execution ─▶ failure analyzer ─▶ dashboard
                 (PRD)                      (+ review)                    (per version)
```

| Stage | What happens |
|---|---|
| Requirements | An agent explores the source with read-only tools and submits a validated PRD: features, requirements with acceptance criteria and code citations, API endpoints, UI routes. |
| Test cases | Cases are derived from requirements, with expected values taken from cited code. The agent sees accessibility snapshots of the pages the requirements name. A case that cannot be justified is declined with a reason. |
| Scripts | One Playwright script per case, type-checked and dry-run against the correct version. A repair loop fixes broken scripts but may never change **locked expected values**. A script that reaches an assertion and fails is a result, not a script error; each such script is reviewed once with the cited code, and every removed expectation is listed for a person to check. |
| Coverage round | The passing scripts run once with backend V8 coverage. PRD endpoints that no script reached get an extra round of cases, except endpoints gated by a disabled setting. |
| Execution | The scripts run against one version of the app from a temporary source tree (a commit plus an optional patch; the target repository is never modified). The database is restored from a snapshot before every test. Environment incidents such as a crashed backend are recorded. |
| Failure analyzer | Failures are grouped; one agent session per group reads the failure artifacts and the source of the executed version through read-only tools. Output: category (`app_defect`, `environment_issue`, `test_defect`), root cause, file and line, suggested fix, confidence. It never sees version history, diffs, variant names or other executions. |

All model output is untrusted: structured results come through a submit tool, are validated against zod schemas and retried with the validation error. All model calls go through one client layer and are logged to the run folder.

### Target-neutral adapter layer

The pipeline in `src/` contains nothing specific to one app. A target is a folder `targets/<name>/` with a `target.config.json` (processes, ports, install and start commands, health check, environment, users, login method, database lifecycle, coverage kind) and optional helper scripts (seed, snapshot). The adapter layer supports kinds of technology through configuration: a separate or built-in frontend, token, header or cookie login, a login command, form-encoded requests, MongoDB, SQLite and PostgreSQL snapshots. A test (`tests/shared/target-neutral.test.ts`) fails if source, prompts or examples in `src/` mention anything of a target.

## Getting started

Everything runs inside the VS Code dev container (user `node`, TypeScript, ESM). There is no Docker inside the container: target apps run as child processes.

You need:

- **Node.js 22.12 or later.**
- **MongoDB** reachable at host `mongo`, port 27017 (mern-ecommerce) and **PostgreSQL** at host `db`, port 5432 (Planka and the Kutt PostgreSQL target). In the dev container these are compose services; elsewhere, run them yourself and change the host names in `targets/<name>/target.config.json`. Kutt on SQLite needs no database service.
- **A target repository you do not edit by hand.** `agent prd`, `cases`, `scripts` and `scenarios`, and `target:up` and `target:facts`, run `git checkout --force <ref>` in `targets/<name>/repo/`, which discards uncommitted changes there. Executions and analyses use temporary source trees and never touch it.
- Install: `npm ci`, then `sudo npx playwright install-deps chromium && npx playwright install chromium` (Playwright is pinned to 1.64.0). Re-run the Playwright step after a container rebuild.
- Clone a target at its pinned version (see [Target applications](#target-applications)) into `targets/<name>/repo/` and create a `golden` branch at that commit. Target repositories are git-ignored.
- Copy `.env.example` to `.env` (git-ignored; never commit it). Variables:
  - Endpoint: `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_EXTRA_HEADERS`, `LLM_EXTRA_BODY`, `LLM_REASONING_PARAM`, `LLM_TIMEOUT_MS`
  - Provider routing (OpenRouter): `LLM_PROVIDER_ORDER`, comma-separated provider or endpoint slugs tried in that order, no other provider (e.g. `wafer/us,wafer`). Do not also set `provider` in `LLM_EXTRA_BODY`; `npm run llm:ping` prints the routing in use.
  - Sampling and reasoning: `LLM_TEMPERATURE`, `LLM_TOP_P`, `LLM_REASONING_EFFORT`, `LLM_REASONING_EFFORT_PRD`, `_CASES`, `_SCRIPTS`, `_ANALYZER`
  - Limits: `LLM_CONCURRENCY`, `LLM_CONTEXT_TOKENS`, `LLM_MAX_TOKENS_PER_RUN`, `LLM_MAX_COST_USD_PER_RUN`
  - Per-module models: `LLM_MODEL_PRD`, `LLM_MODEL_CASES`, `LLM_MODEL_SCRIPTS`, `LLM_MODEL_ANALYZER`
- Check: `npm run typecheck`, `npm run lint`, `npm test`, and `npm run llm:ping` for one real model request.

## Usage

Run outputs go to `runs/<runId>/` (git-ignored). Commands that take `--run` default to the newest suitable run.

### Pipeline (`npm run agent -- <command>`)

| Command | Purpose | Example |
|---|---|---|
| `prd` | New run; generate `prd.json` from the target source | `npm run agent -- prd --target mern-ecommerce` |
| `cases` | Generate `testcases.json` from the PRD | `npm run agent -- cases --run <runId>` |
| `inspect` | List a stage's sessions and rejected submits (read-only) | `npm run agent -- inspect --stage cases` |
| `scripts` | Generate and dry-run a script per case; reviews failed scripts; resumes an unfinished run | `npm run agent -- scripts --redo invalid` |
| `gaps` | Measure endpoint coverage, add cases for unreached endpoints | `npm run agent -- gaps --measure-only` |
| `execute` | Run the passing scripts against one version | `npm run agent -- execute --patch path/to/change.patch` |
| `analyze` | Diagnose the failures of one execution | `npm run agent -- analyze --exec x-01` |
| `all` | prd → cases → scripts → gaps → execute → analyze, reusing valid stages | `npm run agent -- all --target kutt` |
| `report` | Write `runs/<runId>/report.html`, one self-contained page | `npm run agent -- report` |

Useful options: `scripts --fresh` regenerates every script; `scripts --redo passed,assertion_failed,invalid|none` regenerates only those outcomes; `execute --ref <ref>`, `--skip-seed` and `--exec-id <id>`; `analyze --no-tools` runs the ablation without tools; `all --fresh` starts a new run. Ctrl+C saves progress and stops the app.

### Response comparator and scenarios (`npm run agent -- <command>`, no model except `scenarios` and `analyze`)

| Command | Purpose | Writes |
|---|---|---|
| `execute ... --record-responses --record-pages` | Record every response (secrets redacted) and the page snapshots of an execution | `executions/<x>/responses.jsonl`, `pages.jsonl` |
| `noise --run <runId> [--runs 3 \| --execs a,b,c] [--page-execs a,b,c]` | Run the correct version several times and learn which fields differ between correct runs | `noise-fields.json` and `.md` |
| `compare --run <runId> --base <x> --other <y> [--noise <file> \| --no-noise]` | Compare two executions, leaving out the noise fields; differences are strong or weak | `differential/compare-<x>-<y>.json` and `.md` |
| `analyze --exec <y> --differences <compare file>` | Diagnose with the strong differences as evidence; passing tests that differ get sessions too | `diagnoses.differential.json` |
| `scenarios --from <runId> [--max 40] [--cost-cap 1]` | Copy a done suite to `<runId>-scn` and add scenario tests (SC ids) | `scenarios/`, `scripts-with-scenarios/` |
| `execute --scripts-dir scripts-with-scenarios` | Run the suite with its scenario tests | as `execute` |

The suite itself (`testcases.json`, `scripts/`) is never changed by `scenarios`.

### Helpers

| Command | Purpose |
|---|---|
| `npm run target:up -- <target> [--ref <ref>] [--hold]` | Start a target by hand through the same lifecycle the engine uses; `--hold` keeps it up |
| `npm run target:facts -- <target>` | Start the app clean and record verified facts (`facts.json`) |
| `npm run llm:ping` | One real model request: model, provider, latency, tokens, cost |

### Evaluation (`npm run eval -- <command>`)

| Command | Purpose |
|---|---|
| `variants --target <name> [--seed <n>] [--list-only] [--env-only] [--force]` | Draw Stryker mutants and check environment faults; writes `variants.json` and patches |
| `cloud-context --target <name> --run <runId> [--variants <file>]` | Build folder for the executor image (framework, target, suite, versions) |
| `cloud-task` | Inside the executor image: run the version of `CLOUD_RUN_TASK_INDEX` |
| `import --from runs/cloud/<repeat>` | Turn one repeat's results into a run with opaque execution ids |

Analysis of the imported executions is then `npm run agent -- analyze --run <runId> --exec <id>`.

### Cloud scripts

Executions run on Cloud Run Jobs, one task per version. The PowerShell scripts in `cloud/` are run from Windows in this order, each as `powershell -ExecutionPolicy Bypass -File cloud\<script>.ps1`: `setup` (once), `build [-Push]`, `local-run -Index <n> -Repeat <id>` (check one task locally), `create-job`, `run -Tasks <n>`, `download -Repeat <id>`, `cleanup`. `cleanup`, `create-job`, `download` and `run` accept `-DryRun`.

### Scoring

Scoring is code, run outside the frozen product paths (`scoring/` has its own tsconfig and vitest config):

```
npx tsx scoring/cli.ts --suite <imported run> [--suite ...] \
  --variants targets/mern-ecommerce/variants.json \
  [--equivalents scoring/equivalents.json] [--out scoring/out]
npx tsx scoring/cli.ts hash                      # protocol and code hashes of every .ts file under scoring/
node scoring/hash-check.mjs                      # the same, without the later measurement folders: checks the pre-registered hashes
npx vitest run --config scoring/vitest.config.ts # scoring tests
npx tsx scoring/differential/score.ts [hash]     # comparator diagnosis scoring (scoring/differential/PROTOCOL.md)
npx tsx scoring/scenarios/score.ts detect --suite <label>=<run dir> ...   # scenario measurement (scoring/scenarios/PROTOCOL.md)
```

### Freeze

```
npm run freeze:record -- --tag freeze-v1      # write freeze/freeze.json (clean tree required)
npx tsx src/cli.ts freeze check [--target <name>]   # is HEAD the frozen framework?
```

Once a freeze is recorded, `eval variants`, `cloud-context` and `import` refuse anything else unless `--allow-unfrozen` is passed (development only).

## Dashboard

```
npx tsx dashboard/server.ts      # http://localhost:4000  (DASHBOARD_PORT or PORT to change)
```

A small server that reads `runs/<id>/` and starts the same CLI commands as child processes; it contains no pipeline logic. One job runs at a time because the target app uses fixed ports. Live output is streamed to the page, with secrets redacted.

- **Run tab:** run summary, stages with status, time and cost, tiles, requirements and coverage per feature, test cases, scripts (status and tries), execution results, diagnoses, and the live log.
- **Results tab:** the fixed evaluation results read from `scoring/out/scores.json`: bug detection, why bugs were missed, diagnosis accuracy, cost and time, and a per-version table. It does not depend on the selected run.
- **New run:** pick a target and start the whole pipeline.
- **Demo mode:** choose features from a checklist and a case cap (default 20). Golden is executed by default; optionally a buggy version from a variant list is executed too, followed by analysis. Demo runs limit the PRD and the test case list by editing the run's own files between stages (full copies are kept as `prd.full.json` and `testcases.full.json`), are marked `DEMO-ONLY.txt` and `demo.json`, and are never scored.

Screenshots: see `docs/screenshots/`.

## Evaluation method

- **Freeze.** The framework, prompts, model settings and limits are fixed at the tag `freeze-v1` (`freeze/freeze.json` records the model `z-ai/glm-5.3-flash` pinned to one provider, temperature 1, top-p 1, reasoning effort per module, context 131072 tokens, at most 250 cases per run and the hashes of the lock file and project documents).
- **Held-out bugs.** After the freeze, 12 code mutants (StrykerJS, fixed seed) and 5 environment faults (for example an unreachable database) were drawn for mern-ecommerce. Every bug used during development was excluded by a ±5-line rule. Mutants and faults are patch or configuration versions of the correct app; no analysis prompt was tuned against them.
- **Three independent suites.** Three complete generations (S1, S2, S3) with the same frozen settings, each executed against golden, the 12 code variants and the 5 environment faults on Cloud Run Jobs, then analyzed in one local batch. Runs differ by design (no seed is sent to the model).
- **Pre-registered scoring.** `scoring/PROTOCOL.md` defines the rules before any diagnosis of a drawn bug existed: a version is caught when at least one test that passed on golden fails or errors on it; the primary diagnosis is the highest-confidence group; classification, file and line (±5) are scored on caught bugs; environment faults are scored by category. Protocol SHA-256 `554b1969f726ea6617786a7bf9de360862413cacb3612814cd86a040de504142`; a different hash at scoring time means the protocol changed afterwards.
- **Held-out application.** Planka was not opened until the freeze and was given only a target configuration; whatever it needed beyond that is reported as adaptation cost.
- **Ablation.** The same executions analysed without the analyzer's tools.

## Repository structure

| Path | Contents |
|---|---|
| `src/cli.ts` | Thin command-line entry point |
| `src/shared/` | Schemas (zod), paths, config, freeze logic, logger |
| `src/llm/` | Model client layer, limiter, fake client for tests |
| `src/agent/` | Agent runtime: loop, submit validation, context guard, read-only tools |
| `src/modules/prd-generator/` | Requirements stage |
| `src/modules/test-case-generator/` | Test cases and the coverage-guided gap round |
| `src/modules/script-generator/` | Scripts, repair loop, lock check, review, helper template |
| `src/modules/execution-engine/` | App lifecycle, source trees, snapshot restore, isolation, execution |
| `src/modules/failure-analyzer/` | Failure grouping, tools, checks, analysis |
| `src/modules/report/` | Run view model and the static HTML report |
| `src/modules/differential/` | Response comparator: recorded responses and pages, noise, comparison |
| `src/modules/scenario-generator/` | Scenario tests added to a generated suite |
| `src/eval/` | Variants, environment faults, cloud executor, import |
| `scoring/` | Scoring code, protocol, and result tables (`scoring/out/`); comparator scoring in `scoring/differential/` and `scoring/differential-kutt/`, scenario measurement in `scoring/scenarios/` |
| `dashboard/` | Live dashboard server and page |
| `cloud/` | PowerShell scripts for the Cloud Run Jobs executor |
| `freeze/` | Recorded freeze (settings and hashes) |
| `targets/<name>/` | Target configuration, seed and snapshot scripts, facts, variants |
| `tools/postgres/` | Generic PostgreSQL reset and snapshot scripts |
| `tests/` | Unit and integration tests |
| `runs/` | Generated output (git-ignored) |

## Target applications

| Target | Role | Stack | Pinned version | Licence |
|---|---|---|---|---|
| [mern-ecommerce](https://github.com/mohamedsamara/mern-ecommerce) | development and evaluation | React 16, Node/Express, MongoDB | commit `7f73dfb` (branch `golden`) | MIT |
| [Kutt](https://github.com/thedevs-network/kutt) | development (SQLite and PostgreSQL targets) | Express, server-rendered Handlebars with htmx | tag `v3.2.6` (`6ca8033`) | MIT |
| [Planka](https://github.com/plankanban/planka) | held out | React, Sails.js, PostgreSQL | tag `v2.1.0` (`91eb43f4`) | PLANKA Community License v1.1 (its "Fair Use License": personal, educational and research use) |

The framework never modifies target source. Live third-party services (email, payments, OAuth, cloud storage) are disabled in every target configuration. For Planka, files for its Pro and Enterprise editions (`*.pe.*`) are never read or used.

## Known limitations

- A model-provider reply without `choices` crashes the current stage.
- `agent all` does not exit after a key-limit error from the provider.
- `main` is not frozen: it contains a later generic adapter patch made for Planka (extra browser-storage values and a CSS locator). Evaluation runs use the `freeze-v1` tag; check it out to reproduce the results.
- Generated tests are weak at checking behaviour they reach: 7 of the 12 planted code bugs were never caught in any of the three suites.
- Grounding proves that an expected value exists in the code, not that it applies to the tested path.
- The comparator matches records across runs by normalising ids by where they appear: an id seen in two or more tests is a shared (seeded) record, an id seen in one test is that test's own. A seeded record that a version shows in only one test is therefore treated as test-local, and the aliases of the shared ids after it shift, which can report differences that are not behaviour changes. Generated values are only recognised in the forms the scripts' helpers produce; other run-to-run values must be learned as noise (Kutt's clock time on the stats page was not, see `scoring/scenarios/RESULTS.md`).
- Results are from one model and one provider; the evaluation has no human baseline.

## Licence

MIT, see [LICENSE](LICENSE). Target applications keep their own licences (see above).
