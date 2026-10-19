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

  it('rejects layers other than api and ui', () => {
    const c = structuredClone(cases);
    c.testCases[0].layer = 'e2e';
    expect(errorPaths(TestCases, c)).toContain('testCases.0.layer');
  });

  it('rejects more than 150 test cases', () => {
    const c = structuredClone(cases);
    c.testCases = Array.from({ length: 151 }, (_, i) => ({
      ...cases.testCases[0],
      id: `TC-${String(i + 1).padStart(3, '0')}`,
    }));
    expect(errorPaths(TestCases, c)).toContain('testCases');
  });
});
