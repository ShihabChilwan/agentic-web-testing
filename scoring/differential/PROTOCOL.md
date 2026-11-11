# Scoring protocol: diagnosing comparator differences

Written 11 Nov 2026, before any analysis with comparator differences existed or was read. `npx tsx scoring/differential/score.ts hash` prints the SHA-256 of this file, of `cases.json` and of `score.ts`; they are recorded in the project notes before the first analysis runs. A change afterwards is a new protocol and is reported as such.

## Cases

`cases.json` lists 20 cases: one code bug in one suite that the comparator caught (at least one strong difference, comparator v2). Each names the execution where the comparator caught it (for S1 bug-002 the page-recording run) and its comparison file. 12 cases are caught by the comparator only (no test failed in that execution); 8 are also caught by tests (at least one test failed in that execution).

## Analyses

- **With differences:** every case, `agent analyze --differences <comparison> --output diagnoses.differential.r<N>.json`, repeats N = 1, 2, 3.
- **Without differences (baseline):** the 8 test-caught cases, `agent analyze --output diagnoses.r<N>.json`, same repeats, on the same executions.
- A repeat runs all its analyses before the next repeat starts. Analyses are skipped, never cut short, when the measured cost so far plus 0.05 USD per session of the next analysis would pass 3 USD; a skipped analysis is reported and scored as wrong.

## Rules (per case, per analysis file)

1. **Primary diagnosis:** the diagnosis with the highest `confidence`; a tie goes to the one covering more tests, then to the earlier id (the decision A of the main protocol).
2. **Class right:** the primary diagnosis is `app_defect`.
3. **Localization diagnosis:** the highest-confidence `app_defect` diagnosis that has a location (same tie rule). Without one, file and lines are wrong.
4. **File right:** its `location.file` equals the variant's file (backslashes to slashes, a leading `./` removed).
5. **Lines right:** file right, and its line range overlaps the variant's lines widened by 5 on each side.
6. A missing or unreadable analysis file counts as wrong on all three.

## Reported

- Per case and repeat: class, file, lines, the primary diagnosis' confidence, basis and summary (printed only after scoring).
- Totals per repeat for: the 12 comparator-only cases; the 8 test-caught cases with differences; the same 8 without differences. For each rate: the three per-repeat values, the mean, the range and the sample standard deviation (n − 1).
- Per case: in how many of the 3 repeats each of class, file and lines was right.
- Cost (sum of `summary.costUsd`) and analysis time (sum of `summary.durationMs`), per repeat and in total.
