import { describe, expect, it } from 'vitest';
import { allComparisons, changeKind, compareTests } from '../../src/modules/report/compare.js';
import type { ViewExecution, ViewTest } from '../../src/shared/schemas.js';

const t = (testCaseId: string, status: ViewTest['status']): ViewTest => ({ testCaseId, title: '', status, isolated: true, durationMs: 1, requirementIds: [] });

describe('changeKind', () => {
  it.each([
    ['passed', 'failed', 'newly-failing'],
    ['passed', 'errored', 'newly-failing'],
    ['failed', 'passed', 'fixed'],
    ['errored', 'passed', 'fixed'],
    ['failed', 'errored', 'failure-changed'],
    ['errored', 'failed', 'failure-changed'],
    ['skipped', 'passed', 'only-in-one'],
    ['passed', 'skipped', 'only-in-one'],
    [null, 'failed', 'only-in-one'],
    ['failed', null, 'only-in-one'],
    ['passed', 'passed', null],
    ['skipped', 'skipped', null],
  ] as const)('%s → %s: %s', (from, to, kind) => {
    expect(changeKind(from, to)).toBe(kind);
  });
});

describe('compareTests', () => {
  it('lists only changed tests, in the order they first appear', () => {
    const a = [t('TC-001', 'passed'), t('TC-002', 'passed'), t('TC-003', 'failed'), t('TC-005', 'skipped')];
    const b = [t('TC-004', 'failed'), t('TC-003', 'passed'), t('TC-002', 'errored'), t('TC-001', 'passed'), t('TC-005', 'skipped')];
    expect(compareTests(a, b)).toEqual([
      { testCaseId: 'TC-002', from: 'passed', to: 'errored', kind: 'newly-failing' },
      { testCaseId: 'TC-003', from: 'failed', to: 'passed', kind: 'fixed' },
      { testCaseId: 'TC-004', from: null, to: 'failed', kind: 'only-in-one' },
    ]);
  });
});

describe('allComparisons', () => {
  it('compares every pair of executions that have results, in run.json order', () => {
    const exec = (execId: string, tests: ViewTest[], hasResults = true) => ({ execId, tests, summary: hasResults ? {} : null }) as unknown as ViewExecution;
    const out = allComparisons([exec('x-01', [t('TC-001', 'passed')]), exec('x-02', [t('TC-001', 'failed')]), exec('x-03', [], false), exec('x-04', [t('TC-001', 'passed')])]);
    expect(Object.keys(out)).toEqual(['x-01|x-02', 'x-01|x-04', 'x-02|x-04']);
    expect(out['x-01|x-04']).toEqual([]);
    expect(out['x-02|x-04']?.[0]?.kind).toBe('fixed');
  });
});
