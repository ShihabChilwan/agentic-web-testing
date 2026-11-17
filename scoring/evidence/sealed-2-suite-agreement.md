# Sealed-2, mern-ecommerce: in how many suites each bug was caught

Computed on 17 Nov 2026 from `scoring/scenarios/out/detection.json` (no new run). The 25 sealed-2 code bugs of mern-ecommerce each ran with suites S1, S2 and S3 (75 bug-suite pairs). Each row counts the bugs caught by 0, 1, 2 or all 3 suites. Definitions are those of `scoring/scenarios/PROTOCOL.md`: "tests alone" = a TC test that failed on the bug and passed in all four correct runs; "tests + comparator" = that, or a TC test with a strong comparator difference; "with scenarios" adds the SC tests and their differences.

"Accidental removed" drops the catches whose only evidence is unrelated to the changed code (`scoring/scenarios/RESULTS.md`, "Catches with unrelated evidence"). Four of the five listed there are mern-ecommerce pairs (S1 bug-007, S1 bug-012, S1 bug-013, S3 bug-004); the fifth (Kutt bug-011) is not part of these 25. S1 bug-007 is a test catch (a TC-130 timeout); the other three are comparator-only.

| Measure | Set | 0 suites | 1 suite | 2 suites | 3 suites | Pairs caught (of 75) |
|---|---|---|---|---|---|---|
| Tests alone (failing TC test) | protocol counts | 11 | 4 | 1 | 9 | 33 |
| Tests alone (failing TC test) | accidental removed | 12 | 3 | 1 | 9 | 32 |
| Tests + comparator (protocol "caught by the suite") | protocol counts | 7 | 4 | 3 | 11 | 43 |
| Tests + comparator (protocol "caught by the suite") | accidental removed | 9 | 4 | 1 | 11 | 39 |
| With scenarios (protocol "caught with scenarios") | protocol counts | 6 | 4 | 3 | 12 | 46 |
| With scenarios (protocol "caught with scenarios") | accidental removed | 8 | 3 | 3 | 11 | 42 |

## Per bug (suites that caught it: S1 S2 S3; `a` = accidental catch, `·` = not caught)

| Bug | Tests alone | Tests + comparator | With scenarios |
|---|---|---|---|
| bug-001 | · · · | · · · | · · · |
| bug-002 | 1 2 3 | 1 2 3 | 1 2 3 |
| bug-003 | · · · | 1 · · | 1 2 · |
| bug-004 | 1 · · | 1 · a | 1 · a |
| bug-005 | · · · | · · · | · · · |
| bug-006 | · · · | · · · | · · · |
| bug-007 | a · · | a · · | a · · |
| bug-008 | 1 2 3 | 1 2 3 | 1 2 3 |
| bug-009 | · · · | · · · | · · · |
| bug-010 | 1 2 · | 1 2 · | 1 2 · |
| bug-011 | · · · | · · · | · 2 · |
| bug-012 | · · · | a · · | a · · |
| bug-013 | · · · | a · 3 | a 2 3 |
| bug-014 | 1 2 3 | 1 2 3 | 1 2 3 |
| bug-015 | 1 2 3 | 1 2 3 | 1 2 3 |
| bug-016 | · · · | · · · | · · · |
| bug-017 | 1 2 3 | 1 2 3 | 1 2 3 |
| bug-018 | 1 2 3 | 1 2 3 | 1 2 3 |
| bug-019 | 1 2 3 | 1 2 3 | 1 2 3 |
| bug-020 | 1 2 3 | 1 2 3 | 1 2 3 |
| bug-021 | 1 2 3 | 1 2 3 | 1 2 3 |
| bug-022 | · 2 · | 1 2 3 | 1 2 3 |
| bug-023 | · · · | · · · | · · · |
| bug-024 | · · · | 1 2 3 | 1 2 3 |
| bug-025 | · · 3 | · · 3 | · · 3 |
