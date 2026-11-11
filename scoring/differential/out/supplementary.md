# Supplementary: re-run of three analyses that failed on a provider error

Not part of the pre-registered result (`scores.md`, where these three count as wrong under rule 6).

In repeat 2, three analyses ended with `LLMRequestError: 429 Provider returned error` (the model provider's rate limit) and wrote no file: S2 bug-004 (x-09), S2 bug-012 (x-17), S3 bug-006 (x-11). They were run once more after scoring, with the same code and inputs, into `diagnoses.differential.r2-retry.json` (the original repeat-2 files stay missing). Cost $0.0154.

| Case | Primary diagnosis | Class | File | Lines |
|---|---|---|---|---|
| S2 bug-004 | app_defect 0.7 @ server/routes/api/user.js:43-51: GET /api/user returns users in undefined natural order | right | right | right |
| S2 bug-012 | app_defect 0.98 @ server/routes/api/contact.js:14-18: the email presence check is inverted | right | right | right |
| S3 bug-006 | app_defect 0.95 @ server/utils/auth.js:3-20: checkAuth() returns true instead of the user | right | right | right |

With these three in place of the missing files, repeat 2 would read: comparator-only cases 100% class, file and lines; test-caught cases with differences 100%.
