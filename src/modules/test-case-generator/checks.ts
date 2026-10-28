import { z } from 'zod';
import {
  Expectation,
  MAX_TEST_CASES,
  MAX_TEST_CASES_PER_REQUIREMENT,
  TestCase,
  UncoveredReasonKind,
  UncoveredRequirement,
} from '../../shared/schemas.js';
import type { Prd, PrdRequirement, TestCase as TestCaseType } from '../../shared/schemas.js';
import { isParam, templateMatches, textPaths } from '../../shared/route-paths.js';

export { templateMatches };

/**
 * A test case as the model writes it. Code fills in everything derivable: the test case id (after every
 * session has finished), the expectation ids E1, E2, ... in order, and a missing title (from the first
 * expectation; the model often leaves it out). Empty lists may be left out.
 */
export const TestCaseDraft = TestCase.omit({ id: true, title: true, expected: true, preconditions: true, fixturesUsed: true, revision: true, earlierRevisions: true }).extend({
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
/** Long journeys rarely survive the script fix loop (SPEC §5, §12): one of 11 did in the first real run. */
export const MAX_JOURNEY_STEPS = 8;
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

/** True when a dot path such as `users.<name>` exists in the fixtures. */
export function fixtureExists(fixtures: unknown, dotPath: string): boolean {
  let current: unknown = fixtures;
  for (const key of dotPath.split('.')) {
    if (current === null || typeof current !== 'object' || !(key in current)) return false;
    current = (current as Record<string, unknown>)[key];
  }
  return true;
}

/** What the API check rules need (SPEC §5): the PRD's endpoints, the API prefix and the login request. */
export interface ApiRules {
  endpoints: Prd['apiEndpoints'];
  /** e.g. "/api"; a resource is the prefix plus the next path segment. */
  apiPrefix: string;
  /** The target's login request: logging in is a setup step, not a write under test. */
  loginPath?: string;
  /**
   * Resources whose writes change an account (the target config's accountResources); the login request's own
   * resource always is one. Only after a write to one of these does a later login count as reading it back.
   */
  accountResources?: string[];
}

export interface CheckContext {
  /** The requirements of this session (one feature, or its gap-round subset). */
  requirements: PrdRequirement[];
  fixtures: unknown;
  /** Where expected values may come from (see Grounding). */
  grounding: Grounding;
  quota: number;
  /** When set, the API rules (read back after a write, more than a status, found and not found) apply. */
  api?: ApiRules;
  /** The PRD's page routes: a ui test case must name the page it opens by one of these paths (SPEC §5). */
  pages?: string[];
}

export interface StepRequest {
  /** 0-based index into steps. */
  step: number;
  method: string;
  /** Without query string. */
  path: string;
}

const STEP_REQUEST = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s"'`,;)]*)/g;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The HTTP requests a case's steps name ("Send POST /api/items …"), in order. */
export function stepRequests(steps: readonly string[]): StepRequest[] {
  return steps.flatMap((text, step) =>
    [...text.matchAll(STEP_REQUEST)].map((m) => ({ step, method: m[1]!, path: m[2]!.split('?')[0]!.replace(/[.:]+$/, '') })),
  );
}

/** The PRD endpoint a step's request goes to: method and path match, parameters match any one segment; the most literal match wins. */
export function matchEndpoint(method: string, path: string, endpoints: Prd['apiEndpoints']): Prd['apiEndpoints'][number] | undefined {
  const matches = endpoints.filter((e) => e.method === method && templateMatches(e.path, path));
  const literal = (e: Prd['apiEndpoints'][number]) => e.path.split('/').filter((t) => t && !isParam(t)).length;
  return matches.sort((a, b) => literal(b) - literal(a))[0];
}

/** The resource a path belongs to: the API prefix plus the next segment ("/api/items/42" → "/api/items"). */
export function resourceOf(path: string, apiPrefix: string): string {
  const prefix = apiPrefix.replace(/\/+$/, '');
  const rest = path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : path;
  const first = rest.split('/').filter(Boolean)[0] ?? '';
  return `${prefix}/${first}`;
}

/** Paths a step names (see textPaths). */
export const stepPaths = (steps: readonly string[]): string[] => textPaths(steps);

/** Page routes a test case can be asked to open: a catch-all route ("*") cannot be. */
export const openablePages = (pages: readonly string[]) => pages.filter((p) => !p.includes('*'));

/** The PRD pages a ui test case's steps open (named by path). */
export function pagesOpened(steps: readonly string[], pages: readonly string[]): string[] {
  const paths = stepPaths(steps);
  return openablePages(pages).filter((page) => paths.some((p) => templateMatches(page, p)));
}

const isStatusCode = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599;
/**
 * An expectation that only checks the response's status code (a status value, or no value and a description about
 * the status). A read-back expectation checks the resulting data even when it is a status (an item gone is a 404).
 */
const isStatusExpectation = (e: { description: string; value?: unknown; readBack?: boolean }) =>
  e.readBack !== true &&
  (isStatusCode(e.value) || (e.value === undefined && /\bstatus\b/i.test(e.description) && !/\b(body|field|message|contains?|returns? (?:the|a|an))\b/i.test(e.description)));

/**
 * The API rules for one submission (SPEC §5): a case whose action writes data reads it back afterwards (unless the
 * PRD has no read endpoint for that resource); a case expecting success checks more than the status; a case that
 * reads a missing item (404) has a partner that reads an existing one, unless its requirement is declined in part.
 */
export function apiRuleProblems(sub: SubmitTestCases, rules: ApiRules): string[] {
  const problems: string[] = [];
  const declined = new Set(sub.declined.map((d) => d.requirementId));
  const reads = (tc: TestCaseDraft) => stepRequests(tc.steps).filter((r) => r.method === 'GET');
  const successReads = new Set<string>();
  // A "found" partner: a case that reads the endpoint, expects success and no 404 (a delete-then-read case is not one).
  for (const tc of sub.testCases) {
    if (tc.layer !== 'api' || tc.expected.some((e) => e.value === 404)) continue;
    if (!tc.expected.some((e) => typeof e.value === 'number' && e.value >= 200 && e.value < 300)) continue;
    for (const r of reads(tc)) {
      const endpoint = matchEndpoint('GET', r.path, rules.endpoints);
      if (endpoint) successReads.add(endpoint.path);
    }
  }
  sub.testCases.forEach((tc, i) => {
    if (tc.layer !== 'api') return;
    const label = `testCases[${i}]`;
    const all = stepRequests(tc.steps);
    const isLogin = (r: StepRequest) => rules.loginPath !== undefined && r.path === rules.loginPath;
    // Logging in is setup, not a write under test; after a write it reads the account's state back.
    const lastWrite = all.filter((r) => WRITE_METHODS.has(r.method) && !isLogin(r)).at(-1);
    if (lastWrite) {
      const resource = resourceOf(lastWrite.path, rules.apiPrefix);
      const readable = rules.endpoints.some((e) => e.method === 'GET' && resourceOf(e.path, rules.apiPrefix) === resource);
      const accounts = [...(rules.loginPath ? [rules.loginPath] : []), ...(rules.accountResources ?? [])].map((p) => resourceOf(p, rules.apiPrefix));
      const accountWrite = accounts.includes(resource);
      // Logging in reads back only what a write changed about an account (registration, password, email).
      const readAfter = all.some((r) => r.step > lastWrite.step && (r.method === 'GET' || (accountWrite && isLogin(r))));
      const write = `its last write (${lastWrite.method} ${lastWrite.path}, step ${lastWrite.step + 1})`;
      const what = 'the new values after a create or update, the item gone after a delete, nothing changed after a rejected request';
      if (readable && !readAfter) {
        problems.push(
          `${label}: ${write} is not followed by a read. Add a step that reads the data back with a GET request from the endpoint list${accountWrite && rules.loginPath ? ' (or, since it changes an account, the login request)' : ''}, and an expectation with "readBack": true for what it returns: ${what}`,
        );
      } else if (readAfter && !tc.expected.some((e) => e.readBack === true)) {
        problems.push(`${label}: ${write} is read back, but no expectation checks the read; add one with "readBack": true for what it returns: ${what}`);
      }
    }
    if (tc.expected.some((e) => typeof e.value === 'number' && e.value >= 200 && e.value < 300) && tc.expected.every(isStatusExpectation)) {
      problems.push(
        `${label}: it expects a success status but checks nothing else; add at least one expectation about the response body or the data read back (a field value, the created item, a message)`,
      );
    }
    if (tc.expected.some((e) => e.value === 404) && !tc.requirementIds.some((id) => declined.has(id))) {
      for (const r of reads(tc)) {
        const endpoint = matchEndpoint('GET', r.path, rules.endpoints);
        if (!endpoint || !endpoint.path.split('/').some(isParam) || successReads.has(endpoint.path)) continue;
        problems.push(
          `${label}: it reads GET ${endpoint.path} only for an item that does not exist (404). Add a test case that reads an existing one (create it first if the fixtures and facts have none) and checks the success status and its data; if that cannot work, say why in declined for the requirement`,
        );
        break;
      }
    }
  });
  return problems;
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
    if (tc.category === 'e2e-journey' && tc.steps.length > MAX_JOURNEY_STEPS) {
      problems.push(
        `${label}: an e2e journey has ${tc.steps.length} steps (at most ${MAX_JOURNEY_STEPS}); split it into shorter journeys, or prepare data in fewer steps through the API, and check what each page shows after you move to it`,
      );
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
  if (ctx.api) problems.push(...apiRuleProblems(sub, ctx.api));
  const pages = openablePages(ctx.pages ?? []);
  if (pages.length > 0) {
    sub.testCases.forEach((tc, i) => {
      if (tc.layer !== 'ui' || pagesOpened(tc.steps, pages).length > 0) return;
      problems.push(
        `testCases[${i}]: a ui test case names the page it opens by its path from the page list, e.g. "Open ${pages[0]}"; none of its steps names one of the pages listed`,
      );
    });
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

/** A line that rejects text that is empty or only spaces: a trim check (`!x.trim()`, `x.trim() === ''`, `x.trim().length < 1`). */
const BLANK_CHECK = /!\s*[\w$.?]+\.trim\(\)|\.trim\(\)\s*(?:===?|!==?)\s*(?:''|""|``)|\.trim\(\)\.length\s*(?:===?|!==?|<|<=|>)\s*[01]\b/;
/**
 * Words that say a case enters text that is only spaces. Not "empty": a trim check exists for text that is not empty
 * but blank, and "empty" matches unrelated cases (an empty list), which would let the check pass without the case that matters.
 */
const BLANK_WORDS = /\b(whitespace|blank|only spaces|spaces only)\b/i;

/**
 * Boundary values for text (SPEC §5): when the code in a session's task rejects text that is empty or only spaces, one of
 * its cases must enter text that is only spaces (its steps or expectations say so: only spaces, blank, whitespace), or a
 * decline must say why that cannot be tested. A code check, not only a prompt rule: without it no such case was written,
 * and a bug that removes the trim goes unnoticed.
 */
export function blankInputProblems(sub: SubmitTestCases, blocks: ReadonlyArray<{ file: string; start: number; lines: string[] }>): string[] {
  const where = blocks.flatMap((b) => b.lines.flatMap((line, i) => (BLANK_CHECK.test(line) ? [`${b.file}:${b.start + i} \`${line.trim()}\``] : [])));
  if (where.length === 0) return [];
  const covered = sub.testCases.some((tc) => BLANK_WORDS.test([...tc.steps, ...tc.expected.map((e) => e.description)].join(' ')));
  const declined = sub.declined.some((d) => BLANK_WORDS.test(d.reason));
  if (covered || declined) return [];
  return [
    `The code rejects text that is empty or only spaces (${[...new Set(where)].slice(0, 3).join('; ')}). Add a boundary test case that enters only spaces there (and an empty value) and checks it is rejected (the message shown, or nothing saved or sent); say "only spaces" in its steps. If that input cannot be tested, say why in declined.`,
  ];
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
