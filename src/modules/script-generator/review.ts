import path from 'node:path';
import { z } from 'zod';
import { runAgent } from '../../agent/runtime.js';
import { createRepoTools, isHidden, type RepoScope } from '../../agent/tools/repo-tools.js';
import { AgentBudgetError, AgentSubmitError } from '../../agent/types.js';
import type { LLMClient } from '../../llm/types.js';
import type { LLMConfig } from '../../shared/config.js';
import { errorSummary } from '../../shared/run-manifest.js';
import { readFile } from 'node:fs/promises';
import { HumanVerdicts } from '../../shared/schemas.js';
import type { PrdRequirement, ScriptManifestEntry, ScriptReview, StageScriptsSummary, TestCase } from '../../shared/schemas.js';
import type { ReadLines } from '../test-case-generator/context.js';
import { stripAnsi } from './classify.js';
import { failureContext } from './dry-run.js';
import { messageValue } from './suspected.js';

/** Reviews one script may get: another one only when it fails on an expectation no earlier review looked at. */
export const MAX_REVIEWS = 3;
/** Exploring tool calls a review may make (read_file, search_code, list_files). */
const REVIEW_TOOL_CALLS = 10;
/** A citation covers at most this many lines, so it points at the code rather than a whole file. */
const MAX_CITED_LINES = 40;

const Value = z.union([z.string(), z.number(), z.boolean()]);

export const SubmitReview = z.object({
  verdict: z
    .enum(['keep', 'test_case_wrong', 'script_wrong'])
    .describe('keep: the application may be wrong or it is unclear; test_case_wrong: the expectation is wrong; script_wrong: the expectation is right, the script checked the wrong thing or at the wrong time'),
  explanation: z.string().min(1).describe('Why, with what you found in the code; for script_wrong, what the script must check instead and how'),
  citation: z
    .object({ file: z.string().min(1), lines: z.tuple([z.number().int().min(1), z.number().int().min(1)]) })
    .optional()
    .describe('test_case_wrong only: the application code (repo-relative path and line range) that produces the received value on purpose'),
  change: z
    .object({
      kind: z.enum(['value', 'remove']).describe('value: the expectation gets the value the correct version showed; remove: the expectation cannot hold and is dropped'),
      value: Value.optional().describe('kind value: the new value; the received value, or for text the part of it that the cited code produces'),
      description: z.string().min(1).optional().describe('kind value: a new description, when the old one no longer fits'),
    })
    .optional()
    .describe('test_case_wrong only: the change to the failing expectation'),
});
export type SubmitReview = z.infer<typeof SubmitReview>;

/** What Playwright printed after "Received:", as a value: a JSON string, a number or a boolean; null otherwise. */
export function receivedValue(raw: string | null): string | number | boolean | null {
  if (raw === null) return null;
  if (/^"/.test(raw)) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return null;
    }
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw === 'true' || raw === 'false') return raw === 'true';
  return null;
}

const normalise = (s: string) => s.replace(/\s+/g, ' ').trim();

export interface ReviewCheckContext {
  tc: TestCase;
  expectationId: string;
  /** The value the correct version gave (null when Playwright printed something that is not a single value). */
  received: string | number | boolean | null;
  read: ReadLines;
  scope: RepoScope;
}

/**
 * Code checks on a review (SPEC §6.2). A test case is blamed only with a citation of application code that exists at
 * the generation commit; a new value must be what the correct version gave (all of it, or for text a part of it),
 * and a text value must also appear in the cited lines. Only the failing expectation changes, and one must remain.
 */
export async function reviewProblems(sub: SubmitReview, ctx: ReviewCheckContext): Promise<string[]> {
  if (sub.verdict === 'keep') return [];
  if (sub.verdict === 'script_wrong') {
    return sub.explanation.trim().length < 20 ? ['explanation: for script_wrong, say what the script must check instead and how (it is passed to the script writer)'] : [];
  }
  const problems: string[] = [];
  const { citation, change } = sub;
  let cited: string | null = null;
  if (!citation) problems.push('citation: test_case_wrong needs the application code (file and lines) that produces the received value on purpose');
  else {
    const [from, to] = citation.lines;
    const lines = isHidden(citation.file, ctx.scope) ? null : await ctx.read(citation.file);
    if (!lines) problems.push(`citation: ${citation.file} cannot be read at the generation version; give a repo-relative path of an application file`);
    else if (from > to || to > lines.length) problems.push(`citation: lines ${from}-${to} go past the end of ${citation.file} (${lines.length} lines)`);
    else if (to - from + 1 > MAX_CITED_LINES) problems.push(`citation: cite at most ${MAX_CITED_LINES} lines, the code that produces the value`);
    else cited = normalise(lines.slice(from - 1, to).join('\n'));
  }
  const expectation = ctx.tc.expected.find((e) => e.id === ctx.expectationId)!;
  if (!change) problems.push(`change: test_case_wrong needs the change to ${ctx.expectationId}: kind "value" with the new value, or kind "remove"`);
  else if (change.kind === 'remove') {
    if (ctx.tc.expected.length < 2) problems.push(`change: ${ctx.expectationId} is the only expectation; it cannot be removed (keep the verdict "keep" or choose "value")`);
  } else if (change.value === undefined) problems.push('change.value: kind "value" needs the new value');
  else if (ctx.received === null) {
    problems.push(`change.value: the correct version's result for ${ctx.expectationId} is not a single value, so it cannot become the expectation; use kind "remove", or another verdict`);
  } else if (typeof change.value !== typeof ctx.received) {
    problems.push(`change.value: the correct version gave the ${typeof ctx.received} ${JSON.stringify(ctx.received)}; the new value must be of that kind`);
  } else if (typeof change.value === 'string') {
    const wanted = normalise(change.value);
    if (wanted === '' || !normalise(String(ctx.received)).includes(wanted)) {
      problems.push(`change.value: ${JSON.stringify(change.value)} is not what the correct version showed (${JSON.stringify(ctx.received)}); use that text or the part of it the cited code produces`);
    } else if (cited !== null && !cited.includes(wanted)) {
      problems.push(`change.value: ${JSON.stringify(change.value)} does not appear in the cited lines ${citation!.file}:${citation!.lines[0]}-${citation!.lines[1]}; cite the code that contains this text`);
    } else if (change.value === expectation.value) problems.push('change.value: that is the current value');
  } else if (change.value !== ctx.received) {
    problems.push(`change.value: the correct version gave ${JSON.stringify(ctx.received)}; a ${typeof ctx.received} must be exactly that`);
  }
  return problems;
}

/** The attempt whose result stands (the kept one, else the last) and the expectation it failed on. */
export function failingExpectation(entry: ScriptManifestEntry): { attempt: ScriptManifestEntry['attemptLog'][number]; expectationId: string | null } {
  const kept = entry.keptAttempt === undefined ? undefined : entry.attemptLog.find((a) => a.attempt === entry.keptAttempt);
  const attempt = kept ?? entry.attemptLog.at(-1)!;
  const expectationId = /^Error: (E\d+)\s*$/m.exec(stripAnsi(attempt.error ?? '').split('\n')[0] ?? '')?.[1] ?? null;
  return { attempt, expectationId };
}

/**
 * Whether a script whose locked value differed gets a review now (SPEC §6.2): it has none yet, or it fails on an
 * expectation that no earlier review looked at, with fewer than MAX_REVIEWS reviews so far. A review written before the
 * expectation was recorded counts by its case's revision when it revised one, and otherwise as having seen the
 * current failure.
 */
export function needsReview(entry: ScriptManifestEntry, tc: TestCase): boolean {
  if (entry.validationOutcome !== 'assertion_failed') return false;
  const reviews = [...(entry.earlierReviews ?? []), ...(entry.review ? [entry.review] : [])];
  if (reviews.length === 0) return true;
  if (reviews.length >= MAX_REVIEWS) return false;
  const failing = failingExpectation(entry).expectationId;
  if (failing === null) return false;
  const revisions = [...(tc.earlierRevisions ?? []), ...(tc.revision ? [tc.revision] : [])];
  const seen = reviews.map((r) => r.expectationId ?? (r.verdict === 'test_case_wrong' ? revisions.at(-1)?.expectationId : failing));
  return !seen.includes(failing);
}

/** The test case with the reviewed expectation changed and the revision recorded (SPEC §5); an earlier revision is kept. */
export function reviseTestCase(tc: TestCase, sub: SubmitReview, expectationId: string, now: Date = new Date()): TestCase {
  const old = tc.expected.find((e) => e.id === expectationId)!;
  const from = { description: old.description, ...(old.value !== undefined ? { value: old.value } : {}) };
  const earlier = tc.revision ? { earlierRevisions: [...(tc.earlierRevisions ?? []), tc.revision] } : {};
  if (sub.change!.kind === 'remove') {
    return {
      ...tc,
      ...earlier,
      expected: tc.expected.filter((e) => e.id !== expectationId),
      revision: { expectationId, change: 'remove', from, to: null, citation: sub.citation!, explanation: sub.explanation, revisedAt: now.toISOString() },
    };
  }
  const updated = { ...old, value: sub.change!.value!, description: sub.change!.description ?? old.description };
  return {
    ...tc,
    ...earlier,
    expected: tc.expected.map((e) => (e.id === expectationId ? updated : e)),
    revision: {
      expectationId,
      change: 'value',
      from,
      to: { description: updated.description, value: updated.value },
      citation: sub.citation!,
      explanation: sub.explanation,
      revisedAt: now.toISOString(),
    },
  };
}

/** Every expectation a review removed, from the test cases' revisions (current and earlier), for a person to check. */
export function removedExpectations(cases: readonly TestCase[]): StageScriptsSummary['removedExpectations'] {
  return cases.flatMap((tc) =>
    [...(tc.earlierRevisions ?? []), ...(tc.revision ? [tc.revision] : [])]
      .filter((r) => r.change === 'remove')
      .map((r) => ({ testCaseId: tc.id, expectationId: r.expectationId, description: r.from.description, citation: r.citation, explanation: r.explanation })),
  );
}

/** runs/<runId>/verdicts.json: decisions a person made on reviewed scripts (SPEC §6.2); empty without the file. */
export async function readHumanVerdicts(file: string): Promise<HumanVerdicts> {
  const raw = await readFile(file, 'utf8').catch(() => null);
  if (raw === null) return {};
  const parsed = HumanVerdicts.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`${file} is not valid (${first?.path.join('.')}: ${first?.message}); it maps a test case id to { "verdict": "script_wrong" | "keep", "explanation": at least 20 characters }`);
  }
  return parsed.data;
}

/** The review record of a person's decision. */
export function humanReview(verdict: 'script_wrong' | 'keep', explanation: string, expectationId: string | null, now: Date = new Date()): ScriptReview {
  return { verdict, decidedBy: 'human', explanation, ...(expectationId ? { expectationId } : {}), reviewedAt: now.toISOString() };
}

export function buildReviewSystemPrompt(): string {
  return `You review an automated test whose locked expectation disagrees with the correct version of a web application. The application under test is the version the tests are written for, so a disagreement means one of three things, and you decide which with evidence from the code. Submit your verdict with submit_review.

## Verdicts
- test_case_wrong: the expectation is wrong. The application produces the received value on purpose: you can point to the code that does it (a message string, a default value, a validation that runs first, another branch for this input). Give that code as citation (repo-relative file and line range, at most ${MAX_CITED_LINES} lines) and the change: kind "value" with the value the correct version showed (for text, the part of it that the cited code produces; it must appear in the cited lines), with a new description when the old one no longer fits; or kind "remove" when the expectation cannot hold at all.
- script_wrong: the expectation is right, but the script checked the wrong thing (another field, another response, another element) or at the wrong time (a short-lived message gone before it was checked). The script is written again with your explanation, so say exactly what it must check and how.
- keep: the application may be wrong, or you cannot tell. Use it whenever the code does not clearly show that the received value is intended. Never blame the test case to make a test pass.

## How to work
- Read the failure, the test case and the script first; then read the code that handles this request or renders this page (read_file, search_code). Confirm a file and its lines with read_file before citing them.
- Compare with the requirement: an expectation that follows the requirement while the code does something else is a reason to keep, not to blame the test.`;
}

export interface ReviewTaskInput {
  tc: TestCase;
  requirements: PrdRequirement[];
  expectationId: string;
  message: string;
  received: string | null;
  context: { pageSnapshot?: string; dom?: string; lastResponse?: string };
  script: string;
  /** The settings the application runs with (renderSettings), or null. */
  settings?: string | null;
}

export function buildReviewTask(input: ReviewTaskInput): string {
  const { tc } = input;
  const expectation = tc.expected.find((e) => e.id === input.expectationId);
  const parts = [
    `Review ${tc.id}: its expectation ${input.expectationId} disagrees with the correct version.`,
    `## Test case\n${JSON.stringify({ title: tc.title, layer: tc.layer, steps: tc.steps, expected: tc.expected }, null, 2)}`,
    `## Requirement\n${input.requirements.map((r) => `- ${r.id}: ${r.statement}\n${r.acceptanceCriteria.map((c) => `   - ${c.text} (evidence: ${c.evidence.map((e) => `${e.file}:${e.lines[0]}-${e.lines[1]}`).join(', ')})`).join('\n')}`).join('\n')}`,
    `## The failure\n${input.expectationId} "${expectation?.description ?? ''}" is locked to ${JSON.stringify(expectation?.value)}; the correct version gave ${input.received ?? '(not a single value, see the message)'}.\n\`\`\`\n${stripAnsi(input.message).split('\n').slice(0, 30).join('\n')}\n\`\`\``,
    `## The script\n\`\`\`ts\n${input.script}\n\`\`\``,
  ];
  if (input.settings) parts.push(`## Settings\n${input.settings} A requirement or test written from the code's default may not hold under them.`);
  if (input.context.lastResponse) parts.push(`## Last API response\n${input.context.lastResponse}`);
  if (input.context.pageSnapshot) parts.push(`## The page when the check failed (accessibility tree)\n\`\`\`yaml\n${input.context.pageSnapshot.slice(0, 6_000)}\n\`\`\``);
  parts.push('Investigate the code, then call submit_review.');
  return parts.join('\n\n');
}

export interface ReviewDeps {
  llm: LLMClient;
  llmConfig: LLMConfig;
  transcriptsDir: string;
  read: ReadLines;
  scope: RepoScope;
  runDir: string;
  requirements: (tc: TestCase) => PrdRequirement[];
  readScript: (tc: TestCase) => Promise<string>;
  /** The settings the application runs with (renderSettings), shown to the reviewer. */
  settings?: string | null;
}

export interface ReviewOutcome {
  review: ScriptReview;
  /** test_case_wrong: the revised test case. */
  revised?: TestCase;
}

/**
 * Reviews one script whose locked value differed on the generation version (SPEC §6.2): one agent session with the
 * read-only repo tools at the generation version. A session that ends without an accepted verdict keeps the result.
 */
export async function reviewSuspected(tc: TestCase, entry: ScriptManifestEntry, deps: ReviewDeps, now: () => Date = () => new Date()): Promise<ReviewOutcome> {
  const { attempt, expectationId } = failingExpectation(entry);
  const message = stripAnsi(attempt.error ?? '');
  if (!expectationId || !tc.expected.some((e) => e.id === expectationId)) {
    return { review: { verdict: 'failed', explanation: 'The failing expectation could not be read from the recorded error', reviewedAt: now().toISOString() } };
  }
  const rawReceived = messageValue(message, 'Received');
  const received = receivedValue(rawReceived);
  const context = await failureContext(path.join(deps.runDir, 'dry-runs', tc.id, `attempt-${attempt.attempt}`));
  try {
    const result = await runAgent(
      {
        purpose: 'review',
        system: buildReviewSystemPrompt(),
        task: buildReviewTask({ tc, requirements: deps.requirements(tc), expectationId, message, received: rawReceived, context, script: await deps.readScript(tc), settings: deps.settings ?? null }),
        tools: createRepoTools(deps.scope),
        submit: {
          name: 'submit_review',
          description: 'Submit your verdict on the disagreement.',
          schema: SubmitReview,
          validate: (sub) => reviewProblems(sub, { tc, expectationId, received, read: deps.read, scope: deps.scope }),
        },
        budget: { maxToolCalls: REVIEW_TOOL_CALLS },
      },
      { llm: deps.llm, contextTokens: deps.llmConfig.contextTokens, transcriptDir: deps.transcriptsDir },
    );
    const sub = result.output;
    const review: ScriptReview = {
      verdict: sub.verdict,
      expectationId,
      explanation: sub.explanation,
      ...(sub.verdict === 'test_case_wrong' && sub.citation ? { citation: { file: sub.citation.file, lines: sub.citation.lines } } : {}),
      reviewedAt: now().toISOString(),
    };
    return sub.verdict === 'test_case_wrong' ? { review, revised: reviseTestCase(tc, sub, expectationId, now()) } : { review };
  } catch (err) {
    if (!(err instanceof AgentSubmitError || err instanceof AgentBudgetError)) throw err;
    return { review: { verdict: 'failed', expectationId, explanation: errorSummary(err), reviewedAt: now().toISOString() } };
  }
}
