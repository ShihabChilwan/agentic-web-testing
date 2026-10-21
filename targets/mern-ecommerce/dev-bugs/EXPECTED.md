# Development bugs for the Failure Analyzer

Hand-written faults used only while developing step 7. They are **not** part of the
evaluation (the evaluation uses StrykerJS mutants sampled with a fixed seed) and must
never be used for scoring or shown to the analyzer.

All patches apply cleanly to golden (`7f73dfb`) with `git apply --check`.

| Id | Kind | What changes | What breaks | Expected diagnosis |
|---|---|---|---|---|
| dev-001 | Code, backend | `server/routes/api/auth.js` line 48: `if (!isMatch)` becomes `if (isMatch === null)`. `bcrypt.compare` returns `true` or `false`, never `null`, so the password check never fires | Login accepts any password: a wrong password returns 200 and a token instead of 400 `Password Incorrect` | `app_defect`, location `server/routes/api/auth.js` around line 48, violated requirement: login rejects a wrong password |
| dev-002 | Code, frontend | `client/app/containers/Login/index.js` line 32: a logged-in user visiting `/login` is redirected to `/` instead of `/dashboard` | The test that expects `/dashboard` after visiting `/login` while logged in | `app_defect`, location `client/app/containers/Login/index.js` line 32 |
| dev-003 | Environment | No patch: run the execution with `skipSeed` | No seeded products, categories, brands or admin; fixture users missing if seed requests are skipped too. Many tests fail for one shared reason | `environment_issue` (missing seed data), ideally one group, not dozens of separate app defects |

Why these three: one backend logic fault (the analyzer must read server code), one
frontend fault (it must read client code), and one environment fault (it must not blame
the code). dev-001 is narrow (few failures), dev-003 is wide (many failures, one cause),
which also exercises the grouping step.

The failing tests listed above are expectations, not facts: the first execution against
each dev bug shows which of the 98 validated tests actually fail.
