import type { FailureCategory } from '../../shared/schemas.js';

/** Matchers that compare a value: only their failure, on an expectation with a locked value, is an app disagreement. */
export const VALUE_MATCHERS = new Set([
  'toBe',
  'toEqual',
  'toStrictEqual',
  'toContain',
  'toMatch',
  'toHaveText',
  'toContainText',
  'toHaveURL',
  'toHaveValue',
  'toHaveCount',
  'toHaveTitle',
  'toHaveAttribute',
]);

export type DryRunVerdict =
  | { kind: 'passed' }
  /** A locked value was compared and differed: the app disagrees with the test case. Stop, keep the script. */
  | { kind: 'assertion_failed'; expectationId: string }
  /** Anything else: a failed attempt; the next one may change the body, never EXPECTED. */
  | { kind: 'failed'; category: FailureCategory; expectationId: string | null };

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

export const stripAnsi = (text: string) => text.replace(ANSI, '');

/**
 * Classifies one dry-run result from Playwright's JSON report (status and error message). Formats as
 * recorded from Playwright 1.64.0 (tests/fixtures/playwright-errors/): a custom expect message is the
 * first line `Error: E<n>`; a locator that found nothing or several elements adds `Error: element(s)
 * not found` or `Error: strict mode violation`; a compared value shows `Received…` or a `+ Received` diff.
 */
export function classifyDryRun(
  result: { status: string; message: string },
  valueIds: ReadonlySet<string>,
): DryRunVerdict {
  if (result.status === 'passed') return { kind: 'passed' };
  const message = stripAnsi(result.message);
  if (result.status === 'timedOut' || /^Test timeout of \d+ms exceeded/m.test(message)) {
    return { kind: 'failed', category: 'timeout', expectationId: null };
  }
  const expectationId = /^Error: (E\d+)\s*$/m.exec(message.split('\n')[0] ?? '')?.[1] ?? null;
  if (expectationId === null) {
    const category: FailureCategory = /\bTimeoutError\b|Timeout \d+ms exceeded/.test(message) ? 'timeout' : 'runtime-error';
    return { kind: 'failed', category, expectationId: null };
  }
  // Without a locked value the failure is never an app disagreement, but it may be one in fact
  // (e.g. a message that never appears shows up as "not found"): keep it apart for review.
  if (!valueIds.has(expectationId)) return { kind: 'failed', category: 'value-less-expect', expectationId };
  if (/^Error: (element\(s\) not found|strict mode violation)/m.test(message)) {
    return { kind: 'failed', category: 'locator', expectationId };
  }
  const matcher = /expect\((?:received|locator|page)\)\.(?:not\.)?(\w+)\(/.exec(message)?.[1];
  const comparedValue = /^(Received(?: string| value)?:|\+ Received)/m.test(message);
  if (matcher !== undefined && VALUE_MATCHERS.has(matcher) && comparedValue) {
    return { kind: 'assertion_failed', expectationId };
  }
  return { kind: 'failed', category: 'value-less-expect', expectationId };
}
