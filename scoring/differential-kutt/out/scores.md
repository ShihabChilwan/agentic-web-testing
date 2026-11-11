# Diagnosing comparator differences

Protocol: `scoring/differential-kutt/PROTOCOL.md` (sha256 eae99ed3d830c8876a780cf681e4eb012823612cbc6f26e4828a505b86769aa8); score.ts sha256 abbbf8a6c3aff48130d61d0f6055961b21062cddf53806cf4f6fde1ec33b95fd.

## Totals (per repeat; mean, range, sample SD)

| Set | Measure | R1 | R2 | R3 | Mean | Range | SD |
|---|---|---|---|---|---|---|---|
| Comparator-only cases (7), with differences | Class right | 0.0% | 0.0% | 0.0% | 0.0% | 0.0%–0.0% | 0.0% |
| Comparator-only cases (7), with differences | File right | 0.0% | 0.0% | 0.0% | 0.0% | 0.0%–0.0% | 0.0% |
| Comparator-only cases (7), with differences | Lines right (±5) | 0.0% | 0.0% | 0.0% | 0.0% | 0.0%–0.0% | 0.0% |
| Test-caught cases (5), with differences | Class right | 80.0% | 0.0% | 0.0% | 26.7% | 0.0%–80.0% | 46.2% |
| Test-caught cases (5), with differences | File right | 80.0% | 0.0% | 0.0% | 26.7% | 0.0%–80.0% | 46.2% |
| Test-caught cases (5), with differences | Lines right (±5) | 80.0% | 0.0% | 0.0% | 26.7% | 0.0%–80.0% | 46.2% |
| Test-caught cases (5), without differences | Class right | 0.0% | 0.0% | 0.0% | 0.0% | 0.0%–0.0% | 0.0% |
| Test-caught cases (5), without differences | File right | 0.0% | 0.0% | 0.0% | 0.0% | 0.0%–0.0% | 0.0% |
| Test-caught cases (5), without differences | Lines right (±5) | 0.0% | 0.0% | 0.0% | 0.0% | 0.0%–0.0% | 0.0% |
| All 12 cases, with differences | Class right | 33.3% | 0.0% | 0.0% | 11.1% | 0.0%–33.3% | 19.2% |
| All 12 cases, with differences | File right | 33.3% | 0.0% | 0.0% | 11.1% | 0.0%–33.3% | 19.2% |
| All 12 cases, with differences | Lines right (±5) | 33.3% | 0.0% | 0.0% | 11.1% | 0.0%–33.3% | 19.2% |

Missing analysis files (scored wrong): K1 bug-001 with R1, K1 bug-001 with R2, K1 bug-001 with R3, K1 bug-002 with R1, K1 bug-002 with R2, K1 bug-002 with R3, K1 bug-003 with R1, K1 bug-003 with R2, K1 bug-003 with R3, K1 bug-004 with R1, K1 bug-004 with R2, K1 bug-004 with R3, K1 bug-005 with R1, K1 bug-005 without R1, K1 bug-005 with R2, K1 bug-005 without R2, K1 bug-005 with R3, K1 bug-005 without R3, K1 bug-006 with R1, K1 bug-006 with R2, K1 bug-006 with R3, K1 bug-007 without R1, K1 bug-007 with R2, K1 bug-007 without R2, K1 bug-007 with R3, K1 bug-007 without R3, K1 bug-008 without R1, K1 bug-008 with R2, K1 bug-008 without R2, K1 bug-008 with R3, K1 bug-008 without R3, K1 bug-009 without R1, K1 bug-009 with R2, K1 bug-009 without R2, K1 bug-009 with R3, K1 bug-009 without R3, K1 bug-010 with R1, K1 bug-010 with R2, K1 bug-010 with R3, K1 bug-011 without R1, K1 bug-011 with R2, K1 bug-011 without R2, K1 bug-011 with R3, K1 bug-011 without R3, K1 bug-012 with R1, K1 bug-012 with R2, K1 bug-012 with R3

## Cost and time

| Repeat | With differences: cost | time | sessions | Without: cost | time | sessions |
|---|---|---|---|---|---|---|
| R1 | $1.921 | 1907 s | 51 | $0.000 | 0 s | 0 |
| R2 | $0.000 | 0 s | 0 | $0.000 | 0 s | 0 |
| R3 | $0.000 | 0 s | 0 | $0.000 | 0 s | 0 |

Total cost: $1.921; total analysis time: 1907 s.

## Per case (with differences; repeats right of 3, then R1..R3 primary diagnosis)

| Suite | Bug | Exec | Test-caught | Class | File | Lines | R1 | R2 | R3 |
|---|---|---|---|---|---|---|---|---|---|
| K1 | bug-001 | x-06 | no | 0/3 | 0/3 | 0/3 | missing | missing | missing |
| K1 | bug-002 | x-07 | no | 0/3 | 0/3 | 0/3 | missing | missing | missing |
| K1 | bug-003 | x-08 | no | 0/3 | 0/3 | 0/3 | missing | missing | missing |
| K1 | bug-004 | x-09 | no | 0/3 | 0/3 | 0/3 | missing | missing | missing |
| K1 | bug-005 | x-10 | yes | 0/3 | 0/3 | 0/3 | missing | missing | missing |
| K1 | bug-006 | x-11 | no | 0/3 | 0/3 | 0/3 | missing | missing | missing |
| K1 | bug-007 | x-12 | yes | 1/3 | 1/3 | 1/3 | app_defect 0.97 (failure) @ server/handlers/auth.handler.js:30-46: Every authenticated HTML page request is redirected to /logout because the jwtPage auth condition mishandles operator precedence, so the log | missing | missing |
| K1 | bug-008 | x-13 | yes | 1/3 | 1/3 | 1/3 | app_defect 0.97 (difference) @ server/handlers/helpers.handler.js:78-78: A wrong operator in parseQuery makes the default list limit NaN, so GET /api/v2/links returns limit: null instead of 10. | missing | missing |
| K1 | bug-009 | x-14 | yes | 1/3 | 1/3 | 1/3 | app_defect 0.97 (failure) @ server/queries/link.queries.js:217-217: The created link's expire_in is null even for a valid '1m' value because the link creation query never stores the sanitized expire_in value. | missing | missing |
| K1 | bug-010 | x-15 | no | 0/3 | 0/3 | 0/3 | missing | missing | missing |
| K1 | bug-011 | x-16 | yes | 1/3 | 1/3 | 1/3 | app_defect 0.98 (failure) @ server/handlers/links.handler.js:360-367: DELETE /api/v2/links/:id always renders an HTML partial (link removed dialog) instead of returning the required JSON {message}, because the  | missing | missing |
| K1 | bug-012 | x-17 | no | 0/3 | 0/3 | 0/3 | missing | missing | missing |

## Test-caught cases without differences (baseline)

| Suite | Bug | Class | File | Lines | R1 | R2 | R3 |
|---|---|---|---|---|---|---|---|
| K1 | bug-005 | 0/3 | 0/3 | 0/3 | missing | missing | missing |
| K1 | bug-007 | 0/3 | 0/3 | 0/3 | missing | missing | missing |
| K1 | bug-008 | 0/3 | 0/3 | 0/3 | missing | missing | missing |
| K1 | bug-009 | 0/3 | 0/3 | 0/3 | missing | missing | missing |
| K1 | bug-011 | 0/3 | 0/3 | 0/3 | missing | missing | missing |
