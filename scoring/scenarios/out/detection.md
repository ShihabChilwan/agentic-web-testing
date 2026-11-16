# Scenario measurement: detection

| Suite | Bugs | TC tests | Suite (TC tests or comparator) | SC tests | SC comparator | With scenarios | Added by scenarios |
|---|---|---|---|---|---|---|---|
| S1 | 25 | 12 | 17 | 4 | 7 | 17 | 0 |
| S2 | 25 | 11 | 12 | 6 | 9 | 15 | 3 |
| S3 | 25 | 10 | 14 | 5 | 7 | 14 | 0 |
| Kutt | 12 | 8 | 10 | 3 | 5 | 10 | 0 |
| All | 87 | 41 | 53 | 18 | 28 | 56 | 3 |

## False alarms (fresh check against the base run)

| Suite | TC tests differing | SC tests differing | setup changed | TC failing | SC failing |
|---|---|---|---|---|---|
| S1 | 0 | 0 | no | 0 | 0 |
| S2 | 0 | 0 | no | 0 | 0 |
| S3 | 0 | 0 | no | 0 | 0 |
| Kutt | 2 | 0 | no | 0 | 0 |

## Per bug

| Suite | Bug | TC failing | TC differing | SC failing | SC differing | Caught by |
|---|---|---|---|---|---|---|
| S1 | bug-001 | 0 | 0 | 0 | 0 | none |
| S1 | bug-002 | 1 | 1 | 0 | 0 | suite |
| S1 | bug-003 | 0 | 1 | 0 | 0 | suite |
| S1 | bug-004 | 1 | 1 | 0 | 0 | suite |
| S1 | bug-005 | 0 | 0 | 0 | 0 | none |
| S1 | bug-006 | 0 | 0 | 0 | 0 | none |
| S1 | bug-007 | 1 | 0 | 0 | 0 | suite |
| S1 | bug-008 | 7 | 7 | 0 | 3 | suite |
| S1 | bug-009 | 0 | 0 | 0 | 0 | none |
| S1 | bug-010 | 1 | 1 | 0 | 0 | suite |
| S1 | bug-011 | 0 | 0 | 0 | 0 | none |
| S1 | bug-012 | 0 | 1 | 0 | 0 | suite |
| S1 | bug-013 | 0 | 1 | 0 | 0 | suite |
| S1 | bug-014 | 8 | 8 | 2 | 9 | suite |
| S1 | bug-015 | 1 | 2 | 0 | 0 | suite |
| S1 | bug-016 | 0 | 0 | 0 | 0 | none |
| S1 | bug-017 | 41 | 44 | 5 | 17 | suite |
| S1 | bug-018 | 1 | 1 | 0 | 0 | suite |
| S1 | bug-019 | 2 | 2 | 0 | 0 | suite |
| S1 | bug-020 | 103 | 110 | 32 | 32 | suite |
| S1 | bug-021 | 69 | 61 | 17 | 18 | suite |
| S1 | bug-022 | 0 | 1 | 0 | 1 | suite |
| S1 | bug-023 | 0 | 0 | 0 | 0 | none |
| S1 | bug-024 | 0 | 5 | 0 | 2 | suite |
| S1 | bug-025 | 0 | 0 | 0 | 0 | none |
| S2 | bug-001 | 0 | 0 | 0 | 0 | none |
| S2 | bug-002 | 1 | 1 | 0 | 0 | suite |
| S2 | bug-003 | 0 | 0 | 0 | 1 | scenarios only |
| S2 | bug-004 | 0 | 0 | 0 | 0 | none |
| S2 | bug-005 | 0 | 0 | 0 | 0 | none |
| S2 | bug-006 | 0 | 0 | 0 | 0 | none |
| S2 | bug-007 | 0 | 0 | 0 | 0 | none |
| S2 | bug-008 | 8 | 8 | 1 | 1 | suite |
| S2 | bug-009 | 0 | 0 | 0 | 0 | none |
| S2 | bug-010 | 1 | 1 | 0 | 0 | suite |
| S2 | bug-011 | 0 | 0 | 1 | 1 | scenarios only |
| S2 | bug-012 | 0 | 0 | 0 | 0 | none |
| S2 | bug-013 | 0 | 0 | 0 | 1 | scenarios only |
| S2 | bug-014 | 12 | 12 | 5 | 7 | suite |
| S2 | bug-015 | 1 | 1 | 0 | 0 | suite |
| S2 | bug-016 | 0 | 0 | 0 | 0 | none |
| S2 | bug-017 | 42 | 47 | 12 | 17 | suite |
| S2 | bug-018 | 1 | 1 | 0 | 0 | suite |
| S2 | bug-019 | 1 | 1 | 0 | 0 | suite |
| S2 | bug-020 | 103 | 113 | 36 | 35 | suite |
| S2 | bug-021 | 70 | 61 | 23 | 23 | suite |
| S2 | bug-022 | 1 | 1 | 0 | 0 | suite |
| S2 | bug-023 | 0 | 0 | 0 | 0 | none |
| S2 | bug-024 | 0 | 3 | 0 | 2 | suite |
| S2 | bug-025 | 0 | 0 | 0 | 0 | none |
| S3 | bug-001 | 0 | 0 | 0 | 0 | none |
| S3 | bug-002 | 1 | 1 | 0 | 0 | suite |
| S3 | bug-003 | 0 | 0 | 0 | 0 | none |
| S3 | bug-004 | 0 | 1 | 0 | 0 | suite |
| S3 | bug-005 | 0 | 0 | 0 | 0 | none |
| S3 | bug-006 | 0 | 0 | 0 | 0 | none |
| S3 | bug-007 | 0 | 0 | 0 | 0 | none |
| S3 | bug-008 | 3 | 3 | 1 | 3 | suite |
| S3 | bug-009 | 0 | 0 | 0 | 0 | none |
| S3 | bug-010 | 0 | 0 | 0 | 0 | none |
| S3 | bug-011 | 0 | 0 | 0 | 0 | none |
| S3 | bug-012 | 0 | 0 | 0 | 0 | none |
| S3 | bug-013 | 0 | 1 | 0 | 0 | suite |
| S3 | bug-014 | 9 | 9 | 1 | 4 | suite |
| S3 | bug-015 | 1 | 1 | 0 | 0 | suite |
| S3 | bug-016 | 0 | 0 | 0 | 0 | none |
| S3 | bug-017 | 38 | 40 | 4 | 14 | suite |
| S3 | bug-018 | 1 | 1 | 0 | 0 | suite |
| S3 | bug-019 | 2 | 2 | 0 | 0 | suite |
| S3 | bug-020 | 83 | 90 | 35 | 36 | suite |
| S3 | bug-021 | 50 | 44 | 19 | 19 | suite |
| S3 | bug-022 | 0 | 1 | 0 | 1 | suite |
| S3 | bug-023 | 0 | 0 | 0 | 0 | none |
| S3 | bug-024 | 0 | 4 | 0 | 2 | suite |
| S3 | bug-025 | 1 | 1 | 0 | 0 | suite |
| Kutt | bug-001 | 1 | 2 | 0 | 0 | suite |
| Kutt | bug-002 | 0 | 4 | 0 | 0 | suite |
| Kutt | bug-003 | 4 | 4 | 0 | 1 | suite |
| Kutt | bug-004 | 1 | 22 | 1 | 15 | suite |
| Kutt | bug-005 | 0 | 0 | 0 | 0 | none |
| Kutt | bug-006 | 82 | 80 | 31 | 30 | suite |
| Kutt | bug-007 | 39 | 2 | 0 | 1 | suite |
| Kutt | bug-008 | 9 | 12 | 3 | 3 | suite |
| Kutt | bug-009 | 5 | 0 | 0 | 0 | suite |
| Kutt | bug-010 | 0 | 0 | 0 | 0 | none |
| Kutt | bug-011 | 0 | 1 | 0 | 0 | suite |
| Kutt | bug-012 | 3 | 6 | 0 | 0 | suite |
