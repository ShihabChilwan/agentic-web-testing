import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { PathRejectedError, resolveInRepo, splitLines, type RepoScope } from '../../agent/tools/repo-tools.js';
import { Classification, EvidenceSource, LineRange, RequirementId, ScriptTestId } from '../../shared/schemas.js';
import type { Prd } from '../../shared/schemas.js';

/** One diagnosis as the model submits it: everything but id, toolCalls and durationMs, which code fills. */
export const DiagnosisDraft = z.strictObject({
  testCaseIds: z.array(ScriptTestId).min(1).describe('The failing tests this diagnosis explains'),
  classification: Classification.describe(
    'app_defect: the app contradicts a requirement; environment_issue: configuration, infrastructure or missing data; test_defect: the test itself is wrong; inconclusive: not enough evidence',
  ),
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1).max(300).describe('One sentence: what is wrong'),
  rootCause: z.string().min(1).max(2000).describe('Why it happens, in the code or the environment'),
  location: z
    .strictObject({
      file: z.string().min(1).describe('Path relative to the repo root, as the repo tools show it'),
      lines: LineRange.describe('[start, end], 1-based, inclusive'),
    })
    .nullable()
    .describe('Where the fault is in the app source. Required for app_defect; null when there is no single place'),
  evidence: z
    .array(z.strictObject({ source: EvidenceSource, detail: z.string().min(1).max(1000) }))
    .min(1)
    .describe('What you observed, one item per source'),
  violatedRequirementIds: z.array(RequirementId).describe('Requirements the behaviour contradicts (may be empty)'),
  suggestedFix: z
    .strictObject({ description: z.string().min(1).max(2000), patch: z.string().max(20_000).optional().describe('Optional unified diff; never applied') })
    .nullable(),
});

export const SubmitDiagnoses = z.strictObject({
  diagnoses: z.array(DiagnosisDraft).min(1),
});

export type DiagnosisDraft = z.infer<typeof DiagnosisDraft>;
export type SubmitDiagnoses = z.infer<typeof SubmitDiagnoses>;

export interface CheckContext {
  /** The tests of the group this session diagnoses. */
  groupTestIds: readonly string[];
  /** The source tree of the executed version, as the repo tools see it. */
  scope: RepoScope;
  prd: Prd;
}

/** Problems with a location, or [] when the file exists, is readable by the repo tools and has those lines. */
async function locationProblems(prefix: string, location: { file: string; lines: [number, number] }, scope: RepoScope): Promise<string[]> {
  let abs: string;
  try {
    ({ abs } = await resolveInRepo(scope, location.file));
  } catch (err) {
    if (err instanceof PathRejectedError) return [`${prefix}: location.file: ${err.message} Use a file path as the repo tools show it.`];
    throw err;
  }
  const text = await readFile(abs, 'utf8').catch(() => null);
  if (text === null) return [`${prefix}: location.file "${location.file}" is not a readable file.`];
  const count = splitLines(text).length;
  if (location.lines[1] > count) return [`${prefix}: location.lines ${JSON.stringify(location.lines)} go past the end of ${location.file} (${count} lines).`];
  return [];
}

/**
 * Code checks on a submit (SPEC §8.1 step 3): every test of the group is in exactly one diagnosis and no
 * other test is named; an app_defect has a location; every location exists in the source tree; the
 * violated requirements exist. Returns problems for the model, [] when the submit is accepted.
 */
export async function checkDiagnoses(submit: SubmitDiagnoses, ctx: CheckContext): Promise<string[]> {
  const problems: string[] = [];
  const group = new Set(ctx.groupTestIds);
  const seen = new Map<string, number>();
  const requirementIds = new Set(ctx.prd.requirements.map((r) => r.id));

  for (const [i, d] of submit.diagnoses.entries()) {
    const prefix = `diagnoses[${i}]`;
    for (const id of d.testCaseIds) {
      if (!group.has(id)) problems.push(`${prefix}: ${id} is not one of the tests you are diagnosing (${ctx.groupTestIds.join(', ')}).`);
      seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    if (d.classification === 'app_defect' && d.location === null) problems.push(`${prefix}: an app_defect needs a location (file and lines in the app source).`);
    if (d.location) problems.push(...(await locationProblems(prefix, d.location, ctx.scope)));
    const unknown = d.violatedRequirementIds.filter((id) => !requirementIds.has(id));
    if (unknown.length > 0) problems.push(`${prefix}: unknown requirement ids ${unknown.join(', ')}.`);
  }
  const missing = ctx.groupTestIds.filter((id) => !seen.has(id));
  if (missing.length > 0) problems.push(`Every test must be in exactly one diagnosis; missing: ${missing.join(', ')}.`);
  const twice = [...seen].filter(([id, n]) => n > 1 && group.has(id)).map(([id]) => id);
  if (twice.length > 0) problems.push(`Every test must be in exactly one diagnosis; in more than one: ${twice.join(', ')}.`);
  return problems;
}
