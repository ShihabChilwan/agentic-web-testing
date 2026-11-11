# Comparator check on a second app: Kutt (11 Nov 2026)

A measurement, not development: no comparator rule, prompt or `src/` file was changed.

## Setup

- **Suite:** `runs/kutt-20261029-175214-diff`, a copy of `kutt-20261029-175214`. This is a **development suite** (made on 29 Oct 2026 after fixes 7a–7c), **not a frozen evaluation suite**: Kutt was a development app and never had a frozen suite. 141 cases; 123 scripts passed their dry run and are executed; 18 are skipped (invalid or assertion_failed).
- **Target:** `targets/kutt` (SQLite), golden `6ca8033` (v3.2.6). Framework: `main` at `e31c20c` (comparator v2 rules), which is past `freeze-v1`, so `eval variants` ran with `--allow-unfrozen`.
- **Bugs:** `targets/kutt/evaluation.json` + `variants.json`, sealed in commit `5fa7aae` before any bug execution (variants.json sha256 `c9a74de1…2b91a0`).
  - Stryker 10.0.0 listed **3577 mutants** in 15 files. **1524** use the 8 mutators of the mern evaluation.
  - Seed 20261111 **drew 12** (backend only, at most 2 per file). **0 were discarded**: all 12 installed, seeded and started on the first try. Tests were not run during the draw.
  - `server/handlers/locals.handler.js` was left out of the agreed globs before the draw. Stryker parses files as ES modules, and this file declares `function protected`, a reserved word in strict mode, so Stryker stopped with a parse error. Every other file in the globs parses.
- **Runs:** noise x-02..x-04 (correct app), fresh check x-05 (correct app), bugs x-06..x-17. All used `--record-responses --record-pages`; every comparison used base x-02.

## Correct-app check (x-02 → x-05)

**4 strong, 4 weak**, all from noise:

- 2 strong: `GET /<random 6-character address>` present in one run only (TC-040, TC-102)
- 2 strong: `relative_created_at` / `relative_updated_at` read "0 seconds ago" in one run and "1 second ago" in the other (TC-064)
- 4 weak: `END/PAGE /<random address>+` (TC-116, TC-117)

## Per bug

"Strong" counts every strong difference. The part in brackets is my reading of which ones come from the noise sources described under "What did not fit Kutt"; it is not a rule.

| Bug | File:line | Change | Tests failed | Strong (noise / other) | Weak | First bug-related difference | Comparator (rule) | Comparator (my reading) |
|---|---|---|---|---|---|---|---|---|
| 001 | links.handler.js:330 (`editAdmin`) | `...(description && {description})` → `...(false)` | 0 | 5 (5/0) | 6 | none | yes | no |
| 002 | validators.handler.js:213 (`addDomainAdmin`, homepage) | URL check → `true` | 0 | 2 (2/0) | 7 | none | yes | no |
| 003 | user.queries.js:25 | `if (match.id)` → `if (false)` (Redis cache branch) | 0 | 9 (5/4) | 113 | the other 4 are the TC-088 page race | yes | no |
| 004 | domains.handler.js:37 (`addAdmin`) | `...(banned && {banned_by_id})` → `...(true)` | 0 | 6 (6/0) | 6 | none | yes | no |
| 005 | auth.handler.js:23 | `type === "oidc"` → `true` | 104 (59 failed, 45 errored) | 621 (3/618) | 700 | TC-001 `GET /api/v2/users` 200 → 401 "OIDC authentication failed." | yes | yes |
| 006 | passport.js:81 | `if (!env[key])` → `if (false)` (inside `OIDC_ENABLED`) | 0 | 6 (6/0) | 5 | none | yes | no |
| 007 | auth.handler.js:34 | `user && isStrict && !verified` → `user \|\| …` | 29 (26 failed, 3 errored) | 144 (4/140) | 6052 | TC-080 `GET /` 200 → 302, page nav "Settings" → "Log in / Sign up" | yes | yes |
| 008 | helpers.handler.js:78 | `parseInt(limit) \|\| 10` → `&& 10` | 3 (TC-027, 047, 060) | 69 (6/63) | 8 | TC-006 `GET /api/v2/users/admin` `limit` 10 → null | yes | yes |
| 009 | link.queries.js:217 | `expire_in \|\| null` → `&& null` | 1 (TC-034) | 8 (6/2) | 6 | TC-034 `POST /api/v2/links` `expire_in` "2026-11-11 …" → null | yes | yes |
| 010 | validators.handler.js:117-120 (`editLink`, address) | `.trim()` removed | 0 | 10 (6/4) | 112 | the other 4 are the TC-088 page race | yes | no |
| 011 | links.handler.js:360 (`remove`) | `if (req.isHTML)` → `if (true)` | 1 (TC-054) | 12 (4/8) | 114 | TC-054 `DELETE /api/v2/links/:id` body JSON → HTML fragment (the other 6: TC-088 race 4, TC-110 pairing 2) | yes | yes |
| 012 | users.handler.js:52 (`removeByAdmin`) | `if (req.isHTML)` → `if (false)` | 0 | 4 (4/0) | 5 | none | yes | no |

## Totals

| | Count | Bugs |
|---|---|---|
| Caught by tests | 5 | 005, 007, 008, 009, 011 |
| Comparator, by its rule (≥1 strong) | 12 | all, but the correct-app check also "catches" (4 strong), so this number means nothing on Kutt |
| Comparator, bug-related strong differences | 5 | the same 5 |
| Either | 5 | |
| Neither | 7 | 001, 002, 003, 004, 006, 010, 012 |

Why each "neither" was missed:

- **003, 006: dead code in this setup.** 003 only changes the Redis cache branch (Redis off). 006 is inside `if (env.OIDC_ENABLED)` (OIDC off). Both are effectively equivalent mutants here.
- **001:** only the admin link edit (`editAdmin`) loses the description. No executed test edits a description through that route.
- **002:** only the admin "add domain" homepage check is lost. The tests send no homepage the check would reject.
- **004:** `banned_by_id` is no longer set when an admin adds a banned domain. No test reads it.
- **010:** only matters for a custom address with spaces around it. No test sends one.
- **012:** only the htmx (HTML) admin user deletion changes. No browser test deletes a user from the admin page; the API path is unchanged.

Unlike mern, the comparator added **no** catch beyond the tests on Kutt. Every bug-related difference is in an execution where tests also failed.

## What did not fit Kutt (reported, not fixed)

1. **Random short-link addresses are not recognised as ids.** Kutt's short links are root paths (`GET /2H3EbB`, `END /WT6q8L+`). The endpoint normaliser keeps them as distinct endpoints, so each run creates new endpoint keys that are "present in one run only". Noise learning only remembers the exact addresses it saw. Result: 2 strong + 4 weak false differences in **every** comparison, including the correct-app check.
2. **Relative time texts.** `relative_created_at: "0 seconds ago"` vs `"1 second ago"` (TC-064). The noise runs all said "0 seconds ago", so the learned shape is "always the same", and the first "1 second ago" is strong.
3. **Page-snapshot race on fast server-side redirect chains (TC-088).** The login form → `/` → `/settings` → `/logout` chain runs faster than the snapshot after each navigation. In x-08, x-15 and x-16 the snapshot taken at "navigation /login" already shows the "Logged out" page, while x-02 shows "Welcome, alice". That gives 4 strong + 108 weak differences, and the test still passed. This is the same race as mern S2 bug-002 (TC-121). Comparator v2 made a page line on one side only weak, but here the line exists on both sides with different text, so it stays strong.
4. **Whole HTML documents and htmx fragments are one field.** A server-rendered page body (`GET /`, `(body)`) is compared as a single string. TC-110 in x-16 has two `GET /` documents (logged in and logged out) paired in the opposite order, which gives 2 strong differences whose only content is "the whole page differs". A real HTML difference (TC-054: JSON → htmx fragment) can't be read without opening the file.
5. **Weak-difference floods.** One page change spreads into thousands of weak lines (bug-007: 6052 weak), the same pattern as mern.
6. **Database differences:** none seen. With SQLite plus a snapshot restore, record ids repeated exactly across runs; integer ids and uuids caused no differences.

## Analyzer (Part 3)

Protocol pre-registered in commit `c0cc749` before any Kutt analysis existed. Because all 12 executions meet the case rule, all 12 are cases (5 test-caught, 7 comparator-only), plus the correct-app check x-05 as a control.

**Stopped in repeat 1 by cost.** The 4 completed analyses are all correct:

| Bug | Class | File | Lines (±5) | Primary diagnosis |
|---|---|---|---|---|
| 007 | right | right | right | app_defect 0.97 @ auth.handler.js:30-46 (basis: failure) |
| 008 | right | right | right | app_defect 0.97 @ helpers.handler.js:78 (basis: difference) |
| 009 | right | right | right | app_defect 0.97 @ link.queries.js:217 (basis: failure) |
| 011 | right | right | right | app_defect 0.98 @ links.handler.js:360-367 (basis: failure) |
| 005 | failed: OpenRouter 403 "Key limit exceeded (total limit)" partway | | | |

Everything else was skipped by the cap rule: the bug-005 baseline, the other 4 baselines, the 7 comparator-only cases, the control, and repeats 2 and 3. Per protocol these count as wrong in `out/scores.md`, which is why that file's percentages are low. Read the table above instead.

- **Cost:** $0.946 measured in `llm-calls.jsonl` (1702 calls, 65 refused with 403; 3 log lines were glued together by parallel appends and could not be read). **Time:** 16.5 min wall clock.
- **Why it stopped:** the analyses cost far more than on mern. bug-005 has 104 failing tests in 47 groups and bug-007 has 27 groups, so each needs dozens of sessions (bug-007 alone: 30 sessions, 377 calls). The API key also has a total limit of $1.50, which was reached together with the earlier mern measurement today. The key is now exhausted, so no further analysis is possible until its limit is raised.
- **Cost figures in the diagnoses files are overstated.** `summary.costUsd` sums every analyzer call in the run's log since that analysis started, so with 4 analyses running in parallel on one run, each one also counts the others' calls. The four summaries add up to $1.92; the log says $0.95. The cost column in `out/scores.md` uses the summaries, so it is too high.
