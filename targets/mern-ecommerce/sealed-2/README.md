# Sealed bugs, set 2

Do not open, read or diff the files in this folder until the measurement they are planted for.
That includes `variants.json` and every file under `variants/`.

The set was drawn with Stryker from the golden commit using the inputs in `evaluation.json`
(new seed; mutants within 5 lines of any earlier bug were excluded; each kept mutant installed,
seeded and started; no tests were run on any of them). Its sha256 is recorded in the commit
message that added this folder, so any later change to the list can be detected.
