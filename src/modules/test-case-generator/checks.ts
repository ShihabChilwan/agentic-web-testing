import { z } from 'zod';
import {
  Expectation,
  MAX_TEST_CASES,
  MAX_TEST_CASES_PER_REQUIREMENT,
  TestCase,
  UncoveredReasonKind,
  UncoveredRequirement,
} from '../../shared/schemas.js';
import type { PrdRequirement, TestCase as TestCaseType } from '../../shared/schemas.js';

/**
 * A test case as the model writes it. Code fills in everything derivable: the test case id (after every
 * session has finished), the expectation ids E1, E2, ... in order, and a missing title (from the first
 * expectation; the model often leaves it out). Empty lists may be left out.
 */
export const TestCaseDraft = TestCase.omit({ id: true, title: true, expected: true, preconditions: true, fixturesUsed: true }).extend({
  title: z.string().min(1).optional(),
  preconditions: z.array(z.string()).default([]),
  fixturesUsed: z.array(z.string()).default([]),
  expected: z.array(Expectation.omit({ id: true })).min(1),
});
export type TestCaseDraft = z.infer<typeof TestCaseDraft>;

/** The final test case: the given id, and expectation ids numbered in order. */
export function toTestCase(draft: TestCaseDraft, id: string): TestCaseType {
  const { title, ...rest } = draft;
  const fallback = draft.expected[0]!.description;
  return {
    id,
    title: title ?? (fallback.length > 80 ? `${fallback.slice(0, 79)}…` : fallback),
    ...rest,
    expected: draft.expected.map((e, i) => ({ id: `E${i + 1}`, ...e })),
  };
}

export const SubmitTestCases = z.object({
  testCases: z.array(TestCaseDraft).max(MAX_TEST_CASES),
  // Strict for the model: it must choose a reasonKind (the file schema only defaults it for older files).
  declined: z.array(UncoveredRequirement.extend({ reasonKind: UncoveredReasonKind })).describe('Requirements you cannot test, each with a reason'),
});
export type SubmitTestCases = z.infer<typeof SubmitTestCases>;

const NEGATIVE_CATEGORIES = new Set(['error-handling', 'boundary', 'auth']);
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a value appears in the grounding text. Numbers match as a whole number (400 matches
 * `status(400)`, not 4000); strings match verbatim and not inside a longer word; booleans match
 * `true` / `false` as words.
 */
export function isGrounded(value: string | number | boolean, text: string): boolean {
  if (typeof value === 'number') {
    return new RegExp(`(?<![\\d.])${escapeRegex(String(value))}(?![\\d]|\\.\\d)`).test(text);
  }
  const s = String(value);
  if (s.length === 0) return false;
  const before = /^\w/.test(s) ? '(?<!\\w)' : '';
  const after = /\w$/.test(s) ? '(?!\\w)' : '';
  return new RegExp(`${before}${escapeRegex(s)}${after}`).test(text);
}

/**
 * Where an expected value may come from. `code` holds the inserted evidence and imported files,
 * fixture values, API prefix and base URLs. From facts observed on golden only status codes and
 * string values count: booleans and plain numbers in response bodies are too common to vouch for
 * anything (they would accept `true` for "is visible", or any small count).
 */
export interface Grounding {
  code: string;
  factStatuses: number[];
  factStrings: string[];
}

export function isGroundedIn(value: string | number | boolean, g: Grounding): boolean {
  if (isGrounded(value, g.code)) return true;
  if (typeof value === 'number') return g.factStatuses.includes(value);
  if (typeof value === 'string') return g.factStrings.some((s) => isGrounded(value, s));
  return false;
}

/** True when a dot path such as `users.alice` exists in the fixtures. */
export function fixtureExists(fixtures: unknown, dotPath: string): boolean {
  let current: unknown = fixtures;
  for (const key of dotPath.split('.')) {
    if (current === null || typeof current !== 'object' || !(key in current)) return false;
    current = (current as Record<string, unknown>)[key];
  }
  return true;
}

export interface CheckContext {
  /** The requirements of this session (one feature, or its gap-round subset). */
  requirements: PrdRequirement[];
  fixtures: unknown;
  /** Where expected values may come from (see Grounding). */
  grounding: Grounding;
  quota: number;
}

/** Code checks on one submission. Each problem says what to change. */
export function checkSubmission(sub: SubmitTestCases, ctx: CheckContext): string[] {
  const problems: string[] = [];
  const byId = new Map(ctx.requirements.map((r) => [r.id, r]));
  const perRequirement = new Map<string, number>();

  if (sub.testCases.length > ctx.quota) {
    problems.push(`${sub.testCases.length} test cases is more than the limit of ${ctx.quota}; keep the most important ones`);
  }

  sub.testCases.forEach((tc, i) => {
    const label = `testCases[${i}]`;
    for (const id of tc.requirementIds) {
      const req = byId.get(id);
      if (!req) {
        problems.push(`${label}.requirementIds: ${id} is not one of the requirements given in this task`);
        continue;
      }
      perRequirement.set(id, (perRequirement.get(id) ?? 0) + 1);
      if (req.layer === 'api' && tc.layer !== 'api') problems.push(`${label}: ${id} is an api requirement, so the test case must have layer "api"`);
      if (req.layer === 'ui' && tc.layer !== 'ui') problems.push(`${label}: ${id} is a ui requirement, so the test case must have layer "ui"`);
      if (req.layer === 'e2e' && (tc.layer !== 'ui' || tc.category !== 'e2e-journey')) {
        problems.push(
          `${label}: ${id} is an e2e requirement: cover it with a test case with layer "ui" and category "e2e-journey" that goes through the pages; an API-only test belongs under a related api requirement instead`,
        );
      }
    }
    const layers = new Set(tc.requirementIds.map((id) => byId.get(id)?.layer).filter((l) => l !== undefined));
    if (layers.size > 1) {
      problems.push(`${label}: it combines requirements of different layers (${[...layers].join(', ')}); write a separate test case for each`);
    }
    for (const f of tc.fixturesUsed) {
      if (!fixtureExists(ctx.fixtures, f)) problems.push(`${label}.fixturesUsed: ${f} is not in the fixtures; use only the fixture paths listed`);
    }
    tc.expected.forEach((e, j) => {
      const where = `${label}.expected[${j}].value`;
      if (e.value === undefined || isGroundedIn(e.value, ctx.grounding)) return;
      if (e.value === '') problems.push(`${where} is empty; leave value out and keep the description`);
      else if (typeof e.value === 'boolean') {
        problems.push(
          `${where} ${e.value} is not a literal in the code you were given; for checks like "is visible" or "is shown", leave value out (the description says what to check)`,
        );
      } else {
        problems.push(
          `${where} ${JSON.stringify(e.value)} is not found in the code, fixtures or observed facts you were given; remove the value (keep the description) or use the exact text`,
        );
      }
    });
  });

  for (const [id, n] of perRequirement) {
    if (n > MAX_TEST_CASES_PER_REQUIREMENT) problems.push(`${id} has ${n} test cases; at most ${MAX_TEST_CASES_PER_REQUIREMENT}`);
  }
  // A decline for a requirement that also has test cases is not a mistake: it records the part that
  // cannot be tested (e.g. an email-only happy path). Code keeps it as a partial decline (coverage.partial).
  const declined = new Set<string>();
  sub.declined.forEach((d, i) => {
    if (!byId.has(d.requirementId)) problems.push(`declined[${i}]: ${d.requirementId} is not one of the requirements given in this task`);
    if (declined.has(d.requirementId)) problems.push(`declined[${i}]: ${d.requirementId} is declined twice`);
    declined.add(d.requirementId);
  });
  return problems;
}

/** High-priority requirements whose test cases include no error-handling, boundary or auth case. */
export function missingNegativeCases(requirements: PrdRequirement[], cases: TestCaseDraft[]): string[] {
  return requirements
    .filter((r) => r.priority === 'high')
    .filter((r) => {
      const own = cases.filter((c) => c.requirementIds.includes(r.id));
      return own.length > 0 && !own.some((c) => NEGATIVE_CATEGORIES.has(c.category));
    })
    .map((r) => `${r.id} (high priority) has no negative test case (error-handling, boundary or auth)`);
}
