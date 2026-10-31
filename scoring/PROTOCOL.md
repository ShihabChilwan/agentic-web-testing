# Scoring protocol (final evaluation)

Written 30 Oct 2026, before any diagnosis of the freshly drawn bugs exists or has been read. The scorer in this folder implements exactly these rules; `npx tsx scoring/cli.ts hash` prints the SHA-256 of this file and of the scoring code. Both hashes are recorded in CLAUDE.md and in every `scores.json`. A change to a rule after the first drawn-bug diagnosis exists is a new protocol and is reported as such.

## Units

- **Suite:** one generation run (PRD, cases, scripts) on the frozen framework, with its cloud repeat imported as one run folder. The evaluation uses 3 suites.
- **Version:** golden, a code variant (`bug-NNN`, a Stryker mutant), or an environment fault (`env-NN`). Ground truth is the variant list `variants.json` (file, mutated lines, expected classification).
- Each version is scored per suite. Everything is judged against the golden execution of the same repeat.

## Rules

1. **Caught.** A version is caught in a suite when at least one test passed on the golden execution of that repeat and failed or errored on the version. Tests that did not pass on golden are excluded. A version whose cloud task produced no execution is not caught (and warned).
2. **Mutation score.** caught code variants ÷ code variants (raw). The adjusted score removes the equivalent mutants (rule 8) from numerator and denominator.
3. **Which diagnoses count.** Only diagnosis groups that include at least one test that counts as caught (rule 1). Groups about tests that also fail on golden are ignored.
4. **Primary diagnosis (decision A).** The group with the highest `confidence`; a tie goes to the group covering more tests, then to the earlier group.
   - **4a, classification:** the primary diagnosis over all classifications has the expected classification (code variant: `app_defect`; environment fault: `environment_issue`).
   - **4b, localization:** the highest-confidence group among those classified `app_defect` that have a location is the localization diagnosis. Without such a group, file and line are wrong.
5. **File and line (code variants only).** File correct: the localization diagnosis' `location.file` equals the variant's file (backslashes to slashes, a leading `./` removed). Line correct: file correct and the diagnosed line range overlaps the variant's lines widened by 5 lines on each side (`start − 5` to `end + 5`).
6. **Denominators.** Classification, file and line accuracy are computed over caught versions of the kind (code or environment). A caught version that was not analysed counts as not diagnosed correctly and is warned.
7. **Supplementary measures (reported, never primary).** "Any group": classification, file or line is right in any counted group, not only the primary one. "Majority": the classification covering the most failing tests (environment faults).
8. **Equivalent mutants.** Code variants no suite catches are reviewed by hand, on the mutation diff only, and listed with a written reason in `equivalents.json`. The raw score is always reported next to the adjusted one. No variant is listed as equivalent because a suite missed it, only because the mutation cannot change behaviour.
9. **Environment faults.** Scored on detection (rule 1) and classification (rule 4a). Where the fault is located is not scored.
10. **Golden.** Golden failures are listed; the golden false-alarm rate is the share of golden failing tests that are in a group classified `app_defect`. Each golden failure is also reviewed by hand and labelled test defect or latent bug.
11. **Cost and time.** Analysis cost (`diagnoses.json` summary `costUsd`), analysis time (sum of the groups' durations), and the cloud task duration per version, per suite and summed.
12. **Aggregation.** For each rate, the per-suite values, the mean, the range and the sample standard deviation (n − 1) over the suites that have a denominator. With three suites the range is the main statement of spread. Per version: in how many of the suites it was caught.
13. **Blinding.** The scorer prints no diagnosis text. Variant details appear only in the output after scoring.
14. **Scope of a run.** The scorer can be limited to one kind of version (`--kind`) only for the dress rehearsal on the development repeat, which has code variants only. The final scoring uses every version of the variant list, and it fails when a version is missing from a suite's mapping.
15. **Not scored here.** Fix plausibility (manual, by Shihab), the quality of the PRD, test cases and scripts (reported from the suites' own summaries).
