# Why 10 of 12 code bugs were not caught (suite 1)

Source run `mern-ecommerce-20261030-125711` (156 cases, 138 scripts passed), cloud run imported as `mern-ecommerce-20261030-175229`. Analysis only: no frozen path changed, no model call. Hashes of the protocol and the scoring code were checked after this analysis and are unchanged.

## Method

- Mutation diff and ground truth: `targets/mern-ecommerce/variants.json`.
- Backend coverage: re-measured with `agent gaps --measure-only` on all 138 passing scripts. The coverage in the run folder was stale (123 scripts, taken before the gap-round scripts); the old one is backed up in the session scratchpad. `coverage.json` lists lines that ran. It does not see module top-level code (route files' `router.get(...)` lines and model schemas count as not run), so a model file shows no lines.
- Frontend: no coverage exists, so "reached" means a passing browser script opens the page and takes the code path.
- Golden vs version: `results.json` of golden (x-03) and each version. Golden fails TC-033 (flaky) and passes it in 4 versions; it is excluded from catching and masks nothing here.
- Every execution, golden included, has a `backend-crashed` incident (the known `GET /api/address/:id` crash). The engine restarts the app. No bug's affected route sits behind a crash, so category (d) does not apply.

## Table

| Bug | File:line | Mutator | Category | Evidence (and the input that would expose it) |
|---|---|---|---|---|
| bug-001 | client/app/components/Manager/OrderItems/index.js:51 | ConditionalExpression (`!isAdmin` → `true`) | (c) reached, not checked | Only TC-083 opens `/order/:id`, as a member (alice), for whom `!isAdmin` is already true. No test opens it as admin. Input: admin on `/order/<id>` with an active item; expect the status dropdown, not "Cancel". |
| bug-002 | client/app/components/Manager/Support/index.js:121 | EqualityOperator (`> 0` → `>= 0`) | (c) | TC-139 opens `/support` as admin, but alice is online, so the list is never empty. Its E4 asserts "Select chat to start messaging" (the non-empty state), although its text says "no other users connected". Input: admin on `/support` with nobody else online; expect "No users connected." |
| bug-003 | client/app/containers/Product/actions.js:530 | UnaryOperator (`-1` → `+1`) | (c) | TC-032 chooses "Price High to Low" but only asserts that "Generic Steel Gloves" is hidden. That product is 31st of 100 by price, so it is absent from page 1 in both directions (checked in the seed data). Input: assert the first card is the dearest (995) or its price is above the next card's. |
| bug-004 | server/routes/api/user.js:43-44 | MethodExpression (`.sort('-created')` removed) | (c) | Lines ran (TC-049, the admin users page). TC-049 only checks that Alice is listed and Bob is hidden after a search; order is never asserted. Input: two or more users, expect the newest first (API `GET /api/user` or the first row of the users page). |
| bug-005 | server/routes/api/order.js:131-132 | MethodExpression (`.sort('-created')` removed) | (c) | Lines ran (TC-123, admin customer orders page, one order). It asserts the heading and a result label only. Input: two orders created in sequence, expect the newest first. |
| bug-006 | server/utils/auth.js:10-11 | ConditionalExpression (decoded token → `true`) | (c) | Lines ran: TC-068 sends an admin token to `GET /api/product/list`. The only effect is that `userDoc.id` is undefined, so `isLiked` is never set. No test reads `isLiked` from the list. Input: alice likes a product, then `GET /api/product/list` with her token; expect `isLiked: true` on it. |
| bug-007 | server/routes/api/wishlist.js:25 | BooleanLiteral (`success: true` → `false`, update branch) | (c) | Line ran: TC-087 posts the same product twice. It asserts the update message and the single entry, never the `success` flag (grep: no test reads `success` of a wishlist POST). Input: expect `body.success === true` on the repeat POST. |
| bug-008 | server/routes/api/cart.js:76 | BooleanLiteral (`success: true` → `false`) | (c), vacuous assertion | Line ran: TC-142 calls `DELETE /api/cart/delete/:cartId/:productId`. Its value-less E2 ("deletion succeeded") became `expect(String(body.success ?? '')).toBeTruthy()`, and `String(false)` is `"false"`, which is truthy. TC-143 does assert `{success: true}` but calls the other route (`/delete/:cartId`). Input: `expect(body.success).toBe(true)`. This is a weak-assertion pattern the lock check does not catch. |
| bug-010 | server/utils/queries.js:31 | BooleanLiteral (`preserveNullAndEmptyArrays: true` → `false`) | (a) likely equivalent | The `$unwind` is followed by `$match {'brand.isActive': true}`, which drops every product without a matching brand anyway. Checked in MongoDB with products with no brand, `brand: null` and a dangling brand id: 0 results with `true` and 0 with `false`. |
| bug-011 | server/models/category.js:26 | BooleanLiteral (`unique: true` → `false`) | (c) | Model top-level code, so no coverage line, but every category create loads it. `unique` also makes the slug plugin add a random suffix to a duplicate slug (`mongoose-slug-generator`). No test creates two categories with the same name; TC-059 tests a duplicate slug on `PUT`, which the route checks itself. Input: two `POST /api/category/add` with the same name; expect different slugs. |

## Counts (10 uncaught code bugs)

| Category | Bugs | Count |
|---|---|---|
| (a) likely equivalent | 010 | 1 |
| (b) not reached | none | 0 |
| (c) reached, not checked | 001, 002, 003, 004, 005, 006, 007, 008, 011 | 9 |
| (d) masked | none | 0 |

Equivalence candidates for the by-hand review after all three suites: **bug-010 only** (shown above). bug-003 and bug-008 were suspected equivalent in the development set; here both are observable (sort direction; response body), so they are not candidates.

## bug-009: caught, classified correctly, wrong file

The catch is an accident, not a detection.

- The mutated line is in `deactivateMerchant`, called only by `DELETE /api/brand/delete/:id`. No test calls that route: it is the one endpoint still unreached in the fresh coverage (66 of 67). The gap round did ask for it, but the session for the brand feature (F-10) failed (`AgentSubmitError: all 3 submit attempts were rejected`), so no case exists.
- The test that "caught" it is TC-130 (visitor submits the seller form on `/sell`): a 30 s timeout waiting for a success toast that is dismissed after 1 s. It passed on golden and in 12 of the 12 other code executions; it errored on bug-009 and on the 5 environment faults (expected there).
- The analyzer saw a timeout with an empty notification area and located it in `client/app/containers/Notification/index.js`. That is a reasonable reading of the evidence it had; the true change is in `server/routes/api/brand.js:240` and was not exercised. The classification "app_defect" was correct only because every code bug is expected to be one.
- Under the pre-registered rule (a test that passed on golden and failed on the version) this counts as caught. Report it as it is, with this note. A sensitivity figure for the report: without bug-009 the raw catch rate is 1 of 12 (8.3%), with file and line correct for that one.

## Summary for the report

Of the 10 code bugs the suite missed, 9 were reached by at least one passing script but never checked in the way that exposes them, and 1 (bug-010) is almost certainly an equivalent mutant. None was missed because the mutated code was never executed, and none was masked by flakiness or the known backend crash. The misses come from weak or missing assertions: no test checked ordering (bug-004, bug-005, bug-003), the `success` flag (bug-007, bug-008, where a truthiness check accepted `"false"`), `isLiked` on an authenticated listing (bug-006), an empty state (bug-002), the admin view (bug-001) or duplicate names (bug-011). The one apparent catch beyond bug-012, bug-009, was a timeout in an unrelated test; its mutated endpoint was never called, so the true detection rate on this suite is closer to 1 of 12.
