# Scenario measurement: results (scenarios-v1)

Measured 16 Nov 2026 under `scoring/scenarios/PROTOCOL.md` (sha256 `60079d0632939284d9196be650dc47d4bf7cb4c3bc3066e684b452ab120b1777`) with `score.ts` (sha256 `240e418755f5bd6f67d6ccb848697e02d96b458446e60d9b5e0d9a45c84c6011`); both hashes were checked before the measurement started and match the pre-registered values. Framework: tag `scenarios-v1` (commit `4d267e0`); `freeze check --tag scenarios-v1` passed for mern-ecommerce and Kutt. Bug set: the sealed-2 lists (mern-ecommerce 25 code bugs, Kutt 12), unchanged since they were sealed (sha256 as recorded in commit `77c4011`). The development set (first 12-bug set) was **not run**.

Raw output: `out/detection.md`, `out/analysis-scores.md`, `out/supplementary/`. Tooling: `measurement/`.

## Suites and runs

| Suite | Source suite | Scenario suite (TC + SC scripts) | Image | Imported run |
|---|---|---|---|---|
| S1 | mern-ecommerce-20261030-125711-diff | -scn (156 + 40) | `4d267e0-adce1a89` | mern-ecommerce-20261116-165755 |
| S2 | mern-ecommerce-20261030-211147-diff | -scn (160 + 40) | `4d267e0-b742f66a` | mern-ecommerce-20261116-170003 |
| S3 | mern-ecommerce-20261031-201456-diff | -scn (139 + 40) | `4d267e0-bb1320f6` | mern-ecommerce-20261116-170159 |
| Kutt | kutt-20261029-175214-diff | -scn (141 + 40) | `4d267e0-ad214b75` | kutt-20261116-173309 |

S1's scenario suite was generated earlier the same day at `e523444`, the last `src/` commit before the tag (rule 3 of the protocol); S2, S3 and Kutt were generated in this measurement with the tagged code. One Cloud Run job per image: 4 correct-version runs (golden, golden-2, golden-3 as noise, golden-4 as the fresh check) and every sealed-2 bug, all 103 tasks succeeded.

## Detection (headline: sealed-2)

Columns: caught by a failing TC test; by a failing SC test; by a strong comparator difference in a TC test; in an SC test; by the suite alone (TC tests or TC comparator); with scenarios (any of the four); added by scenarios; caught by no failing test (comparator only); caught by nothing. No setup-changed finding occurred.

| Suite | Bugs | TC tests | SC tests | TC comparator | SC comparator | Suite | With scenarios | Added by scenarios | Comparator only | None |
|---|---|---|---|---|---|---|---|---|---|---|
| S1 | 25 | 12 | 4 | 16 | 7 | 17 | 17 | 0 | 5 | 8 |
| S2 | 25 | 11 | 6 | 12 | 9 | 12 | 15 | 3 | 3 | 10 |
| S3 | 25 | 10 | 5 | 14 | 7 | 14 | 14 | 0 | 4 | 11 |
| Kutt | 12 | 8 | 3 | 9 | 5 | 10 | 10 | 0 | 2 | 2 |
| **All** | **87** | **41** | **18** | **51** | **28** | **53** | **56** | **3** | **14** | **31** |

No version had missing data.

**Added by scenarios** (all in S2, all related to the changed code): bug-003 (SC-027: the admin review list shows "New" where the reviewer's initial "N" was), bug-011 (SC-018: activating a brand now runs the product-disabling branch, which crashes the backend for a brand without products; see "Backend crashes"), bug-013 (SC-003: an order's `priceWithTax` drops from 10 to 0 and `totalWithTax` disappears).

### False alarms (fresh check, golden-4 against golden)

| Suite | TC tests with a strong difference | SC tests with a strong difference | TC tests failing | SC tests failing |
|---|---|---|---|---|
| S1 | 0 | 0 | 0 | 0 |
| S2 | 0 | 0 | 0 | 0 |
| S3 | 0 | 0 | 0 | 0 |
| Kutt | 2 | 0 | 0 | 0 |

Kutt's two: TC-094 (the stats page prints the clock time, "Last update at 16:28" vs "16:27"; the three noise runs fell in the same minute, so the noise never learned it) and TC-125 (the header's Admin link missing from one page load).

### Catches with unrelated evidence (supplementary; the protocol numbers above stand)

Reading the evidence of every comparator-only catch (14) and of the catches that rest only on frequently failing tests found five whose evidence has nothing to do with the changed code:

| Pair | Changed code | Only evidence |
|---|---|---|
| S1 bug-012 | `review.js:133` approve returns the old document (`new: false`); the route answers only `{success: true}` | TC-084 product page: rating widget "0" vs "5" (snapshot timing) |
| S1 bug-013 | `store.js:31` tax null guard | the same TC-084 rating-widget timing |
| S3 bug-004 | product page review list condition | TC-106 address page captured mid-navigation |
| Kutt bug-011 | a validator rule | TC-094 clock time (as in the fresh check) |
| S1 bug-007 | order page loading flag | TC-130 (`/sell` form) timeout, which also times out in two other unrelated versions |

Without them: S1 suite 14 of 25, S3 13, Kutt 9; all suites 48 by the suite alone and 51 with scenarios (added by scenarios unchanged at 3). (Corrected 17 Nov 2026: this sentence first said 49 and 52, an arithmetic slip; 14 + 12 + 13 + 9 = 48, and 51 = 48 + 3. Recomputed from `out/detection.json`.) Catches by failing tests were not audited one by one beyond this check.

### Caught by nothing

"Evidence" = checked in the recorded responses and page snapshots of the correct runs; "likely" = from the changed code, not checked further.

| Bug | Missed in | Changed code | Why (one line) |
|---|---|---|---|
| mern bug-001 | S1, S2, S3 | `review.js:72` `brand?.isActive` → `brand.isActive` | Only differs for a product whose `brand` is missing (not null); every product read has one or `null`; reached 14–19 times per suite with no difference (evidence). |
| mern bug-003 | S3 | admin review list shows the full first name, not its initial | S3's only `/dashboard/review` visit is a "page not found" page; no review list is ever shown (evidence). |
| mern bug-004 | S2 | product page review list shown only when there are no reviews | No S2 test shows a product page that has approved reviews after they load (likely). |
| mern bug-005, bug-006 | S1, S2, S3 | support chat message list | The support chat needs a live socket conversation; tests open `/support` only with "No users connected" (evidence). |
| mern bug-007 | S2, S3 | order loading flag `true` → `false` | Changes only a spinner while orders load; the final page is the same (likely). |
| mern bug-009 | S1, S2, S3 | item status change picks the cart's first product | Differs only when the changed item is not the cart's first; tests with two-item orders (S1 TC-080, S2 SC-031) cancel the first item (evidence; corrected in `DIAGNOSTIC.md`). |
| mern bug-010 | S3 | admin/member branches of `GET /api/order/:id` swapped | A member reading their own order gets the same answer from either branch; S3 calls it 4 times in 2 tests, never across users (likely). |
| mern bug-011 | S1, S3 | brand activation also disables its products | S1 and S3 only deactivate brands, the branch the correct code already takes (likely). |
| mern bug-012 | S2, S3 | approve returns the old document | The route answers only `{success: true}` either way and the update still happens: no observable effect through the API (evidence). |
| mern bug-016 | S1, S2, S3 | pagination boundary `count > limit` → `>=` in the product list | The line runs in every suite; it differs only when exactly `limit` products match and the page is above 1, and tests reach count = limit only on page 1 (evidence; corrected in `DIAGNOSTIC.md`). |
| mern bug-023 | S1, S2 | merchant fields no longer trimmed | No S1/S2 test sends merchant input with surrounding spaces (likely). |
| mern bug-025 | S1, S2 | newsletter always answers "You must enter an email address." | S1/S2 call subscribe only with an empty email, which gets that answer anyway (evidence). |
| Kutt bug-005 | Kutt | `host.queries.js:37` an existing host is inserted again instead of updated | Reached only by banning a domain host that already exists; no test does (likely). |
| Kutt bug-010 | Kutt | `auth.handler.js:41` page requests get the header redirect instead of a 302 to `/logout` | Only weak differences on `GET /` in three browser tests; no test opens a protected page signed out in a way the comparator marks strong (likely). |

## Diagnosis on a sample

Sample (`score.ts sample`, seed 20261116): S2 bug-013 (scenario-only, comparator-only), S1 bug-003 (comparator-only), S1 bug-018, S3 bug-015, Kutt bug-009, S2 bug-019, S3 bug-004 (comparator-only), S3 bug-019, S1 bug-014, S2 bug-018. One analysis each with comparator differences, `--cost-cap 0.75` and one shared cost ledger. Scored with `score-sample.ts` (sha256 `97831a15449f72328ec7ef5335ea4a72f675bea0af20b70948710cf851b7d235`, committed before the first analysis), which applies the unchanged rules of `scoring/differential/PROTOCOL.md` (sha256 `ea7c7179…fbfce`).

| Set | Pairs | Class right | File right | Lines right |
|---|---|---|---|---|
| **Analysed (primary)** | 7 | 7/7 | 6/7 | 6/7 |
| All sampled, not analysed counted wrong | 10 | 7/10 | 6/10 | 6/10 |

Not analysed: S1 bug-003, S3 bug-004 and S1 bug-014. Each analysis stopped with `ENOENT` while writing the shared cost ledger: `CostBudget.add` (`src/llm/budget.ts`) writes every call's update through one temporary file per process, so two model calls of the same analysis finishing together race on it. Not the cost cap. The one wrong analysed pair is the scenario-only one, S2 bug-013: the analyzer described the chain correctly (a cart item without a product makes the tax calculation drop the order totals) but located it in `product.js`, where the product goes missing, instead of the removed null guard in `store.js:31`.

**Supplementary re-run of the three** (not part of the result above; `diagnoses.scenarios.rerun.json`, `out/supplementary/`): S1 bug-003 and S3 bug-004 with a copy of the ledger on the container's own disk, S1 bug-014 without a ledger and a cap of the remaining budget (0.479 USD), after the race hit it again. S1 bug-003: file and lines right, class wrong (primary diagnosis `test_defect` for an unrelated flaky test; the avatar change is found and located). S3 bug-004: `test_defect` (page snapshot timing), which matches the finding above that this catch is accidental. S1 bug-014: all three right.

## Backend crashes in the correct version (real-bug candidate)

| Suite | Crashes per correct run (all four runs) | Recorded as incidents |
|---|---|---|
| S1 | 3: one empty bulk write (after SC-037), two `ERR_HTTP_HEADERS_SENT` (TC-026, TC-109) | 2 or 3 (the TC-026 crash in 2 of 4 runs) |
| S2 | 0 | 0 |
| S3 | 1: `ERR_HTTP_HEADERS_SENT` (TC-026) | 0 |
| Kutt | 0 | 0 |

- **New candidate, mern-ecommerce at golden:** `PUT /api/category/:id/active` with `isActive: false` on a category without products exits the backend. `store.disableProducts` (`server/utils/store.js:14`, called from `category.js:143`) runs `Product.bulkWrite([])` without `await`; MongoDB rejects an empty bulk write and the unhandled rejection ends the process before the response. `brand.js` calls the same helper when a brand is deactivated (not observed here). SC-037 triggers it, but its only expectation is always true, so it passes.
- **Known:** `GET /api/address/:id` with an unknown id (TC-026, TC-109).
- **Effect on the numbers:** none found. In every correct run of a suite the crash count is the same and the responses of the triggering tests are the same (SC-037: both PUTs get no response in all four; TC-026 and TC-109 identical). The comparator and `score.ts` do not read incidents, so the varying incident count changes nothing.

## Deviations from the protocol's commands

1. **Page noise:** `agent noise` was given `--page-execs <golden>,<golden-2>,<golden-3>` as well as `--execs`; without it no page noise is built, and every earlier comparator measurement used it.
2. **Variant list paths:** `cloud-context --variants sealed-2/variants.json` resolves patch paths from `targets/<app>/`, so the sealed-2 lists' `variants/bug-NNN.patch` pointed at the earlier draw (for Kutt, a full set of 12 with the same names). The builds used copies with `sealed-2/` in front of each path (`measurement/*-sealed-2.json`, every other field identical); every patch inside every build folder was byte-compared with sealed-2 (25/25, 25/25, 25/25, 12/12; Kutt 0/12 equal to the earlier draw).
3. **Image export:** at the tag, `cloud-context` refuses to build because `dashboard/tests/redact.test.ts` contains a made-up key-shaped test value (`sk-or-v1-` followed by `abcdef0123456789` twice). During the four builds only, a local `.git/info/attributes` line (`dashboard/tests/** export-ignore`, never committed, removed afterwards) left the dashboard's test files out of the image.
4. **Kutt import:** `eval import` refused the Kutt repeat because 10 suite files call `api.patch(` (HTTP PATCH), which matches the leak word `.patch`. Kutt was imported with a copy of `src/eval/cloud/import.ts` that differs only in its imports (`measurement/kutt-import/`): its leak check applies the same pattern to every line of every file and skips `.patch(` calls; it found 0 leak words and 10 PATCH calls per execution.
5. **Analyzer sample scoring:** `scoring/differential/score.ts` reads its own fixed case list, so `score-sample.ts` was written for this sample, reusing its `scoreFile` (the rules) unchanged, and committed before any analysis.

The image also contains `targets/<app>/sealed-2/`, which the export does not exclude. Cloud tasks only run tests; analyses ran locally from the source trees the analyzer uses, and every imported execution passed the leak check.

## Cost and time

| Item | Cost | Time |
|---|---|---|
| Scenario generation S2, S3, Kutt | 0.180 USD (0.059, 0.064, 0.058; cap 1 each) | 14, 13, 19 min |
| Cloud Run (103 tasks, 2 vCPU / 4 GiB) | about 1.6 USD at list price (10.0 task-hours of task time, 72 k vCPU-s, 144 k GiB-s), inside the monthly free tier when nothing else used it | 23 min wall (16:23–16:46 UTC) |
| Analyzer sample | 0.144 USD (ledger; includes the three stopped analyses) | 4.9 min of analysis in the seven results |
| Supplementary re-runs | 0.149 USD | about 8 min |
| **Model total** | **0.473 USD** | |
