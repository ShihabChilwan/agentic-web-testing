# Scores over 3 suite(s)

Protocol SHA-256: `554b1969f726ea6617786a7bf9de360862413cacb3612814cd86a040de504142`

Values per suite are separated by " / ". SD is the sample standard deviation (n − 1); with three suites read the range first.

| Metric | Per suite | Mean | Range | SD |
|---|---|---|---|---|
| Mutation score (raw, code variants) | 16.7% / 33.3% / 33.3% | 27.8% | 16.7% – 33.3% | 9.6% |
| Mutation score (equivalent mutants excluded) | 16.7% / 33.3% / 33.3% | 27.8% | 16.7% – 33.3% | 9.6% |
| Classification correct (code, caught) | 0.0% / 0.0% / 0.0% | 0.0% | 0.0% – 0.0% | 0.0% |
| File correct (code, caught) | 0.0% / 0.0% / 0.0% | 0.0% | 0.0% – 0.0% | 0.0% |
| Line within ±5 (code, caught) | 0.0% / 0.0% / 0.0% | 0.0% | 0.0% – 0.0% | 0.0% |
| Environment faults detected | 100.0% / 100.0% / 100.0% | 100.0% | 100.0% – 100.0% | 0.0% |
| Environment faults: classification correct (caught) | 80.0% / 100.0% / 100.0% | 93.3% | 80.0% – 100.0% | 11.5% |
| Supplementary: classification, any group | 0.0% / 0.0% / 0.0% | 0.0% | 0.0% – 0.0% | 0.0% |
| Supplementary: file, any group | 0.0% / 0.0% / 0.0% | 0.0% | 0.0% – 0.0% | 0.0% |
| Supplementary: line, any group | 0.0% / 0.0% / 0.0% | 0.0% | 0.0% – 0.0% | 0.0% |
| Supplementary: environment classification, any group | 100.0% / 100.0% / 100.0% | 100.0% | 100.0% – 100.0% | 0.0% |
| Supplementary: environment classification, majority of failing tests | 80.0% / 80.0% / 80.0% | 80.0% | 80.0% – 80.0% | 0.0% |
| Golden false-alarm rate (golden failures diagnosed app_defect) | 0.0% / n/a / n/a | 0.0% | 0.0% – 0.0% | n/a |

| Cost and time | Per suite | Mean | Range | SD |
|---|---|---|---|---|
| Analysis cost | $0.020 / $0.016 / $0.015 | $0.017 | $0.015 – $0.020 | $0.002 |
| Analysis time (sum of groups) | 183 s / 146 s / 132 s | 154 s | 132 s – 183 s | 26 s |
| Execution time per version (cloud task, mean) | 584 s / 581 s / 453 s | 539 s | 453 s – 584 s | 75 s |

## Per version

| Version | Kind | Equivalent | Caught (suites) | Caught per suite | Class ok | File ok | Line ok |
|---|---|---|---|---|---|---|---|
| bug-001 | code | - | 0 of 3 | - / - / - | - / - / - | - / - / - | - / - / - |
| bug-002 | code | - | 0 of 3 | - / - / - | - / - / - | - / - / - | - / - / - |
| bug-003 | code | - | 0 of 3 | - / - / - | - / - / - | - / - / - | - / - / - |
| bug-004 | code | - | 0 of 3 | - / - / - | - / - / - | - / - / - | - / - / - |
| bug-005 | code | - | 0 of 3 | - / - / - | - / - / - | - / - / - | - / - / - |
| bug-006 | code | - | 1 of 3 | - / - / yes | - / - / - | - / - / - | - / - / - |
| bug-007 | code | - | 0 of 3 | - / - / - | - / - / - | - / - / - | - / - / - |
| bug-008 | code | - | 2 of 3 | - / yes / yes | - / - / - | - / - / - | - / - / - |
| bug-009 | code | - | 3 of 3 | yes / yes / yes | - / - / - | - / - / - | - / - / - |
| bug-010 | code | - | 1 of 3 | - / yes / - | - / - / - | - / - / - | - / - / - |
| bug-011 | code | - | 0 of 3 | - / - / - | - / - / - | - / - / - | - / - / - |
| bug-012 | code | - | 3 of 3 | yes / yes / yes | - / - / - | - / - / - | - / - / - |
| env-01 | environment | - | 3 of 3 | yes / yes / yes | yes / yes / yes | - / - / - | - / - / - |
| env-02 | environment | - | 3 of 3 | yes / yes / yes | yes / yes / yes | - / - / - | - / - / - |
| env-03 | environment | - | 3 of 3 | yes / yes / yes | yes / yes / yes | - / - / - | - / - / - |
| env-04 | environment | - | 3 of 3 | yes / yes / yes | - / yes / yes | - / - / - | - / - / - |
| env-05 | environment | - | 3 of 3 | yes / yes / yes | yes / yes / yes | - / - / - | - / - / - |

Code variants caught by no suite (review by hand for equivalence, then list in equivalents.json): bug-001, bug-002, bug-003, bug-004, bug-005, bug-007, bug-011

## Confusion (expected → highest-confidence diagnosis, summed over suites, caught versions only)

| Expected | environment_issue | inconclusive | test_defect |
|---|---|---|---|
| app_defect | 0 | 6 | 4 |
| environment_issue | 14 | 0 | 1 |

## Warnings

- /workspaces/agentic-web-testing/runs/mern-ecommerce-20261030-175229-notools: 1 test(s) fail on golden (TC-033); they are excluded from catching; review them by hand
