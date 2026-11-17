# Freeze-v1 evaluation: per-version evidence

Extracted on 17 Nov 2026 from the imported cloud runs (git-ignored `runs/`); full data in `freeze-v1-versions.json`. Rules: `scoring/PROTOCOL.md`. A version is caught when a test that passed on golden fails or errors on it. "Primary" = the highest-confidence diagnosis about those tests (classification is scored on it); "located" = the highest-confidence `app_defect` diagnosis with a location (file and line ±5 are scored on it). Recomputing the caught, classification and file columns from these rows gives `scoring/out/scores.json` and `scoring/out-notools/scores.json` exactly (0 mismatches). Accidental catches: `scoring/out/final-review.md` §2.

## S1 (source run `mern-ecommerce-20261030-125711`, imported `mern-ecommerce-20261030-175229`, repeat `eval-9b-gdn7w`)

| Version | Expected | Failing tests | Primary (tools) | Located (tools) | Primary (no tools) |
|---|---|---|---|---|---|
| golden | – | not passed on golden: TC-033 | test_defect 0.8 | – | inconclusive 0.4 |
| bug-001 | app_defect client/app/components/Manager/OrderItems/index.js:51-51 | none | – | – | – |
| bug-002 | app_defect client/app/components/Manager/Support/index.js:121-121 | none | – | – | – |
| bug-003 | app_defect client/app/containers/Product/actions.js:530-530 | none | – | – | – |
| bug-004 | app_defect server/routes/api/user.js:43-44 | none | – | – | – |
| bug-005 | app_defect server/routes/api/order.js:131-132 | none | – | – | – |
| bug-006 | app_defect server/utils/auth.js:10-11 | none | – | – | – |
| bug-007 | app_defect server/routes/api/wishlist.js:25-25 | none | – | – | – |
| bug-008 | app_defect server/routes/api/cart.js:76-76 | none | – | – | – |
| bug-009 | app_defect server/routes/api/brand.js:240-240 | TC-130 **(accidental)** | app_defect 0.55 | client/app/containers/Notification/index.js:14-39 | inconclusive 0.4 |
| bug-010 | app_defect server/utils/queries.js:31-31 | none | – | – | – |
| bug-011 | app_defect server/models/category.js:26-26 | none | – | – | – |
| bug-012 | app_defect server/routes/api/contact.js:14-14 | TC-090, TC-091, TC-092, TC-093 | app_defect 0.99 | server/routes/api/contact.js:14-18 | test_defect 0.6 |
| env-01 | environment_issue | TC-001, TC-003, TC-004, TC-006, TC-007, TC-008 (+119) | environment_issue 0.97 | – | environment_issue 0.85 |
| env-02 | environment_issue | TC-001, TC-002, TC-003, TC-004, TC-005, TC-006 (+125) | environment_issue 0.97 | – | environment_issue 0.98 |
| env-03 | environment_issue | TC-032, TC-038, TC-039, TC-040, TC-045, TC-049 (+30) | environment_issue 0.95 | server/routes/api/address.js:52-60 | environment_issue 0.6 |
| env-04 | environment_issue | TC-001, TC-002, TC-003, TC-004, TC-005, TC-006 (+125) | environment_issue 0.97 | – | test_defect 0.85 |
| env-05 | environment_issue | TC-018, TC-019, TC-032, TC-037, TC-038, TC-039 (+45) | environment_issue 0.98 | – | environment_issue 0.95 |

## S2 (source run `mern-ecommerce-20261030-211147`, imported `mern-ecommerce-20261031-193116`, repeat `eval-9b-kd8w2`)

| Version | Expected | Failing tests | Primary (tools) | Located (tools) | Primary (no tools) |
|---|---|---|---|---|---|
| golden | – | not passed on golden: none | – | – | – |
| bug-001 | app_defect client/app/components/Manager/OrderItems/index.js:51-51 | none | – | – | – |
| bug-002 | app_defect client/app/components/Manager/Support/index.js:121-121 | none | – | – | – |
| bug-003 | app_defect client/app/containers/Product/actions.js:530-530 | none | – | – | – |
| bug-004 | app_defect server/routes/api/user.js:43-44 | none | – | – | – |
| bug-005 | app_defect server/routes/api/order.js:131-132 | none | – | – | – |
| bug-006 | app_defect server/utils/auth.js:10-11 | none | – | – | – |
| bug-007 | app_defect server/routes/api/wishlist.js:25-25 | none | – | – | – |
| bug-008 | app_defect server/routes/api/cart.js:76-76 | TC-099, TC-145 | app_defect 0.99 | server/routes/api/cart.js:75-77 | test_defect 0.85 |
| bug-009 | app_defect server/routes/api/brand.js:240-240 | TC-152 | app_defect 0.95 | server/routes/api/brand.js:235-251 | inconclusive 0.3 |
| bug-010 | app_defect server/utils/queries.js:31-31 | TC-099 **(accidental)** | test_defect 0.93 | – | test_defect 0.85 |
| bug-011 | app_defect server/models/category.js:26-26 | none | – | – | – |
| bug-012 | app_defect server/routes/api/contact.js:14-14 | TC-085, TC-087 | app_defect 0.98 | server/routes/api/contact.js:14-18 | inconclusive 0.5 |
| env-01 | environment_issue | TC-001, TC-002, TC-003, TC-004, TC-005, TC-008 (+121) | environment_issue 0.95 | – | environment_issue 0.9 |
| env-02 | environment_issue | TC-001, TC-002, TC-003, TC-004, TC-005, TC-006 (+128) | environment_issue 0.97 | – | environment_issue 0.98 |
| env-03 | environment_issue | TC-018, TC-023, TC-024, TC-025, TC-026, TC-034 (+28) | environment_issue 0.94 | server/routes/api/order.js:163-198 | environment_issue 0.8 |
| env-04 | environment_issue | TC-001, TC-002, TC-003, TC-004, TC-005, TC-006 (+127) | environment_issue 0.95 | server/config/keys.js:2-6 | environment_issue 0.8 |
| env-05 | environment_issue | TC-007, TC-008, TC-018, TC-019, TC-023, TC-024 (+51) | environment_issue 0.97 | – | environment_issue 0.95 |

## S3 (source run `mern-ecommerce-20261031-201456`, imported `mern-ecommerce-20261031-222406`, repeat `eval-9b-52nwg`)

| Version | Expected | Failing tests | Primary (tools) | Located (tools) | Primary (no tools) |
|---|---|---|---|---|---|
| golden | – | not passed on golden: none | – | – | – |
| bug-001 | app_defect client/app/components/Manager/OrderItems/index.js:51-51 | none | – | – | – |
| bug-002 | app_defect client/app/components/Manager/Support/index.js:121-121 | none | – | – | – |
| bug-003 | app_defect client/app/containers/Product/actions.js:530-530 | none | – | – | – |
| bug-004 | app_defect server/routes/api/user.js:43-44 | none | – | – | – |
| bug-005 | app_defect server/routes/api/order.js:131-132 | none | – | – | – |
| bug-006 | app_defect server/utils/auth.js:10-11 | TC-033 | app_defect 0.92 | server/utils/auth.js:9-16 | inconclusive 0.5 |
| bug-007 | app_defect server/routes/api/wishlist.js:25-25 | none | – | – | – |
| bug-008 | app_defect server/routes/api/cart.js:76-76 | TC-043 | app_defect 0.98 | server/routes/api/cart.js:75-77 | inconclusive 0.4 |
| bug-009 | app_defect server/routes/api/brand.js:240-240 | TC-133 | app_defect 0.93 | server/routes/api/brand.js:235-251 | inconclusive 0.4 |
| bug-010 | app_defect server/utils/queries.js:31-31 | none | – | – | – |
| bug-011 | app_defect server/models/category.js:26-26 | none | – | – | – |
| bug-012 | app_defect server/routes/api/contact.js:14-14 | TC-089, TC-090, TC-100 | app_defect 0.99 | server/routes/api/contact.js:14-18 | test_defect 0.8 |
| env-01 | environment_issue | TC-001, TC-002, TC-003, TC-004, TC-005, TC-006 (+101) | environment_issue 0.95 | – | environment_issue 0.9 |
| env-02 | environment_issue | TC-001, TC-002, TC-003, TC-004, TC-005, TC-006 (+109) | environment_issue 0.97 | – | environment_issue 0.98 |
| env-03 | environment_issue | TC-012, TC-017, TC-018, TC-020, TC-036, TC-037 (+16) | environment_issue 0.95 | server/routes/api/address.js:46-66 | environment_issue 0.75 |
| env-04 | environment_issue | TC-001, TC-002, TC-003, TC-004, TC-005, TC-006 (+109) | environment_issue 0.95 | – | environment_issue 0.75 |
| env-05 | environment_issue | TC-011, TC-012, TC-013, TC-017, TC-018, TC-019 (+26) | environment_issue 0.98 | – | environment_issue 0.95 |
