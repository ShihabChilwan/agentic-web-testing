import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectBug, sampleForAnalysis, scoreSuite, shuffle, type BugDetection, type Comparison, type TestResult } from '../scenarios/score.js';

const res = (statuses: Record<string, TestResult['status']>): TestResult[] => Object.entries(statuses).map(([testCaseId, status]) => ({ testCaseId, status }));
const cmp = (strong: string[], weak: string[] = [], setup = false): Comparison => ({
  findings: setup ? [{ kind: 'setup-changed', count: 60 }] : [],
  tests: [
    ...strong.map((id) => ({ testCaseId: id, endpoints: [{ differences: [{ strength: 'strong' as const }] }] })),
    ...weak.map((id) => ({ testCaseId: id, endpoints: [{ differences: [{ strength: 'weak' as const }] }] })),
  ],
});
const golden = [res({ 'TC-001': 'passed', 'TC-002': 'passed', 'SC-001': 'passed', 'SC-002': 'failed' })];

describe('detection by origin', () => {
  it('counts failing tests that pass on every correct run, and strong differences, per origin', () => {
    const d = detectBug({ suite: 'S1', bug: 'bug-001', execId: 'x-03', results: res({ 'TC-001': 'passed', 'TC-002': 'passed', 'SC-001': 'failed', 'SC-002': 'failed' }), comparison: cmp(['SC-002'], ['TC-001']), goldenResults: golden });
    expect(d.failing).toEqual({ TC: [], SC: ['SC-001'] }); // SC-002 failed on a correct run: not counted
    expect(d.differing).toEqual({ TC: [], SC: ['SC-002'] }); // a weak difference does not count
    expect(d).toMatchObject({ bySuite: false, withScenarios: true, scenarioOnly: true, comparatorOnly: false });
  });

  it('a setup-changed finding counts for both origins, so it is never scenario-only', () => {
    const d = detectBug({ suite: 'S1', bug: 'bug-002', execId: 'x-04', results: res({ 'TC-001': 'passed' }), comparison: cmp([], [], true), goldenResults: golden });
    expect(d).toMatchObject({ bySuite: true, scenarioOnly: false, comparatorOnly: true });
  });

  it('missing data is reported, not counted', () => {
    expect(detectBug({ suite: 'S1', bug: 'bug-003', execId: null, results: null, comparison: null, goldenResults: golden }).missingData).toBe('no execution results');
  });
});

describe('the analyzer sample', () => {
  const pair = (suite: string, bug: string, extra: Partial<BugDetection> = {}): BugDetection => ({
    suite, bug, execId: 'x-01', failing: { TC: ['TC-001'], SC: [] }, differing: { TC: [], SC: [] }, setupChanged: false,
    caughtBy: { tcTests: true, tcComparator: false, scTests: false, scComparator: false }, bySuite: true, withScenarios: true, scenarioOnly: false, comparatorOnly: false, ...extra,
  });

  it('is the same for the same seed, takes one scenario-only and one comparator-only pair first, and leaves out missed bugs', () => {
    const pairs = [
      ...Array.from({ length: 14 }, (_, i) => pair('S1', `bug-${String(i + 1).padStart(3, '0')}`)),
      pair('S2', 'bug-001', { scenarioOnly: true, bySuite: false }),
      pair('S2', 'bug-002', { comparatorOnly: true }),
      pair('S2', 'bug-003', { withScenarios: false, bySuite: false }),
    ];
    const a = sampleForAnalysis(pairs);
    expect(a).toEqual(sampleForAnalysis([...pairs].reverse()));
    expect(a).toHaveLength(10);
    expect(a.map((d) => `${d.suite}/${d.bug}`)).toEqual(expect.arrayContaining(['S2/bug-001', 'S2/bug-002']));
    expect(a.map((d) => `${d.suite}/${d.bug}`)).not.toContain('S2/bug-003');
    expect(sampleForAnalysis(pairs, 1)).not.toEqual(a);
    expect(shuffle([1, 2, 3, 4, 5], 7)).toEqual(shuffle([1, 2, 3, 4, 5], 7));
  });
});

describe('a suite from files', () => {
  let dir: string;
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads the mapping, results and comparisons, and the fresh check', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'scn-score-'));
    const put = async (rel: string, v: unknown) => {
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), JSON.stringify(v));
    };
    const ids: Record<string, string> = { golden: 'x-01', 'golden-2': 'x-02', 'golden-3': 'x-03', 'golden-4': 'x-04', 'bug-001': 'x-05', 'bug-002': 'x-06' };
    await put('eval/mapping.json', { versions: Object.entries(ids).map(([version, execId]) => ({ version, execId })) });
    for (const v of ['golden', 'golden-2', 'golden-3', 'golden-4']) await put(`executions/${ids[v]}/results.json`, { results: res({ 'TC-001': 'passed', 'SC-001': 'passed' }) });
    await put('executions/x-05/results.json', { results: res({ 'TC-001': 'failed', 'SC-001': 'passed' }) });
    await put('executions/x-06/results.json', { results: res({ 'TC-001': 'passed', 'SC-001': 'passed' }) });
    await put('differential/compare-x-01-x-05.json', cmp([]));
    await put('differential/compare-x-01-x-06.json', cmp(['SC-001']));
    await put('differential/compare-x-01-x-04.json', cmp(['TC-001']));
    const s = await scoreSuite('S1', dir);
    expect(s.detections.map((d) => [d.bug, d.bySuite, d.scenarioOnly])).toEqual([['bug-001', true, false], ['bug-002', false, true]]);
    expect(s.falseAlarms).toEqual({ suite: 'S1', differing: { TC: 1, SC: 0 }, setupChanged: false, failing: { TC: 0, SC: 0 } });
    expect(s.problems).toEqual([]);
  });
});
