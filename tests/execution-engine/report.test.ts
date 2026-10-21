import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { readReport, sortResult, type PlaywrightReport } from '../../src/modules/execution-engine/report.js';

// Error messages recorded from real Playwright 1.64.0 runs (tests/playwright/error-kinds.spec.ts).
const recorded = JSON.parse(
  await readFile(new URL('../fixtures/playwright-errors/1.64.0.json', import.meta.url), 'utf8'),
) as { cases: Record<string, { status: string; message: string }> };

const VALUE_IDS = new Set(['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E9']);

// Decision A (SPEC §7.3): any failed E-id check is `failed`; the classifier's label is kept as the category.
const EXPECTED: Record<string, [status: string, category: string, expectationId: string | null]> = {
  'value-mismatch-toBe': ['failed', 'assertion_failed', 'E1'],
  'value-mismatch-toHaveText': ['failed', 'assertion_failed', 'E2'],
  'not-found-with-value': ['failed', 'locator', 'E5'],
  'strict-mode-with-value': ['failed', 'locator', 'E6'],
  'value-less-hidden': ['failed', 'value-less-expect', 'E7'],
  'value-less-not-found': ['failed', 'value-less-expect', 'E8'],
  'type-error': ['errored', 'runtime-error', null],
  'action-timeout': ['errored', 'timeout', null],
  'test-timeout': ['errored', 'timeout', null],
  'connection-refused': ['errored', 'runtime-error', null],
};

describe('sortResult on real Playwright 1.64.0 errors', () => {
  for (const [name, [status, category, expectationId]] of Object.entries(EXPECTED)) {
    it(`${name} → ${status} (${category})`, () => {
      const r = recorded.cases[name]!;
      const sorted = sortResult({ status: r.status, duration: 1234, error: { message: r.message } }, VALUE_IDS);
      expect(sorted.status).toBe(status);
      expect(sorted.error).toMatchObject({ category, expectationId });
      expect(sorted.durationMs).toBe(1234);
    });
  }

  it('passed has no error', () => {
    expect(sortResult({ status: 'passed', duration: 10 }, VALUE_IDS)).toEqual({ status: 'passed', durationMs: 10 });
  });

  it('a test with no result is errored, not-run, with the report errors as its message', () => {
    expect(sortResult(undefined, VALUE_IDS, ['SyntaxError: Unexpected token'])).toEqual({
      status: 'errored',
      durationMs: 0,
      error: { message: 'SyntaxError: Unexpected token', expectationId: null, category: 'not-run' },
    });
    expect(sortResult({ status: 'interrupted', duration: 5 }, VALUE_IDS).error?.category).toBe('not-run');
  });
});

describe('readReport on a real Playwright 1.64.0 JSON report', () => {
  it('finds each spec file\'s result and its attachments', async () => {
    const report = JSON.parse(
      await readFile(new URL('../fixtures/playwright-json-report/1.64.0.json', import.meta.url), 'utf8'),
    ) as PlaywrightReport;
    const { byFile, errors } = readReport(report);
    expect(errors).toEqual([]);
    expect([...byFile.keys()].sort()).toEqual(['TC-001.spec.ts', 'TC-002.spec.ts']);
    expect(byFile.get('TC-001.spec.ts')?.status).toBe('passed');
    const failed = byFile.get('TC-002.spec.ts')!;
    expect(failed.status).toBe('failed');
    expect(failed.attachments?.map((a) => a.name)).toEqual(expect.arrayContaining(['screenshot', 'trace']));
    expect(sortResult(failed, new Set(['E1']))).toMatchObject({ status: 'failed', error: { expectationId: 'E1', category: 'assertion_failed' } });
  });
});
