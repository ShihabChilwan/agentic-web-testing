# Scenario measurement: analyzer sample

Rules: scoring/differential/PROTOCOL.md (unchanged). Primary rates are over the analysed pairs; pairs not analysed are listed (PROTOCOL.md of the scenario measurement). The second row counts them as wrong (rule 6 of the differential protocol).

| Set | Pairs | Class right | File right | Lines right |
|---|---|---|---|---|
| Analysed | 3 | 1/3 (33.3%) | 2/3 (66.7%) | 2/3 (66.7%) |
| All sampled (not analysed = wrong) | 3 | 1/3 (33.3%) | 2/3 (66.7%) | 2/3 (66.7%) |
| Scenario-only pairs (analysed) | 0 | n/a | n/a | n/a |
| Comparator-only pairs (analysed) | 2 | 0/2 (0.0%) | 1/2 (50.0%) | 1/2 (50.0%) |

Cost 0.0659 USD; analysis time 5.7 min; sessions 20.

## Per pair

| Suite | Bug | Exec | Scenario-only | Comparator-only | Analysed | Class | File | Lines | Primary (confidence, class) | Located diagnosis |
|---|---|---|---|---|---|---|---|---|---|---|
| S1 | bug-003 | x-24 | no | yes | yes | no | yes | yes | 0.8, test_defect | client/app/components/Manager/ReviewList/index.js 21-33 |
| S3 | bug-004 | x-27 | no | yes | yes | no | no | no | 0.7, test_defect | - |
| S1 | bug-014 | x-11 | no | no | yes | yes | yes | yes | 0.98, app_defect | server/routes/api/product.js 200-204 |
