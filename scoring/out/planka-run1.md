# Planka, run 1 (config only, freeze-v1)

Run `planka-20261101-121912` on Planka v2.1.0 (`91eb43f47260498b1c237022f023f3deef92c11e`, branch `golden`), made with the framework as frozen (`run.json.frozen`: tag `freeze-v1`) and a target config with **no** browser-login settings (no `auth.storage`, no `auth.uiLogin`), because Planka's browser login cannot be described with them (SPEC §0.2, Planka ledger). Analysis only: nothing was changed for this report. One measurement was refreshed: the backend coverage in the run folder dated from 47 scripts, so I re-ran `agent gaps --measure-only` on the final 69 (no model; old file kept in the session scratchpad; `run.json` unchanged).

## The four pre-registered measures

| Measure | Planka run 1 | Reference (earlier apps, SPEC §0.2 targets) |
|---|---|---|
| **Golden all-pass** | **Yes: 69 of 69** (x-01, no incident, no backend crash). The 70 scripts that failed their dry run (64 invalid, 6 suspected) are not run on golden, as in every run. | mern-ecommerce suite 1: 138 of 138 |
| **Browser (ui) cases kept** | **13 of 27 = 48%.** Only 4 of the 18 cases that need a logged-in page were kept (22%), and each of those wrote its own login; the other 9 kept cases are login-page, redirect and callback pages that need no login. | target 70%; mern 75% (development check) |
| **Suspected defects** | **6** (TC-030, TC-041, TC-046, TC-075, TC-116, TC-139). By the reviews' own explanations none looks like an application defect: 2 script faults (wrong list id, wrong notification `format`), 3 wrong expectations (the app answers 404 instead of 403 on purpose: `is-admin.js` and `is-admin-or-project-owner.js` call `res.notFound()`, which I read in the code; TC-075 expects a pending token that a normal login never creates), 1 review whose submit was rejected (TC-046). To be checked by hand, as always. | mern: 3 in the final run, all test faults |
| **Endpoints reached** | **43 of 102 (42%)** after the gap round and the final scripts: 16 by backend coverage plus 27 counted because a passing script sent the request (the endpoint's only evidence is the route declaration, `server/config/routes.js`). The figure you quoted, **31 of 102**, is the measurement taken before the gap round (`run.json`, gaps stage). | mern-ecommerce: 66 of 67, 66 of 73 and 69 of 69 in the three suites |

## Funnel

| Stage | Result |
|---|---|
| PRD | 9 features, 39 requirements, 102 endpoints, 7 UI routes (159 s) |
| Test cases | 139 = 96 first pass + 43 from the gap round; 112 api, 27 ui |
| Gap round | asked for all 71 unreached endpoints, 8 sessions, 43 cases added; sessions for F-05 and F-06 failed (3 rejected submits each); 22 endpoints linked by the "same route file" fallback (all to REQ-028, because all routes sit in one file) |
| Scripts | 69 passed, 6 assertion-failed (suspected), **64 invalid**; 21 reviews (15 test case wrong, 5 script wrong, 1 failed) |
| Pages | 3 snapshots, all of them the login page (`/`, `/login` and `/oidc-callback` all end on `/login`): the cases stage saw no logged-in page |
| Execution | golden 69 of 69, 79 s suite time, restore 0.38 s each |
| Cost | $0.41 from the call log (PRD 0.07, cases 0.03, scripts 0.24, review 0.04, gaps 0.03); you quoted $0.37 |

## The 64 invalid scripts

By layer and cause (my classification of each script's attempt log; a script counts once, by its **last** error):

| Cause | api | ui | Total |
|---|---|---|---|
| **Browser login missing** (the helper stops with "no login form settings" or "no token storage settings", or the page stays on the login form) | 0 | **12** | **12** |
| List created with `type: 'kanban'` (the app accepts `active` or `closed`): the create answers 400, then `.id` of undefined | 9 | 0 | 9 |
| Other response shape guessed wrong (`.id` or `.accessToken` of undefined) | 9 | 0 | 9 |
| A user created by the test cannot log in: 403, the app asks every new user to accept its terms first | 8 | 0 | 8 |
| Expectation differs from the app (status, error code or field) | 19 | 0 | 19 |
| Script rule violation (type check, fixture literal, locked value) | 5 | 0 | 5 |
| Other ui (TC-057 list setup, TC-096 list setup) | 0 | 2 | 2 |
| **Total** | **50** | **14** | **64** |

By the framework's own failure category: runtime-error 33, value-less-expect 19, timeout 6, lock-check 4, typecheck 2.

### How many trace to the missing browser login

- **12 of the 64 invalid scripts (19%), 12 of the 14 invalid ui scripts (86%).** All 14 ui scripts that failed used the login helpers; 12 hit the helpers' missing-settings error in some attempt. All 14 used the full 5 attempts.
- **Counting the kept ones too:** 18 ui cases need a logged-in page; 14 are invalid, 4 passed only because the repair loop wrote its own login (CSS or the n-th textbox): TC-054, TC-060, TC-064, TC-095. The 9 anonymous ui cases (login form, redirects, OIDC callback) all passed.
- **Upper bound, not an estimate:** fixing login can rescue at most those 12. 4 of them (TC-061, TC-063, TC-065, TC-066) also fail first on the `kanban` list type, and 6 hit timeouts that may have other causes.
- **Not caused by it:** the other 52 invalid scripts (all 50 api and 2 ui), whose causes are in the table. The api scripts never use a browser, so the login gap cannot be the reason.

### Findings that are not about login

1. **Enum values the model cannot see (9 api scripts, plus 4 ui scripts that fail earlier).** The list type is checked by `isIn: List.KANBAN_TYPES` in the controller; the PRD and the request shapes did not carry the allowed values, and the model guessed `kanban` (20 scripts use it, 11 are invalid, 1 passed). A general weakness of the evidence, not something a config option can fix.
2. **Terms acceptance (8 api scripts).** A user created through the API must accept the terms before the first login (403 with a pending token). The fixture users are seeded already accepted, so only the users the tests create hit it. The `auth.login` request cannot do the second step.
3. **Expectations that contradict the code (19 api scripts, 3 of the 6 suspected).** Planka decides some answers in policy files wired by configuration (`server/config/policies.js`), for example 404 instead of 403. The cases were written from controller files, so they miss the status. This is the "configuration-wired frameworks" open item in SPEC §0.2.
4. **The cases stage saw nothing behind the login (3 snapshots of one page).** The UI cases for boards, cards and comments were written without seeing those pages.

## What run 2 changes

Run 2 uses the generic patch (`auth.storage.extra`, a `css` locator for `uiLogin`) with the same framework otherwise, so the difference to this run measures the login gap, plus the 4 other facts above that stay as they are. Everything in this file stays as the held-out result.
