# Scenario measurement: why 31 cases were caught by nothing

A diagnostic after `RESULTS.md`, 16 Nov 2026. No model calls; nothing under `src/` changed. It does not change any reported number.

## Method

- **Coverage:** backend V8 line coverage, as the pipeline measures it for `agent gaps` (`measureCoverage`, `readV8Coverage`). The framework's function always runs `scripts/`, so `diagnostic/coverage-run.mts` repeats its steps with the execution request's `scriptsDir`, using only exported framework functions. Each suite's combined folder (`scripts-with-scenarios`) was split into a TC-only and an SC-only copy and run once each on the correct version (golden), locally: 8 runs, every test passed (S1 138 + 40, S2 146 + 40, S3 120 + 40, Kutt 123 + 40). Output: `diagnostic/coverage/<suite>-<tc|sc>.json` (lines that ran per file).
- **Executed:** at least one line of the bug's line range ran in a request (the framework counts a module's top-level code as not run, because it runs at load whatever the tests do).
- **Not measurable:** client code (React, run in the browser: backend coverage does not see it; there the evidence is the page snapshots) and a schema option that runs at module load.
- **Variation points:** a point "covers" the code when its citation is in the same file and its line range includes the bug's lines. Status: `selected` (one of the 40), `reserve` (one of the 10 kept for drops), `cut` (never written).
- Scripts: `diagnostic/analyse.cjs` (writes `diagnostic/cases.json`).

## 1. The 31 cases

"Evidence" = checked in recorded responses, page snapshots or coverage; "likely" = from the changed code only.

| Bug | Suite | File:line | TC ran it | SC ran it | Why missed (one line) |
|---|---|---|---|---|---|
| bug-001 | S1 | server/routes/api/review.js:72 | yes | yes | Differs only for a product whose `brand` is missing (not `null`); no such product exists (evidence). |
| bug-001 | S2 | server/routes/api/review.js:72 | yes | yes | Same as S1. |
| bug-001 | S3 | server/routes/api/review.js:72 | yes | yes | Same as S1. |
| bug-003 | S3 | client/app/components/Manager/ReviewList/index.js:29 | n/m | n/m | S3's only admin review list visit is a "page not found" page; no list is ever rendered (evidence). |
| bug-004 | S2 | client/app/components/Store/ProductReviews/index.js:24 | n/m | n/m | No S2 test shows a product page with approved reviews after they load (likely). |
| bug-005 | S1 | client/app/components/Manager/Support/MessageList.js:87-96 | n/m | n/m | The message list needs a live socket chat; tests open `/support` only with "No users connected" (evidence). |
| bug-005 | S2 | (same) | n/m | n/m | Same as S1. |
| bug-005 | S3 | (same) | n/m | n/m | Same as S1. |
| bug-006 | S1 | client/app/components/Manager/Support/MessageList.js:55 | n/m | n/m | Same component and reason as bug-005. |
| bug-006 | S2 | (same) | n/m | n/m | Same. |
| bug-006 | S3 | (same) | n/m | n/m | Same. |
| bug-007 | S2 | client/app/containers/Order/actions.js:43 | n/m | n/m | Only the loading flag while orders load; the final page is the same (likely). |
| bug-007 | S3 | (same) | n/m | n/m | Same. |
| bug-009 | S1 | server/routes/api/order.js:287 | yes | yes | `find(p => true)` picks the cart's first item; every test changes the first item (TC-080 has a two-item order and cancels item 1) (evidence). |
| bug-009 | S2 | server/routes/api/order.js:287 | no | yes | Same: SC-031 has a two-item order and cancels item 1 (evidence). |
| bug-009 | S3 | server/routes/api/order.js:287 | yes | no | Same: TC-123 uses a one-item order (evidence). |
| bug-010 | S3 | server/routes/api/order.js:207 | yes | no | Admin and member branches swapped; a member reading their own order gets the same answer from either; no S3 test reads an order across users (likely). |
| bug-011 | S1 | server/routes/api/brand.js:191 | yes | no | The condition always runs; the change matters only when a brand is activated, and S1's brand updates deactivate (likely). |
| bug-011 | S3 | server/routes/api/brand.js:191 | yes | no | Same as S1. |
| bug-012 | S2 | server/routes/api/review.js:133 | yes | yes | Approve answers `{success: true}` either way and the update still happens: nothing observable through the API (evidence). |
| bug-012 | S3 | server/routes/api/review.js:133 | yes | yes | Same. |
| bug-016 | S1 | server/routes/api/product.js:132 | yes | yes | `currentPage` differs only when exactly `limit` products match and the page is above 1; tests reach count = limit (10/10) only on page 1 (evidence). |
| bug-016 | S2 | server/routes/api/product.js:132 | yes | yes | Same. |
| bug-016 | S3 | server/routes/api/product.js:132 | yes | yes | Same. |
| bug-023 | S1 | server/models/merchant.js:11 | n/m | n/m | Schema option (`trim`), applied when merchants are saved (`POST /api/merchant/add` runs 19–25 times per suite); no input with surrounding spaces (likely). |
| bug-023 | S2 | (same) | n/m | n/m | Same. |
| bug-023 | S3 | (same) | n/m | n/m | Same. |
| bug-025 | S1 | server/routes/api/newsletter.js:10 | yes | no | Subscribe is called only with an empty email, which gets that answer anyway (evidence). |
| bug-025 | S2 | server/routes/api/newsletter.js:10 | yes | no | Same. |
| Kutt bug-005 | Kutt | server/queries/host.queries.js:37 | no | no | Never executed: `host.add` runs only when an admin bans a link with its "ban host" option; no test does (evidence). |
| Kutt bug-010 | Kutt | server/handlers/auth.handler.js:41 | yes | no | The line runs for header-mode (htmx) requests, where nothing changes; the change only affects page-mode redirects of signed-out or banned users, which no test reaches in a way the comparator marks strong (likely). |

n/m = not measurable with backend coverage.

## 2. Totals

| Group | Cases |
|---|---|
| Measured with coverage | 18 |
| Never executed | **1** (Kutt bug-005) |
| Executed but no difference | **17** |
| Not measurable: client code | 10 (bug-003 ×1, bug-004 ×1, bug-005 ×3, bug-006 ×3, bug-007 ×2) |
| Not measurable: schema option at module load | 3 (bug-023 ×3) |

Of the 18 measured cases, TC tests ran the bug's line in 16 and SC tests in 10. Of the 17 executed ones, the change has no observable effect at all through these interfaces in 5 (bug-012 ×2, and bug-001 ×3 with this data), and needs specific input the tests did not use in the other 12.

## 3. Variation points for the code nothing ran or nothing could measure

| Case | Point citing the bug's lines | Nearest points |
|---|---|---|
| Kutt bug-005 (never executed) | none | VP-071 **selected** bans a link with `userLinks` (all of the owner's links), not with the host option; VP-072 **cut** (banning an already banned link). No point cites `host.queries.js`. |
| bug-005, bug-006 (support chat; client) | none (no point cites `MessageList.js`) | Support points: S1 6, all **cut** (`server/socket/support.js`, `Support/index.js`); S2 5, VP-156 **selected** (a list point in `Support/index.js:39-45`), 4 cut; S3 5, all **cut**. |
| bug-023 (merchant schema) | none (no point cites `models/merchant.js`) | — |
| bug-003, bug-004, bug-007 (client) | none for those lines | S1 VP-055 **selected** cites `Order/actions.js:198-216` (another function; bug-007 was not missed in S1). |

For comparison, the executed cases. In 10 of 17 a point citing the bug's lines existed but was never written (cut or reserve only): S1 bug-001 (VP-155 reserve), bug-011 (VP-113, VP-124 to VP-127 cut), bug-016 (VP-034, VP-038 cut), bug-025 (VP-170 cut); S2 bug-001 (VP-039 cut), bug-009 (VP-083, VP-084 cut); S3 bug-001 (VP-093 cut), bug-009 (VP-087, VP-088 cut), bug-010 (VP-083, VP-084 cut), bug-012 (VP-097, VP-099, VP-100 cut). In 5 a citing point was selected and written, and its test still did not tell the versions apart: S1 bug-009 (VP-070), S2 bug-012 (VP-045), S2 bug-016 (VP-022), S3 bug-011 (VP-058), S3 bug-016 (VP-048). The other 2 (S2 bug-025, Kutt bug-010) had no citing point. A cut point that cites a line is not a test that would vary the right input: these are upper bounds on what more points could reach, not predictions.

## 4. Points cut by the cap, and the cost of writing all of them

| Suite | Points found | Selected | Reserve | Scripts written | Never written |
|---|---|---|---|---|---|
| S1 | 187 | 40 | 10 | 41 | 146 |
| S2 | 168 | 40 | 10 | 41 | 127 |
| S3 | 193 | 40 | 10 | 44 | 149 |
| Kutt | 109 | 40 | 10 | 41 | 68 |
| **Total** | **657** | 160 | 40 | 167 | **490** |

Measured in this generation (`scenarios/summary.json` and `llm-calls.jsonl` of each `-scn` run): discovery, which already finds every point, cost 0.024–0.032 USD per suite; writing scripts cost 0.029–0.036 USD per suite, about 0.0007–0.0009 USD per script, and took 6–13 s of script-stage time per script; stability runs took 2.5 min (mern) and 7.3 min (Kutt) for 40 scenarios. In the cloud runs an SC test took 0.3–0.6 s (mern) and 4.5 s (Kutt) plus about 0.7 s (mern) and 0.2 s (Kutt) for its data restore.

Rough cost of writing scripts for every point instead of 40, scaling those rates linearly:

| | Per suite | All four suites |
|---|---|---|
| Model (scripts for the never-written points) | +0.05–0.13 USD | about +0.40 USD (total generation about 0.65 USD instead of 0.24) |
| Generation time | +25–31 min (script stage +14–23 min, stability runs +8–13 min) | about +1.8 h, run one suite at a time |
| Each execution (one version) | +2.5–2.9 min (mern, 127–149 more tests) / +5.3 min (Kutt, 68 more) | 103 tasks: about +5 task-hours, about +0.8 USD at Cloud Run list price |

Caveats: the protocol caps a suite at 40 scenarios, so writing all points would be a new version (`scenarios-v2`); the per-script cost includes repairs at today's rate, and a larger set may drop more scripts; more tests per execution also mean more chances of a timing difference in the comparator.

## Corrections to RESULTS.md

Coverage and the recorded responses changed two "caught by nothing" reasons in `RESULTS.md`; its numbers are unchanged:

- bug-009: not "single-product orders". Two tests use two-item orders, but both cancel the first item, which the changed `find` also picks.
- bug-016: not "no test calls the brand product list". The changed line runs in every suite; it differs only when exactly `limit` products match and the page is above 1.
