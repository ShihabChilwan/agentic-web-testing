# Comparator v1: detection per bug and suite

The 12 freeze-v1 code bugs × 3 suites (36 pairs). Full data, including every comparison file used, in `comparator-v1-detection.json`. "Tests": the protocol catch of the cloud executions (`scoring/out/scores.json`). "Comparator": at least one strong difference (tag `comparator-v1`) in a comparison of that bug's local recorded execution with a correct one. The comparison files themselves stay in the git-ignored run folders `runs/<suite>-diff/differential-v1/`.

Totals: tests 10, comparator 20, either 22, neither 14.

| Suite | Bug | Tests | Comparator | Tests with a strong difference | Note |
|---|---|---|---|---|---|
| S1 | bug-001 | no | no | – |  |
| S1 | bug-002 | no | yes | TC-139 |  |
| S1 | bug-003 | no | yes | TC-032 |  |
| S1 | bug-004 | no | yes | TC-049 |  |
| S1 | bug-005 | no | no | – |  |
| S1 | bug-006 | no | no | – |  |
| S1 | bug-007 | no | yes | TC-087 |  |
| S1 | bug-008 | no | yes | TC-142 |  |
| S1 | bug-009 | yes | no | – | accidental test catch |
| S1 | bug-010 | no | no | – |  |
| S1 | bug-011 | no | yes | TC-018, TC-019, TC-032, TC-033, TC-037, TC-038, TC-039, TC-040 (+46) |  |
| S1 | bug-012 | yes | yes | TC-090, TC-091, TC-092, TC-093 |  |
| S2 | bug-001 | no | no | – |  |
| S2 | bug-002 | no | no | TC-121 | false strong difference, not counted |
| S2 | bug-003 | no | no | – |  |
| S2 | bug-004 | no | yes | TC-123 |  |
| S2 | bug-005 | no | no | – |  |
| S2 | bug-006 | no | no | – |  |
| S2 | bug-007 | no | yes | TC-035 |  |
| S2 | bug-008 | yes | yes | TC-145 |  |
| S2 | bug-009 | yes | yes | TC-152 |  |
| S2 | bug-010 | yes | no | – | accidental test catch |
| S2 | bug-011 | no | yes | TC-007, TC-008, TC-018, TC-019, TC-023, TC-024, TC-025, TC-026 (+51) |  |
| S2 | bug-012 | yes | yes | TC-085, TC-086, TC-087, TC-121 |  |
| S3 | bug-001 | no | no | – |  |
| S3 | bug-002 | no | no | – |  |
| S3 | bug-003 | no | no | – |  |
| S3 | bug-004 | no | yes | TC-083, TC-111 |  |
| S3 | bug-005 | no | no | – |  |
| S3 | bug-006 | yes | yes | TC-033 |  |
| S3 | bug-007 | no | yes | TC-050, TC-051 |  |
| S3 | bug-008 | yes | yes | TC-043 |  |
| S3 | bug-009 | yes | yes | TC-133 |  |
| S3 | bug-010 | no | no | – |  |
| S3 | bug-011 | no | yes | TC-011, TC-012, TC-013, TC-017, TC-018, TC-019, TC-020, TC-036 (+29) |  |
| S3 | bug-012 | yes | yes | TC-089, TC-090, TC-100 |  |
