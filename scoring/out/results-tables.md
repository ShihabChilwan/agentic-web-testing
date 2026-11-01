# Results tables (one place for the report, paper and slides)

Every number below comes from a run file, a score file or a SPEC/CLAUDE record, as named in each section. Nothing was run with a model. Two measurements were refreshed earlier in this session (no model, `agent gaps --measure-only`): backend coverage of S1, S2, S3 and Planka run 1. **Marks:** *(est.)* = estimated or derived by this report from run files with a definition that differs from the earlier measurement; *(not found)* = no file holds it.

Run ids: M = mern-ecommerce; final suites S1 `M-20261030-125711` (cloud `M-20261030-175229`), S2 `M-20261030-211147` (cloud `M-20261031-193116`), S3 `M-20261031-201456` (cloud `M-20261031-222406`); final measurement `M-20261029-202744` (cloud `M-20261030-093705`).

## 1. Generation results per run

Passed = scripts that passed their dry run; suspected = `assertion_failed` after review; invalid = no valid script. "Valid %" = (passed + suspected) ÷ cases; "Passed %" = passed ÷ cases.

| Run | Requirements | Cases (api / ui) | Passed | Suspected | Invalid | Passed % | Valid % | Golden all-pass | Endpoints reached | Pages opened | Wall time | Cost (generation) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| mern final measurement `M-20261029-202744` | 86 | 150 (90 / 60) | 136 | 3 | 11 | 90.7% | 92.7% | cloud golden **136/136** (the local x-01, 126/126, ran before the last scripts were added) | 65 / 69 | 39 / 39 | 126 min (includes a pause) | $0.391 |
| mern S1 `M-20261030-125711` | 84 | 156 (94 / 62) | 138 | 1 | 17 | 88.5% | 89.1% | local 138/138; cloud 137/138 (TC-033 fails on golden only, a flaky pagination test) | 66 / 67 | 39 / 39 | 51 min | $0.453 |
| mern S2 `M-20261030-211147` | 73 | 160 (99 / 61) | 146 | 2 | 12 | 91.3% | 92.5% | local 145/146 (TC-099); cloud **146/146** | 66 / 73 | 30 / 31 | 70 min (provider fault, resumed) | $0.416 |
| mern S3 `M-20261031-201456` | 76 | 139 (98 / 41) | 120 | 7 | 12 | 86.3% | 91.4% | local **120/120**; cloud **120/120** | 69 / 69 | 39 / 39 | 36 min | $0.398 |
| Kutt SQLite, first `kutt-20261029-145043` | 64 | 131 (78 / 53) | 119 | 2 | 10 | 90.8% | 92.4% | **119/119** | 24 / 31 | 28 / 31 | 31 min | $0.373 |
| Kutt SQLite, second `kutt-20261029-175214` | 89 | 141 (83 / 58) | 123 | 6 | 12 | 87.2% | 91.5% | **123/123** | 25 / 31 | 16 / 17 (+ 14 / 14 fragments) | 50 min | $0.472 |
| Kutt PostgreSQL `kutt-pg-20261029-160623` | 76 | 136 (91 / 45) | 117 | 3 | 16 | 86.0% | 88.2% | **117/117** | 24 / 31 *(coverage.json holds 106 scripts of the 117; stale)* | 29 / 30 | 53 min | $0.468 |
| **Planka run 1** `planka-20261101-121912` (held out, config only) | 39 | 139 (112 / 27) | 69 | 6 | 64 | 49.6% | 54.0% | **69/69** | 43 / 102 (16 by coverage, 27 counted by request) | 6 / 6 | 46 min | $0.415 |

Notes:
- **Requirements, cases, scripts, pages:** `prd.json`, `testcases.json`, `scripts/manifest.json`, `testcases.json` coverage block.
- **Endpoints:** `coverage/coverage.json` of the run folder. S1, S2, S3 and Planka were re-measured on the final scripts (1 Nov); the final measurement's file holds all 136 scripts; the earlier Kutt files hold all their scripts except kutt-pg (106 of 117).
- **Wall time:** run creation to the last pipeline stage finish; it includes pauses and resumes (the final measurement paused for about 2 h between stages; S2 includes the crash and the resume). Execute and analyze are not included. The clean single-session runs (S1, S3, three Kutt, Planka) took 31–53 min, mean 44.5 min.
- **Cost:** all calls in the run's `llm-calls.jsonl` (PRD, cases, gaps, scripts, review). Analysis cost is in section 6. The cost of the planned 3 repeats is not in these runs (single generation per suite).
- **Model:** z-ai/glm-5.3-flash on the Wafer provider in every run.

## 2. Development trajectory (25 Oct to the final measurement)

### 2a. The six detection targets (fixed 25 Oct, SPEC §0.2)

| Target | Goal | Baseline, trial suite (24–25 Oct) | Last cloud check `eval-9b-8lpp5` (25 Oct) | Final measurement (29–30 Oct) |
|---|---|---|---|---|
| Browser cases kept | ≥ 70% | 38% (11 of 29) | 75% | 90% (54 of 60 ui scripts valid) *(est.; earlier definition not reproducible, the earlier script was not kept)* |
| Writes that read data back | ≥ 80% | 34% (25 of 74) | 70% | 86% (59 of 69 api write cases carry a read-back expectation) *(est., same caveat)* |
| API endpoints reached | ≥ 68 of 73 | 62 of 73 | about 61 of 73 *(est. by a text search at the time)* | 65 of 69 (94%) from coverage |
| Dashboard / ui pages opened | ≥ 8 of 11 | 0 of 11 | 8 of 11 | 39 of 39 *(the page set and its definition grew: all ui routes tied to a test)* |
| Development bugs caught | ≥ 7 of 10 | 4 of 10 | 6 of 10 | **5 of 10** |
| Golden all-pass | all | 98/98 | 114/115 (TC-018 race) | 136/136 (cloud) |

As recorded at the time, five of the six targets were met at the final measurement; the development bugs caught (5 of 10, target 7) was the one missed.

### 2b. Development bugs caught, per cloud repeat on the development set (10 bugs; bug-003 and bug-008 excluded as likely equivalent mutants)

| Round | Date | Cloud repeat → source run | Cases, passed / suspected / invalid | Golden | Caught (of 10) | Which |
|---|---|---|---|---|---|---|
| 1 | 24 Oct | `eval-9b-vf2vj` → `M-20261020-204011` | 130; 98 / 11 / 21 | 98/98 | **4** | 002, 006, 009, 010 |
| 2 | 25 Oct 13:24 | `eval-9b-ccb95` → `M-20261025-112008` | 138; 100 / 15 / 23 | 100/100 | **6** | 002, 006, 009, 010, 011, 012 |
| 3 | 25 Oct 18:02 | `eval-9b-phc6f` → `M-20261025-152610` (early state) | 140; 94 passed at that time | 93/94 | **3** | 002, 006, 010 |
| 4 | 25 Oct 20:27 | `eval-9b-8lpp5` → `M-20261025-152610` (S1+S2 rerun) | 140; 115 / 7 / 18 at that time | 114/115 | **6** | 002, 006, 009, 010, 011, 012 |
| 5 | 30 Oct 09:37 | `eval-9b-lmn5p` → `M-20261029-202744` | 150; 136 / 3 / 11 | 136/136 | **5** | 002, 006, 010, 011, 012 |

Your list "4, 3, 6, 5" has four rounds; the run folders hold five repeats. The 6 of 25 Oct 13:24 (round 2) is the one not in your list. Counts of the caught bugs were recomputed with the scoring code on the development variants (`targets/mern-ecommerce/dev-bugs/trial-20261022/variants.json`, code variants only); with the two equivalents included they are one higher where bug-003 or bug-008 were caught (none were).

### 2c. The six apps / targets used in the work, in order

| Step | App | Run(s) | Result |
|---|---|---|---|
| First target | mern-ecommerce | `M-20261020-204011` (130 cases, 98 / 11 / 21, $0.596) | trial suite caught 4 of 12 code bugs |
| Detection work | mern-ecommerce | `M-20261025-112008`, `M-20261025-152610` | 138 → 140 cases, 100 → 120 passed |
| Development app 2 | Kutt (SQLite) | first and second run | 119/119 and 123/123 golden; 2 and 6 suspected |
| Database adapter | Kutt (PostgreSQL) | `kutt-pg-20261029-160623` | 117/117; no PostgreSQL-specific cause found |
| Final measurement | mern-ecommerce | `M-20261029-202744` | 136 passed, 3 suspected, 11 invalid |
| Held out | Planka | run 1 (config only) | section 4 |

## 3. Held-out results (the three suites at freeze-v1)

Source: `scoring/out/scores.md`, `scoring/out/final-review.md`, `scoring/out/why-not-caught.md`, `scoring/out-notools/scores.md`. Protocol and code hashes are the ones recorded before any drawn-bug diagnosis was read (checked equal on 1 Nov).

### 3a. The three-suite scores (with tools; 12 code bugs, 5 environment faults per suite)

| Metric | S1 | S2 | S3 | Mean | Range | SD |
|---|---|---|---|---|---|---|
| Mutation score (code bugs caught, protocol) | 16.7% (2/12) | 33.3% (4/12) | 33.3% (4/12) | **27.8%** | 16.7–33.3 | 9.6 |
| Classification correct (caught code bugs) | 100% | 75% | 100% | 91.7% | 75–100 | 14.4 |
| File correct | 50% | 75% | 100% | 75.0% | 50–100 | 25.0 |
| Line within ±5 | 50% | 75% | 100% | 75.0% | 50–100 | 25.0 |
| Environment faults detected | 5/5 | 5/5 | 5/5 | 100% | – | 0 |
| Environment faults classified correctly | 5/5 | 5/5 | 5/5 | 100% | – | 0 |
| Golden false alarms (diagnosed `app_defect`) | 0% | n/a | n/a | 0% | – | – |

Equivalent mutants: none listed (`equivalents.json` empty), so raw and adjusted scores are equal. Bugs caught per suite: S1 009, 012; S2 008, 009, 010, 012; S3 006, 008, 009, 012. Caught in 3 of 3 suites: 009, 012; never caught: 001, 002, 003, 004, 005, 007, 011.

### 3b. Sensitivity: genuine catches only

Two of the ten catches are accidental (bug-009 in S1 by an unrelated seller-form timeout, TC-130; bug-010 in S2 by a locator strict-mode failure, TC-099; in both the failing test's path does not include the mutated line).

| | S1 | S2 | S3 | Mean | Range | SD |
|---|---|---|---|---|---|---|
| Mutation score, protocol | 16.7% | 33.3% | 33.3% | 27.8% | 16.7–33.3 | 9.6 |
| **Mutation score, genuine catches only** | **8.3% (1/12)** | **25.0% (3/12)** | **33.3% (4/12)** | **22.2%** | 8.3–33.3 | 12.7 |
| Same, bug-010 also removed from the denominator *(not in `equivalents.json`: rule 8 covers only bugs no suite caught)* | 9.1% (1/11) | 27.3% (3/11) | 36.4% (4/11) | 24.2% | 9.1–36.4 | 13.9 |
| Classification / file / line within ±5, genuine catches (8 catches) | 100% | 100% | 100% | 100% | – | 0 |

### 3c. Why the bugs were not caught (36 bug-suite cells)

| Outcome | Cells | Which |
|---|---|---|
| Caught, genuine | 8 | bug-012 ×3, bug-009 ×2, bug-008 ×2, bug-006 ×1 |
| Caught by accident | 2 | bug-009 S1 (true cause: not reached), bug-010 S2 (true cause: equivalent) |
| (a) equivalent | 3 | bug-010 ×3 |
| (b) not reached | 5 | bug-002 S2/S3, bug-003 S2/S3, bug-009 S1 |
| (c) reached, not checked | 20 | bug-001 ×3, bug-002 S1, bug-003 S1, bug-004 ×3, bug-005 ×3, bug-006 S1/S2, bug-007 ×3, bug-008 S1, bug-011 ×3 |
| (d) masked | 0 | – |

Of the 28 cells without a genuine catch: 20 reached but not checked, 5 not reached, 3 equivalent, 0 masked. No test checked an ordering (bug-003, 004, 005), the `success` flag (bug-007, bug-008), `isLiked` on a logged-in list (bug-006), an empty state (bug-002), the admin view (bug-001) or a duplicate name (bug-011).

### 3d. Ablation: analyzer with tools vs without tools (same executions, same scoring rules)

| Metric (mean over 3 suites) | With tools | Without tools |
|---|---|---|
| Mutation score (does not depend on the analyzer) | 27.8% | 27.8% |
| Classification correct (code, protocol) | 91.7% | **0.0%** |
| Classification correct, genuine catches only | 100% | not computed (all 0% with the 10 catches) |
| File correct / line within ±5 | 75.0% / 75.0% | **0.0% / 0.0%** |
| Environment faults detected | 100% | 100% |
| Environment faults classified correctly | 100% (15/15) | 93.3% (14/15; supplementary "majority of failing tests": 80%) |
| Confusion, expected `app_defect` | 9 app_defect, 1 test_defect | 6 inconclusive, 4 test_defect, 0 app_defect |
| Analysis cost per suite | $0.287 ($0.204–0.365) | $0.017 ($0.015–0.020) |
| Analysis time per suite (sum of groups) | 689 s (430–1160) | 154 s (132–183) |

## 4. Planka (held-out app), run 1 at freeze-v1 with configuration only

Source: `scoring/out/planka-run1.md`. Planka v2.1.0 (`91eb43f4…`); no browser-login settings in the config (`auth.storage`, `auth.uiLogin` could not describe the app's login).

| Pre-registered measure | Result |
|---|---|
| Golden all-pass | **69 of 69** (70 scripts that failed their dry run are not run on golden) |
| Browser (ui) cases kept | **13 of 27 (48%)**; of the 18 cases that need a logged-in page only 4 (22%) were kept, each by writing its own login; the 9 login-page cases all passed |
| Suspected defects | **6** (TC-030, 041, 046, 075, 116, 139); by the reviews none is an application defect (2 script faults, 3 wrong expectations because the app answers 404 on purpose, 1 failed review) |
| Endpoints reached | **43 of 102 (42%)** (16 by coverage + 27 counted by request); 31 of 102 before the gap round |

Funnel: PRD 9 features / 39 requirements / 102 endpoints; 139 cases (96 first pass + 43 gap round; the gap round asked for 71 endpoints, 2 sessions failed); scripts 69 passed / 6 suspected / **64 invalid**; 3 page snapshots, all the login page; cost $0.415.

**The 64 invalid scripts, by layer and cause**

| Cause | api | ui | Total |
|---|---|---|---|
| Browser login missing | 0 | 12 | **12** |
| Expectation differs from the app (status, error code, field) | 19 | 0 | 19 |
| List created with a wrong enum value (`kanban`; the app accepts `active` or `closed`) | 9 | 0 | 9 |
| Other response shape guessed wrong | 9 | 0 | 9 |
| A test-created user cannot log in (terms acceptance, 403) | 8 | 0 | 8 |
| Type check / lock check violation | 5 | 0 | 5 |
| Other ui (list setup) | 0 | 2 | 2 |
| **Total** | **50** | **14** | **64** |

By framework failure category: runtime-error 33, value-less-expect 19, timeout 6, lock-check 4, typecheck 2. Missing browser login accounts for 12 of 64 (19%) and 12 of the 14 invalid ui scripts; at most those 12 could be rescued by fixing it. Adaptation cost recorded for run 1 (SPEC §0.2): one `tests/` entry not added, and the browser-login gap that led to the patch (`auth.storage.extra`, `css` locator; tag `planka-adapted`). **Run 2 (with the patch) is not part of these tables: no run file exists yet.**

## 5. Real bugs found in the target apps by the pipeline

| # | App | Bug | Found by |
|---|---|---|---|
| 1 | mern-ecommerce (golden `7f73dfb`) | `GET /api/address/:id` for an unknown id sends 404 without `return`, then throws `ERR_HTTP_HEADERS_SENT` twice; one unauthenticated request exits the backend with code 1 (`server/routes/api/address.js:52-60`) | an execution incident (`backend-crashed` before TC-026), not an assertion; present in every version |
| 2 | Kutt v3.2.6 | `users.handler.js` uses `CustomError` without importing it, so banning an unknown or already banned user answers 500 (`ReferenceError`) instead of 400 (`users.handler.js:117`; `main` lacks the import too) | suspected defect TC-065 of `kutt-20261029-175214`, confirmed in source and server log |
| 3 | Kutt v3.2.6 | `renders.handler.js:293` `linkEdit` reads `link.domain` of a missing link, so `/link/edit/<unknown id>` answers 500 | the server log of the same run |
| 4 | mern-ecommerce (golden `7f73dfb`) | The merchant approval endpoints lack the admin role check: `PUT /api/merchant/approve/:id` (`server/routes/api/merchant.js:150`), `PUT /api/merchant/reject/:id` (line 181) and `PUT /api/merchant/:id/active` (line 124) use only `auth`, while the admin-only routes of the same file use `role.check(ROLES.Admin)` (lines 70, 97, 259-263). Any logged-in member can approve a merchant application: the merchant becomes `Approved` and a user with the merchant role is created (or the existing user with that email gets the merchant role, `createMerchantUser`, lines 314-358). | the first trial suite: TC-068 "non-admin cannot approve a merchant" expected 403, got 200 on golden (dry run, 20 Oct); confirmed by hand on 1 Nov by running golden: a member got 200 and the merchant became `Approved` with a `ROLE MERCHANT` user, while `GET /api/merchant` gave the member 403 and a request without a token gave 401 |

None was checked against the upstream issue list for mern-ecommerce; for Kutt, no existing issue was found by title search. No Planka defect is claimed. Kutt TC-073 (a banned custom domain still accepts new links) is recorded as a product gap, explicitly not claimed as a defect. Bug 4 was added on 1 Nov after a manual check; it was found by a test case of the first trial suite (an assertion failure on golden, which the review had kept as a suspected defect), not by the final suites.

## 6. Cost and time per stage, averaged

Generation stages (source runs; cost = sum of call costs by purpose; time = first to last call of that purpose, so pauses inflate it):

| Stage | Cost, 4 mern runs | Cost, all 8 runs | Time per run | Calls per run |
|---|---|---|---|---|
| PRD | $0.083 | $0.090 | 4.1 min (mern 3.9; others 4.3) | 52 |
| Test cases | $0.070 | $0.061 | 3.3 min (3.0; 3.5) | 42 |
| Gap round (`gaps`) | $0.009 | $0.010 | 3.1 min, from the stage timestamps (eight runs, 1.9–4.5 min) | 10 |
| Scripts incl. repair and dry runs | $0.237 | $0.235 | **36 min** on the six clean runs (S1 42.7, S3 28.1, Kutt 22.1 / 40.6 / 41.1, Planka 41.1); not given for the final measurement (116 min with a pause) and S2 (62 min with the crash and resume) | 359 |
| Review of failed scripts | $0.015 | $0.027 | inside the scripts time | 58 (mern), 137 (others) |
| **Generation total** | **$0.414** (0.391–0.453) | **$0.423** (0.373–0.472) | clean runs 31–53 min, mean 44.5 | – |

The 8 runs are the four mern final runs (202744, S1, S2, S3), the three Kutt runs and Planka run 1.

Later stages (the three final suites):

| Stage | Cost | Time |
|---|---|---|
| Local golden execution (suite time) | no model | 159–220 s for the mern runs (final measurement 220, S1 199, S2 209, S3 159); Kutt 85–110 s; Planka 79 s |
| Cloud execution per version (18 tasks per suite) | no model call (cloud price estimate for 18 tasks: *not found*; for the earlier trial image 12,201 task-seconds ≈ $0.54 at list price, SPEC) | mean task 584 / 581 / 453 s; longest task 4283 / 4410 / 3720 s (env-01, database unreachable); golden task 213–265 s |
| Analysis with tools | $0.365 / $0.291 / $0.204, mean **$0.287** | 1160 / 430 / 476 s, mean **689 s** |
| Analysis without tools | $0.020 / $0.016 / $0.015, mean **$0.017** | 183 / 146 / 132 s, mean **154 s** |
| **One suite end to end, with tools** | **$0.60–0.82** (generation $0.40–0.45 + analysis $0.20–0.37) | generation 36–70 min + cloud run and analysis *(cloud wall time not found for the final suites)* |

## Not found or estimated (summary)

- Browser cases kept and writes read back for the final measurement: derived from run files with a different definition (marked *est.*); the script that gave the earlier 75% and 70% was not kept.
- Endpoints at the 25 Oct cloud check: "about 61 of 73" is a text estimate recorded at the time.
- Wall times of the cloud runs and the cloud cost of the final suites.
- Planka run 2.
