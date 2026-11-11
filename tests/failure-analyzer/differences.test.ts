import { describe, expect, it } from 'vitest';
import { groupDifferences, MAX_DIFFERENCE_GROUPS } from '../../src/modules/failure-analyzer/differences.js';
import { ResponseComparison } from '../../src/shared/schemas.js';

const diff = (field: string, base: unknown, other: unknown, extra: Record<string, unknown> = {}) => ({ field, path: field, base, other, strength: 'strong', reason: 'value', ...extra });
const comparison = (tests: Array<[string, string, ReturnType<typeof diff>[]]>, findings: unknown[] = []) =>
  ResponseComparison.parse({
    schemaVersion: '1.0', createdAt: '2026-11-11T00:00:00Z', run: 'r', base: 'x-02', other: 'x-09', noiseFile: 'noise-fields.json',
    summary: { matched: 1, unmatched: 0, differences: 1, ignoredAsNoise: 0, remaining: 1, strong: 1, weak: 0, testsWithDifferences: 1 },
    findings,
    tests: tests.map(([testCaseId, endpoint, differences]) => ({ testCaseId, endpoints: [{ endpoint, occurrence: 1, differences }] })),
  });

describe('groupDifferences', () => {
  it('groups passing tests by endpoint path and field set across tests; failing tests get their lines as evidence', () => {
    const c = comparison([
      ['TC-001', 'GET /api/list?page=:id', [diff('items[*].slug', 'a-x1', 'a', { reason: 'shape' })]],
      ['TC-002', 'GET /api/list?page=:id&limit=:id', [diff('items[*].slug', 'a-x1', 'a', { reason: 'shape' })]],
      ['TC-003', 'POST /api/cart', [diff('success', true, false)]],
      ['TC-004', 'GET /api/list', [diff('items[*].slug', 'a-x1', 'a'), diff('(response)', '200', '(absent)', { strength: 'weak' })]],
    ]);
    const g = groupDifferences(c, new Set(['TC-003']));
    expect(g.groups.map((x) => [x.kind, x.key, x.allTests])).toEqual([['difference', 'GET /api/list [items[*].slug]', ['TC-001', 'TC-002', 'TC-004']]]);
    expect(g.byFailingTest.get('TC-003')).toMatchObject([{ field: 'success', reference: true, current: false }]);
    expect(g.weak).toBe(1);
    // No execution id or file name reaches the lines.
    expect(JSON.stringify(g)).not.toMatch(/x-02|x-09|noise-fields/);
  });

  it('a setup finding is a group of its own, first; groups are capped', () => {
    const many = Array.from({ length: 9 }, (_, i): [string, string, ReturnType<typeof diff>[]] => [`TC-0${10 + i}`, `GET /api/e${i}`, [diff('n', 1, 2)]]);
    const g = groupDifferences(comparison(many, [{ kind: 'setup-changed', message: 'setup changed: database snapshot failed / re-seeded', count: 500 }]), new Set());
    expect(g.groups[0]).toMatchObject({ kind: 'setup', testCaseIds: ['TC-010', 'TC-011', 'TC-012'] });
    expect(g.groups[0]!.message).toContain('500 differences that only change ids');
    expect(g.groups).toHaveLength(MAX_DIFFERENCE_GROUPS);
    expect(g.leftOut).toBe(10 - MAX_DIFFERENCE_GROUPS);
  });
});
