# Per-case evidence for the reported results

Small summaries extracted on 17 Nov 2026 from the run folders under `runs/`, which are git-ignored (they hold full executions, traces, recorded responses and model transcripts). No model was called and no run was repeated to make them. Nothing in this folder is part of a hashed set: it holds no `.ts` file, and the pre-specified hashes cover only `scoring/PROTOCOL.md`, the `.ts` files outside `tests/`, `out/` and the later measurement folders, and the named files of `scoring/differential/` and `scoring/scenarios/` (check with `node scoring/hash-check.mjs`).

| File | Result it supports | What it holds |
|---|---|---|
| `generation.md`, `generation.json` | README "Test generation" and "Transfer to other applications" | Per run: every test case with its layer, requirements and script outcome (passed, suspected, invalid), the endpoints reached and not reached, and the local golden execution |
| `freeze-v1-versions.md`, `freeze-v1-versions.json` | README "Fault detection" and "Diagnosis" (freeze-v1, 3 suites × 17 versions) | Per version: the failing test ids, the accidental flag, the primary and the located diagnosis with tools and without tools (class, confidence, file, lines, summary) |
| `comparator-v1-detection.md`, `comparator-v1-detection.json` | README "Response comparator" (20 of 36 by the comparator, 10 by tests, 22 by either) | Per bug and suite: caught by tests, caught by the comparator, the tests with a strong difference and the comparison files used |
| `sealed-2-suite-agreement.md` | Sealed-2 measurement (`scoring/scenarios/RESULTS.md`) | For the 25 mern-ecommerce bugs: how many were caught by 0, 1, 2 and 3 suites, with and without the accidental catches |

Already committed elsewhere and not repeated here: the per-version scores (`scoring/out/scores.json`, `scoring/out-notools/scores.json`), the reasons for every miss and the accidental catches (`scoring/out/why-not-caught.md`, `scoring/out/final-review.md`), the comparator diagnoses with each primary diagnosis (`scoring/differential/out/scores.json`, `scoring/differential-kutt/out/scores.json`), and the sealed-2 detection per bug with test ids and its diagnosis sample (`scoring/scenarios/out/`).
