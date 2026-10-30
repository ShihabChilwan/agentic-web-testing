import { describe, expect, it } from 'vitest';
import { TestCases } from '../../../src/shared/schemas.js';
import { errorPaths, example } from './helpers.js';

describe('testcases.json', () => {
  const cases = example('testcases.json');

  it('accepts the reference example', () => {
    expect(TestCases.safeParse(cases).success).toBe(true);
  });

  it('accepts string, number and boolean expected values only', () => {
    for (const value of ['/login', 3, false]) {
      const c = structuredClone(cases);
      c.testCases[0].expected[1].value = value;
      expect(TestCases.safeParse(c).success).toBe(true);
    }
    for (const value of [{ url: '/login' }, ['/login'], null]) {
      const c = structuredClone(cases);
      c.testCases[0].expected[1].value = value;
      expect(errorPaths(TestCases, c)).toContain('testCases.0.expected.1.value');
    }
  });

  it('requires a reasonKind on uncovered entries and defaults partial to an empty list', () => {
    const c = structuredClone(cases);
    expect(TestCases.parse(c).coverage.partial).toEqual([
      { requirementId: 'REQ-004', reason: 'The success email after registration cannot be checked: email is disabled.' },
    ]);
    delete c.coverage.partial;
    expect(TestCases.parse(c).coverage.partial).toEqual([]);
    c.coverage.uncovered[0].reasonKind = 'too-hard';
    expect(errorPaths(TestCases, c)).toContain('coverage.uncovered.0.reasonKind');
  });

    it('rejects layers other than api and ui', () => {
    const c = structuredClone(cases);
    c.testCases[0].layer = 'e2e';
    expect(errorPaths(TestCases, c)).toContain('testCases.0.layer');
  });

  it('rejects more than 250 test cases', () => {
    const c = structuredClone(cases);
    c.testCases = Array.from({ length: 251 }, (_, i) => ({
      ...cases.testCases[0],
      id: `TC-${String(i + 1).padStart(3, '0')}`,
    }));
    expect(errorPaths(TestCases, c)).toContain('testCases');
  });
});
