import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { normaliseError, triage } from '../../src/modules/failure-analyzer/triage.js';
import { ExecutionResults } from '../../src/shared/schemas.js';
import type { TestResult } from '../../src/shared/schemas.js';

// Error messages recorded from real Playwright 1.64.0 runs.
const recorded = JSON.parse(
  await readFile(new URL('../fixtures/playwright-errors/1.64.0.json', import.meta.url), 'utf8'),
) as { cases: Record<string, { status: string; message: string }> };

describe('normaliseError', () => {
  it('removes only what changes between runs', () => {
    const a = 'Error: E1\nExpected: "item-mh2k9x3a-4fz1ab"\nReceived at http://127.0.0.1:40001/api/items/652f1c2e9b1e8a0012345678 after 5000ms (2026-10-28T09:00:00.123Z) at spec.ts:12:7';
    const b = 'Error: E1\nExpected: "item-mh2k9y00-zz9"\nReceived at http://localhost:3000/api/items/aaaaaaaaaaaaaaaaaaaaaaaa after 30000ms (2026-10-29T10:11:12Z) at spec.ts:40:3';
    expect(normaliseError(a)).toBe(normaliseError(b));
    expect(normaliseError(a)).toBe('Error: E1 Expected: "<uniq>" Received at <origin>/api/items/<id> after <n>ms (<time>) at spec.ts');
  });

  it('keeps expected and received values, and words that only look like uniq values', () => {
    expect(normaliseError('Expected: 400\nReceived: 200')).not.toBe(normaliseError('Expected: 404\nReceived: 200'));
    expect(normaliseError('Error: strict mode violation: content-security-policy')).toBe('Error: strict mode violation: content-security-policy');
  });

  it('drops Playwright\'s call log, which repeats retries with changing counts', () => {
    for (const r of Object.values(recorded.cases)) expect(normaliseError(r.message)).not.toMatch(/Call log:/);
    const withLog = recorded.cases['not-found-with-value']!.message;
    expect(withLog).toMatch(/Call log:/);
  });

  it('is the same for every recorded real error when run twice with other ports and ids', () => {
    for (const r of Object.values(recorded.cases)) {
      const moved = r.message.replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:59999').replace(/localhost:\d+/g, 'localhost:1');
      expect(normaliseError(moved)).toBe(normaliseError(r.message));
    }
  });
});

const result = (id: string, status: TestResult['status'], message = '', extra: Partial<TestResult> = {}): TestResult => ({
  testCaseId: id,
  status,
  isolated: true,
  durationMs: 1,
  ...(status === 'passed' ? {} : { error: { message, expectationId: status === 'failed' ? 'E1' : null, category: status === 'failed' ? 'assertion_failed' : 'timeout' } }),
  artifacts: {},
  ...extra,
});

describe('triage', () => {
  it('groups failures by signature, orders groups by their first test, and attaches the environment', () => {
    const results = ExecutionResults.parse({
      schemaVersion: '1.0', execId: 'x-01', startedAt: '2026-10-28T09:00:00Z', finishedAt: '2026-10-28T09:01:00Z',
      environment: { healthChecks: [], seed: [], seedCheck: { ok: false, status: 200, detail: 'empty' } },
      summary: { total: 5, passed: 1, failed: 3, errored: 1, skipped: 0, notIsolated: 1 },
      incidents: [{ beforeTestCaseId: 'TC-005', kind: 'backend-crashed', detail: 'code 1' }],
      results: [
        result('TC-001', 'passed'),
        result('TC-002', 'failed', 'Expected: 404\nReceived: 200 at http://localhost:1/x'),
        result('TC-003', 'failed', 'Expected: 400\nReceived: 200 at http://localhost:2/x'),
        result('TC-004', 'failed', 'Expected: 400\nReceived: 200 at http://localhost:3/x', { isolated: false }),
        result('TC-005', 'errored', 'Test timeout of 30000ms exceeded.'),
      ],
    });
    const t = triage(results);
    expect(t.failures.map((f) => f.testCaseId)).toEqual(['TC-002', 'TC-003', 'TC-004', 'TC-005']);
    expect(t.groups.map((g) => g.testCaseIds)).toEqual([['TC-002'], ['TC-003', 'TC-004'], ['TC-005']]);
    expect(t.groups[2]?.signature).toBe('errored | timeout | Test timeout of <n>ms exceeded.');
    expect(t.environment).toMatchObject({ seedCheck: { ok: false }, notIsolated: ['TC-004'], incidents: [{ kind: 'backend-crashed' }] });
  });
});
