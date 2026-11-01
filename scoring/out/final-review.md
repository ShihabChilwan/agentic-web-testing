# Final review of the three suites

Suites: S1 = `mern-ecommerce-20261030-175229` (source run `-125711`), S2 = `mern-ecommerce-20261031-193116` (source `mern-ecommerce-20261030-211147`), S3 = `mern-ecommerce-20261031-222406` (source `mern-ecommerce-20261031-201456`). Analysis only: no frozen path changed, no model call, no change to `scoring/` code or `PROTOCOL.md` (hashes checked at the end and equal to the ones recorded on 30 Oct 17:03 UTC: `554b1969…4142` and `4f305962…5abc5bff`). `scoring/equivalents.json` is unchanged and the scoring was rerun: `scores.json` and `scores.md` are identical to the committed ones.

Method as in `why-not-caught.md`: mutation diff and ground truth from `targets/mern-ecommerce/variants.json`; golden vs version from `results.json`; backend coverage **re-measured** on the final scripts of S2 (146 scripts) and S3 (120) with `agent gaps --measure-only` (the coverage in those folders was stale: 130 and 103 scripts; old files kept in the session scratchpad; `run.json` untouched). Coverage lists lines that ran and does not see module top-level code (a model schema line shows nothing). For frontend bugs "reached" means a passing browser script takes the code path.

## 1. Why not caught: combined table (12 bugs × 3 suites)

Cell codes: **C** caught and genuine; **A** caught by accident (section 2); **a** equivalent; **b** not reached; **c** reached but not checked; **d** masked.

| Bug | File:line | Mutator | S1 | S2 | S3 | Evidence (one line each; the input that would expose it) |
|---|---|---|---|---|---|---|
| bug-001 | client/…/Manager/OrderItems/index.js:51 | ConditionalExpression `!isAdmin`→`true` | c | c | c | Every browser script that opens `/order/:id` is a member (alice: S1 TC-083; S2 TC-111; S3 TC-098), for whom `!isAdmin` is already true. Input: admin on `/order/<id>` with an active item; expect the status dropdown. |
| bug-002 | client/…/Manager/Support/index.js:121 | EqualityOperator `>0`→`>=0` | c | b | b | S1 TC-139 reaches `/support` but with alice online (never empty). S2: only TC-113 (signed out, redirected); the logged-in case TC-114 is invalid (typecheck). S3: TC-096 is invalid (timeout) and TC-017 only shows the menu link. Input: admin on `/support` with nobody online; expect "No users connected." |
| bug-003 | client/…/Product/actions.js:530 | UnaryOperator `-1`→`+1` | c | b | b | S1 TC-032 picks "Price High to Low" but asserts only that one product is hidden (it is 31st of 100 by price, hidden in both directions). S2: no script picks a sort option (TC-025 only shows the selector). S3: TC-037 picks "Price Low to High", the other `case`, so line 530 never runs. Input: choose High to Low and assert the first card is the dearest. |
| bug-004 | server/routes/api/user.js:43-44 | MethodExpression `.sort('-created')` removed | c | c | c | Lines ran in all three (admin users page: S1 TC-049, S2 TC-123, S3 TC-111). They assert who is listed, the count, and search results, never the order. Input: two or more users; expect the newest first. |
| bug-005 | server/routes/api/order.js:131-132 | MethodExpression `.sort('-created')` removed | c | c | c | Lines ran (S1 TC-123 UI; S2 TC-094 API, TC-121 UI; S3 TC-084 API with `limit=1`, TC-114 UI). Each test has at most one order in the restored database, so order cannot show. Input: two orders created in sequence; expect the newest first. |
| bug-006 | server/utils/auth.js:10-11 | ConditionalExpression decoded token→`true` | c | c | **C** | Lines ran in all three. S1 and S2: no script reads `isLiked` from `GET /api/product/list` with a token (they use `/api/wishlist`). S3 TC-033 does exactly that and failed. |
| bug-007 | server/routes/api/wishlist.js:25 | BooleanLiteral `success: true`→`false` (update branch) | c | c | c | Line ran in all three through a repeat POST (S1 TC-087, S2 TC-035, S3 TC-051); each asserts the update message and the entry, never the `success` flag. Input: `expect(body.success).toBe(true)` on the repeat POST. |
| bug-008 | server/routes/api/cart.js:76 | BooleanLiteral `success: true`→`false` | c | **C** | **C** | S1 TC-142: value-less E2 became `expect(String(body.success ?? '')).toBeTruthy()` and `String(false)` is truthy; TC-143 asserts `{success:true}` but calls the other route. S2 TC-145 and S3 TC-043 assert `success === true` on `DELETE /api/cart/delete/:cartId/:productId` and failed. |
| bug-009 | server/routes/api/brand.js:240 | LogicalOperator `\|\|`→`&&` | A (b) | **C** | **C** | S1: line 240 never ran (`DELETE /api/brand/delete/:id` unreached, F-10 gap session failed); the failing test TC-130 is an unrelated seller-form timeout. S2 TC-152 and S3 TC-133 delete a brand and failed at the delete. |
| bug-010 | server/utils/queries.js:31 | BooleanLiteral `preserveNullAndEmptyArrays` true→false | a | A (a) | a | Equivalent: the `$unwind` is followed by `$match {'brand.isActive': true}`, which drops products without a matching brand anyway (checked in MongoDB: no brand, null brand and dangling brand id give 0 results with `true` and with `false`). S2's only failing test, TC-099, is a locator strict-mode violation on the login page. |
| bug-011 | server/models/category.js:26 | BooleanLiteral `unique: true`→`false` | c | c | c | Model top-level code (no coverage line, loaded on every category create). `unique` also makes `mongoose-slug-generator` add a random suffix to a duplicate slug. No script in any suite creates two categories with the same name (the duplicate-slug tests use `PUT`, which the route checks itself). Input: two identical `POST /api/category/add`; expect different slugs. |
| bug-012 | server/routes/api/contact.js:14 | BooleanLiteral `!email`→`email` | **C** | **C** | **C** | Contact form tests fail in all three (S1 TC-090..093, S2 TC-085/087, S3 TC-089/090/100). |

### Counts

36 bug-suite cells.

| Outcome | Cells | Which |
|---|---|---|
| C: caught, genuine | 8 | bug-012 ×3, bug-009 ×2, bug-008 ×2, bug-006 ×1 |
| A: caught by accident | 2 | bug-009 S1 (true cause: b), bug-010 S2 (true cause: a) |
| a: equivalent | 3 | bug-010 ×3 (one of them caught by accident) |
| b: not reached | 5 | bug-002 S2/S3, bug-003 S2/S3, bug-009 S1 |
| c: reached, not checked | 20 | bug-001 ×3, bug-002 S1, bug-003 S1, bug-004 ×3, bug-005 ×3, bug-006 S1/S2, bug-007 ×3, bug-008 S1, bug-011 ×3 |
| d: masked | 0 | – |

The 28 cells without a genuine catch: 20 c, 5 b, 3 a, 0 d. No bug was hidden by the flaky golden failure (S1 TC-033 is a pagination test, unrelated to any mutated line) or by the known backend crash, which every execution has and the engine restarts.

### S2 and S3 in short

- **S2** (golden 146/146, 4 caught: 008, 009, 010, 012): of the 8 missed bugs, 2 are not reached (002, 003) and 6 are reached but unchecked (001, 004, 005, 006, 007, 011). bug-010 is the accidental catch.
- **S3** (golden 120/120, 4 caught: 006, 008, 009, 012): of the 8 missed, 2 not reached (002, 003), 5 unchecked (001, 004, 005, 007, 011) and bug-010 equivalent.
- **Why S1 caught less:** S1 had no script that deletes a brand (bug-009 not reached), none that reads `isLiked` from the list (bug-006), and a vacuous `success` assertion (bug-008). S2 and S3 included `DELETE` cart-item and brand-delete cases; the third suite also has the list-with-token case. The first two come from the gap round (S1's F-10 session failed; S2's F-03 session failed).

## 2. Accidental catches

Rule used: a catch is genuine when a failing test sends a request that runs the mutated code (or opens the mutated component) and fails on something the mutation changes.

| Suite | Bug | Failing tests | Path includes the mutated line? | Verdict |
|---|---|---|---|---|
| S1 | bug-012 | TC-090..093 | Yes: `POST /api/contact/add` | genuine |
| S1 | bug-009 | TC-130 (seller form, 30 s timeout) | No: line 240 never ran; the route is never called; TC-130 passed in 12 of 12 other code executions | **accidental** |
| S2 | bug-008 | TC-145 (+ TC-099) | TC-145 deletes a cart item and asserts `success:true` | genuine (TC-099 is unrelated, see below) |
| S2 | bug-009 | TC-152 | Yes: `DELETE /api/brand/delete/:id` | genuine |
| S2 | bug-010 | TC-099 only | No: TC-099 registers and logs in; it fails on `getByRole('navigation')` matching two navbars (strict-mode violation). It also failed on bug-008 and env-04, and passes on golden and the other 10 code versions. | **accidental** |
| S2 | bug-012 | TC-085, TC-087 | Yes (contact form) | genuine |
| S3 | bug-006 | TC-033 | Yes: logged-in product list read `isLiked`; analyzer located `auth.js` | genuine |
| S3 | bug-008 | TC-043 | Yes (`success:true` after cart-item delete) | genuine |
| S3 | bug-009 | TC-133 | Yes (brand delete) | genuine |
| S3 | bug-012 | TC-089, TC-090, TC-100 | Yes (contact form) | genuine |

Two of the ten catches are accidental. Both fall under the pre-registered catch rule (a test that passes on golden and fails on the version), so `scores.md` stays as it is and the sensitivity result is reported next to it.

### Sensitivity (accidental catches removed)

| | S1 | S2 | S3 | Mean | Range | SD |
|---|---|---|---|---|---|---|
| Mutation score, protocol (raw = adjusted, equivalents empty) | 16.7% | 33.3% | 33.3% | 27.8% | 16.7–33.3 | 9.6 |
| **Mutation score, genuine catches only** | 8.3% (1/12) | 25.0% (3/12) | 33.3% (4/12) | **22.2%** | 8.3–33.3 | 12.7 |
| Same, bug-010 also removed from the denominator (its equivalence is shown by the MongoDB check; see section 3 for why it is not in `equivalents.json`) | 9.1% (1/11) | 27.3% (3/11) | 36.4% (4/11) | 24.2% | 9.1–36.4 | 13.9 |
| Classification / file / line within ±5, genuine catches only (8 catches) | 100% | 100% | 100% | 100% | – | 0 |

With the accidental catches removed, every genuine catch (8 of 8) was classified `app_defect`, pointed at the right file and a line range within ±5 of the mutation. The protocol numbers (91.7% classification, 75% file and line) are lower only because of the two accidental catches: bug-009 S1 (right class by default, wrong file) and bug-010 S2 (`test_defect`, no location).

## 3. Equivalence review (diff only), never-caught bugs

Never caught in any suite: bug-001, 002, 003, 004, 005, 007, 011. Rule 8 requires a mutation that cannot change behaviour. None of the seven qualifies, so **`equivalents.json` stays empty** and the rerun gives identical scores.

| Bug | Reason it is not equivalent (from the diff) |
|---|---|
| bug-001 | `if (!isAdmin)`→`if (true)` changes the branch taken whenever `isAdmin` is true. |
| bug-002 | `users.length > 0`→`>= 0` changes the rendered view exactly when the list is empty. |
| bug-003 | `-1`→`+1` flips the sort direction of the price option. |
| bug-004 / 005 | Removing `.sort('-created')` changes result order whenever there are two or more documents (insertion order is ascending, the original is descending). |
| bug-007 | `success: true`→`false` changes a field of the response body. |
| bug-011 | `unique: true`→`false` removes the unique index and the slug plugin's duplicate handling. |

**bug-010** is a clear equivalent by diff plus a database check, but it was caught once (accidentally, S2), and rule 8 limits the review to bugs no suite caught ("no variant is listed because a suite missed it, only because the mutation cannot change behaviour" works in both directions: the protocol does not let me list a caught bug). I did not add it. Decision for you: report it as the one equivalence candidate in the thesis, and use the sensitivity row above (24.2%) if you want to show the effect.

## 4. Git exclusion

Already done: `scoring/` is committed (`3f5b8e9 feat: add the pre-registered scoring for the final evaluation`) and there is no `scoring` line left in `.git/info/exclude`. `git status` is clean. `scoring/out/final-review.md` (this file) is new and untracked.

## 5. Analyzer ablation (tools off), three suites

`agent analyze --no-tools` already writes `diagnoses.no-tools.json` next to the real `diagnoses.json`, so nothing is overwritten. To keep a clean folder (own transcripts, own `llm-calls.jsonl`, own cost) work on **copies** of the three imported runs. The scorer reads `diagnoses.json`, so in the copies the ablation file is moved into that name; the scoring code and the rules are then identical (same hashes).

```bash
cd /workspaces/agentic-web-testing
npx tsx src/cli.ts freeze check --target mern-ecommerce        # must print: frozen: freeze-v1 …
for R in mern-ecommerce-20261030-175229 mern-ecommerce-20261031-193116 mern-ecommerce-20261031-222406; do
  cp -a runs/$R runs/$R-notools                                 # copy; the real runs stay untouched
  for x in $(node -e "console.log(require('./runs/$R-notools/run.json').executions.map(e=>e.execId).join(' '))"); do
    npm run agent -- analyze --run $R-notools --exec $x --no-tools || echo "FAILED $R $x"
  done
  for d in runs/$R-notools/executions/x-*; do                   # use the ablation file where it exists
    if [ -f $d/diagnoses.no-tools.json ]; then mv $d/diagnoses.json $d/diagnoses.full.json; cp $d/diagnoses.no-tools.json $d/diagnoses.json; fi
  done
done
npx tsx scoring/cli.ts hash                                     # must print the two recorded hashes
npx tsx scoring/cli.ts \
  --suite runs/mern-ecommerce-20261030-175229-notools \
  --suite runs/mern-ecommerce-20261031-193116-notools \
  --suite runs/mern-ecommerce-20261031-222406-notools \
  --variants targets/mern-ecommerce/variants.json --out scoring/out-notools
```

Notes:
- Cost is about the same as the real analysis or lower (about $0.2–0.4 per suite; one session per failure group, no tools). It needs OpenRouter credit. Each folder copy is 95–190 MB (`du`), disk is not a problem.
- Check afterwards: every `FAILED` line (re-run that exec only with the same command), and that `scoring/out-notools/scores.md` lists 3 suites. Caught/not caught is independent of the analyzer, so **the mutation score must equal the real one** (27.8%, 16.7/33.3/33.3); only classification, file, line, environment detection, cost and time can differ.
- Compare in the report: classification, file and line within ±5 of the genuine catches only (the sensitivity row), and the environment-fault classification (15/15 with tools). Without tools the analyzer sees only the failing tests' titles and errors, so file and line should drop; that drop is the measured value of the tools.
- `scoring/out-notools/` is outside the frozen paths; commit it after the run.
