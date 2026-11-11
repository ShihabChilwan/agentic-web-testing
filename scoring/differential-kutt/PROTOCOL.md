# Scoring protocol: diagnosing comparator differences on Kutt

Written 11 Nov 2026, after the comparator runs and before any analysis of a Kutt execution existed. `npx tsx scoring/differential-kutt/score.ts hash` prints the SHA-256 of this file, of `cases.json` and of `score.ts`; they are recorded in the commit that adds them, before the first analysis runs. A change afterwards is a new protocol and is reported as such.

The rules are those of the mern measurement (`scoring/differential/PROTOCOL.md`). Only the cases, the cost cap and the control differ. `score.ts` is a copy of the mern one; its only change prints the set sizes from `cases.json` instead of the fixed mern counts.

## Suite and bugs

- Suite K1: `runs/kutt-20261029-175214-diff`, a copy of the development suite `kutt-20261029-175214` (made after fixes 7a–7c, not a frozen evaluation suite). 123 executed tests.
- Bugs: the 12 code variants in `targets/kutt/variants.json` (sealed in commit 5fa7aae before any bug execution).
- Comparator: the version on this branch's base (comparator v2 rules), base execution x-02, noise from x-02, x-03 and x-04 (correct app). No rule was changed.

## Cases

The case rule is the mern one: a bug execution whose comparison has at least one strong difference. **All 12 bug executions meet it, and so does the fresh correct-app check x-05 (4 strong).** So `cases.json` lists all 12 cases:

- 5 are also caught by tests (at least one test failed): bug-005, bug-007, bug-008, bug-009, bug-011.
- 7 are caught by the comparator only: bug-001, 002, 003, 004, 006, 010, 012. Before any analysis, my reading is that every strong difference in these 7 comes from the same sources as the correct-app check (random short-link paths, "N seconds ago" texts, a page-snapshot race in TC-088, a response pairing swap in TC-110). Their scores are therefore reported, but not as evidence that the comparator found these bugs.

`cases.json` records the SHA-256 of each comparison file.

## Analyses

- **With differences:** every case, `agent analyze --run kutt-20261029-175214-diff --exec <x> --differences <comparison> --output diagnoses.differential.r<N>.json`, repeats N = 1, 2, 3.
- **Without differences (baseline):** the 5 test-caught cases, `agent analyze ... --output diagnoses.r<N>.json`, same repeats, on the same executions.
- **Control (supplementary, not scored by `score.ts`):** the correct-app check x-05 with its differences (`compare-x-02-x-05.json`), output `diagnoses.differential.r<N>.json`, 3 repeats. Reported: the classification and location of every diagnosis. A diagnosis of `app_defect` here is a false alarm caused by noise.
- Order: repeat 1 (test-caught with, test-caught without, comparator-only with, control), then repeat 2, then repeat 3. At most 4 analyses run at once; a repeat finishes before the next one starts.
- **Cost cap 1 USD (hard).** Measured cost is the sum of `costUsd` in the run's `llm-calls.jsonl` from the start of this measurement. An analysis is skipped, never cut short, when the measured cost plus 0.05 USD for each running analysis plus 0.05 USD for the next one would pass 1 USD. A skipped analysis is reported and scored as wrong.

## Rules (per case, per analysis file)

1. **Primary diagnosis:** the diagnosis with the highest `confidence`. A tie goes to the one covering more tests, then to the earlier id.
2. **Class right:** the primary diagnosis is `app_defect`.
3. **Localization diagnosis:** the highest-confidence `app_defect` diagnosis that has a location (same tie rule). Without one, file and lines are wrong.
4. **File right:** its `location.file` equals the variant's file (backslashes become slashes, a leading `./` is removed).
5. **Lines right:** the file is right, and its line range overlaps the variant's lines widened by 5 on each side.
6. A missing or unreadable analysis file counts as wrong on all three.

## Reported

- Per case and repeat: class, file, lines, and the primary diagnosis's confidence, basis and summary.
- Totals per repeat for: the comparator-only cases; the test-caught cases with differences; the same cases without differences. Each rate is given with the three per-repeat values, the mean, the range and the sample standard deviation.
- Cost and analysis time per repeat and in total. The control is reported separately.
