# Scenario measurement: analyzer sample

Rules: scoring/differential/PROTOCOL.md (unchanged). Primary rates are over the analysed pairs; pairs not analysed are listed (PROTOCOL.md of the scenario measurement). The second row counts them as wrong (rule 6 of the differential protocol).

| Set | Pairs | Class right | File right | Lines right |
|---|---|---|---|---|
| Analysed | 7 | 7/7 (100.0%) | 6/7 (85.7%) | 6/7 (85.7%) |
| All sampled (not analysed = wrong) | 10 | 7/10 (70.0%) | 6/10 (60.0%) | 6/10 (60.0%) |
| Scenario-only pairs (analysed) | 1 | 1/1 (100.0%) | 0/1 (0.0%) | 0/1 (0.0%) |
| Comparator-only pairs (analysed) | 1 | 1/1 (100.0%) | 0/1 (0.0%) | 0/1 (0.0%) |

Cost 0.0383 USD; analysis time 4.9 min; sessions 13.

## Per pair

| Suite | Bug | Exec | Scenario-only | Comparator-only | Analysed | Class | File | Lines | Primary (confidence, class) | Located diagnosis |
|---|---|---|---|---|---|---|---|---|---|---|
| S2 | bug-013 | x-14 | yes | yes | yes | yes | no | no | 0.8, app_defect | server/routes/api/product.js 55-62 |
| S1 | bug-003 | x-24 | no | yes | no | no | no | no | - | - |
| S1 | bug-018 | x-17 | no | no | yes | yes | yes | yes | 0.95, app_defect | server/routes/api/merchant.js 214-216 |
| S3 | bug-015 | x-05 | no | no | yes | yes | yes | yes | 0.98, app_defect | server/routes/api/brand.js 19-23 |
| Kutt | bug-009 | x-06 | no | no | yes | yes | yes | yes | 0.95, app_defect | server/handlers/helpers.handler.js 20-35 |
| S2 | bug-019 | x-21 | no | no | yes | yes | yes | yes | 0.98, app_defect | server/routes/api/address.js 52-56 |
| S3 | bug-004 | x-27 | no | yes | no | no | no | no | - | - |
| S3 | bug-019 | x-23 | no | no | yes | yes | yes | yes | 0.98, app_defect | server/routes/api/address.js 52-56 |
| S1 | bug-014 | x-11 | no | no | no | no | no | no | - | - |
| S2 | bug-018 | x-29 | no | no | yes | yes | yes | yes | 1, app_defect | server/routes/api/merchant.js 214-216 |
