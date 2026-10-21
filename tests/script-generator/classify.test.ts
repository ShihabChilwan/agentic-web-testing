import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { classifyDryRun, stripAnsi } from '../../src/modules/script-generator/classify.js';

const recorded = JSON.parse(
  await readFile(new URL('../fixtures/playwright-errors/1.64.0.json', import.meta.url), 'utf8'),
) as { playwrightVersion: string; cases: Record<string, { status: string; message: string }> };

/** Expectations that have a locked value in these cases: E1–E6 (value matchers), E9. E7 and E8 have none. */
const VALUE_IDS = new Set(['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E9']);

const EXPECTED_VERDICTS: Record<string, string> = {
  'value-mismatch-toBe': 'assertion_failed E1',
  'value-mismatch-toEqual': 'assertion_failed E1',
  'value-mismatch-toContain': 'assertion_failed E1',
  'value-mismatch-toHaveText': 'assertion_failed E2',
  'value-mismatch-toHaveURL': 'assertion_failed E3',
  'value-mismatch-toHaveCount': 'assertion_failed E4',
  'not-found-with-value': 'failed locator E5',
  'strict-mode-with-value': 'failed locator E6',
  'value-less-hidden': 'failed value-less-expect E7',
  'value-less-not-found': 'failed value-less-expect E8',
  'type-error': 'failed runtime-error',
  'action-timeout': 'failed timeout',
  'test-timeout': 'failed timeout',
  'connection-refused': 'failed runtime-error',
};

const describeVerdict = (v: ReturnType<typeof classifyDryRun>) =>
  v.kind === 'passed' ? 'passed' : v.kind === 'assertion_failed' ? `assertion_failed ${v.expectationId}` : `failed ${v.category}${v.expectationId ? ` ${v.expectationId}` : ''}`;

describe(`classifyDryRun on real Playwright ${recorded.playwrightVersion} output`, () => {
  for (const [name, expected] of Object.entries(EXPECTED_VERDICTS)) {
    it(`${name} → ${expected}`, () => {
      const result = recorded.cases[name];
      expect(result, `missing recorded case ${name}`).toBeDefined();
      expect(describeVerdict(classifyDryRun(result!, VALUE_IDS))).toBe(expected);
    });
  }

  it('treats a value matcher failure as value-less when the expectation has no locked value', () => {
    expect(describeVerdict(classifyDryRun(recorded.cases['value-mismatch-toBe']!, new Set()))).toBe('failed value-less-expect E1');
  });

  it('does not count a non-value matcher (e.g. toBeVisible) on a valued expectation as a value comparison', () => {
    expect(describeVerdict(classifyDryRun(recorded.cases['value-less-hidden']!, new Set(['E7'])))).toBe('failed value-less-expect E7');
  });

  it('reports a passed test as passed', () => {
    expect(classifyDryRun({ status: 'passed', message: '' }, VALUE_IDS)).toEqual({ kind: 'passed' });
  });
});

describe('classifyDryRun against the installed Playwright (slow)', () => {
  it('still produces the recorded verdicts', { timeout: 120_000 }, async () => {
    const out = await mkdtemp(path.join(tmpdir(), 'pw-errors-'));
    const { stdout } = await promisify(execFile)(
      'npx',
      ['playwright', 'test', 'tests/playwright/error-kinds.spec.ts', '--reporter=json', '--workers=2', `--output=${out}`],
      { cwd: path.resolve(import.meta.dirname, '../..'), maxBuffer: 20 * 1024 * 1024 },
    ).catch((err: { stdout?: string }) => ({ stdout: err.stdout ?? '' }));
    const report = JSON.parse(stdout) as { suites: Suite[] };
    interface Suite { specs?: Array<{ title: string; tests: Array<{ results: Array<{ status: string; error?: { message?: string } }> }> }>; suites?: Suite[] }
    const specs = (s: Suite): NonNullable<Suite['specs']> => [...(s.specs ?? []), ...(s.suites ?? []).flatMap(specs)];
    const live = Object.fromEntries(
      report.suites.flatMap(specs).map((sp) => {
        const r = sp.tests[0]!.results[0]!;
        return [sp.title, describeVerdict(classifyDryRun({ status: r.status, message: stripAnsi(r.error?.message ?? '') }, VALUE_IDS))];
      }),
    );
    expect(live).toEqual(EXPECTED_VERDICTS);
  });
});
