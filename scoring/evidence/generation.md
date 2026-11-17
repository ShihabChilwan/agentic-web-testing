# Generated suites: per-run summary

Full per-case lists (id, layer, title, requirements, script outcome, failure category, attempts) in `generation.json`. Script outcome: passed = passed its dry run on the correct version; suspected = assertion failed and kept after review; invalid = no valid script.

| Suite | Run | Cases | Passed | Suspected | Invalid | Endpoints reached | Local golden execution (x-01) |
|---|---|---|---|---|---|---|---|
| S1 | `mern-ecommerce-20261030-125711` | 156 | 138 | 1 | 17 | 66 / 67 | 138/138 passed; not passed: none |
| S2 | `mern-ecommerce-20261030-211147` | 160 | 146 | 2 | 12 | 66 / 73 (1 by request) | 145/146 passed; not passed: TC-099 |
| S3 | `mern-ecommerce-20261031-201456` | 139 | 120 | 7 | 12 | 69 / 69 | 120/120 passed; not passed: none |
| Kutt SQLite, run 1 | `kutt-20261029-145043` | 131 | 119 | 2 | 10 | 24 / 31 | 119/119 passed; not passed: none |
| Kutt SQLite, run 2 | `kutt-20261029-175214` | 141 | 123 | 6 | 12 | 25 / 31 | 123/123 passed; not passed: none |
| Kutt PostgreSQL | `kutt-pg-20261029-160623` | 136 | 117 | 3 | 16 | 24 / 31 | 117/117 passed; not passed: none |
| Planka, run 1 (held out) | `planka-20261101-121912` | 139 | 69 | 6 | 64 | 43 / 102 (27 by request) | 69/69 passed; not passed: none |

Unreached endpoints per run are listed in `generation.json` (`endpoints.unreached`). The Kutt PostgreSQL coverage file was measured on 106 of its 117 passing scripts (stale; see `scoring/out/results-tables.md`).
