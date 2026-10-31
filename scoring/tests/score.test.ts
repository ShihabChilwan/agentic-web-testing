import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { aggregate, spread } from '../src/aggregate.js';
import { loadSuite } from '../src/load.js';
import { lineWithin, primaryDiagnosis, scoreSuite } from '../src/score.js';
import { runScoring } from '../cli.js';
import { code, env, variantsFile, writeSuite } from './fixtures.js';
import type { FakeVersion } from './fixtures.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const GOLDEN: FakeVersion = { tests: { 'TC-001': 'passed', 'TC-002': 'passed', 'TC-003': 'passed' } };
const FILE = 'server/routes/api/auth.js';

async function suite(versions: Record<string, FakeVersion>, id = 'eval-test-1') {
  const s = await writeSuite({ golden: GOLDEN, ...versions }, id);
  cleanups.push(s.remove);
  return loadSuite(s.dir);
}

describe('caught', () => {
  it('needs a test that passed on golden and failed or errored on the version', async () => {
    const variants = variantsFile([code('bug-001', FILE, [10, 12]), code('bug-002', FILE, [20, 20]), code('bug-003', FILE, [30, 30])]);
    const s = await suite({
      'bug-001': { tests: { 'TC-001': 'failed', 'TC-002': 'passed', 'TC-003': 'passed' } },
      'bug-002': { tests: { 'TC-001': 'passed', 'TC-002': 'passed', 'TC-003': 'errored' } },
      'bug-003': { tests: { 'TC-001': 'passed', 'TC-002': 'passed', 'TC-003': 'passed' } },
    });
    const score = scoreSuite(s, variants);
    expect(score.versions.map((v) => v.caught)).toEqual([true, true, false]);
    expect(score.rates.mutationScoreRaw).toBeCloseTo(2 / 3);
  });

  it('ignores a test that does not pass on golden', async () => {
    const variants = variantsFile([code('bug-001', FILE, [10, 12])]);
    const s = await writeSuite({ golden: { tests: { 'TC-001': 'passed', 'TC-002': 'failed' } }, 'bug-001': { tests: { 'TC-001': 'passed', 'TC-002': 'failed' } } });
    cleanups.push(s.remove);
    const score = scoreSuite(await loadSuite(s.dir), variants);
    expect(score.versions[0]!.caught).toBe(false);
    expect(score.golden.failures).toBe(1);
    expect(score.warnings.join()).toContain('fail on golden');
  });

  it('counts a version whose cloud task produced no execution as not caught', async () => {
    const variants = variantsFile([code('bug-001', FILE, [10, 12])]);
    const score = scoreSuite(await suite({ 'bug-001': { tests: {}, failedTask: true } }), variants);
    expect(score.versions[0]).toMatchObject({ ran: false, caught: false });
    expect(score.warnings.join()).toContain('no execution');
  });
});

describe('primary diagnosis', () => {
  const d = (confidence: number, tests: string[], classification: 'app_defect' | 'test_defect' = 'app_defect') => ({ tests, classification, confidence });

  it('takes the highest confidence, then the group with more tests, then the earlier one', () => {
    const mk = (id: string, confidence: number, n: number) => ({ id, confidence, testCaseIds: Array.from({ length: n }, (_, i) => `TC-00${i + 1}`) }) as never;
    expect(primaryDiagnosis([mk('a', 0.7, 1), mk('b', 0.9, 1), mk('c', 0.8, 5)])).toMatchObject({ id: 'b' });
    expect(primaryDiagnosis([mk('a', 0.9, 1), mk('b', 0.9, 3), mk('c', 0.9, 3)])).toMatchObject({ id: 'b' });
    expect(primaryDiagnosis([])).toBeNull();
    void d;
  });

  it('classification uses the highest-confidence group of any class; localization the highest app_defect group', async () => {
    const variants = variantsFile([code('bug-001', FILE, [100, 104])]);
    const wrongLine = { file: FILE, lines: [200, 210] as [number, number] };
    const rightLine = { file: FILE, lines: [98, 99] as [number, number] };
    const s = await suite({
      'bug-001': {
        tests: { 'TC-001': 'failed', 'TC-002': 'failed', 'TC-003': 'passed' },
        diagnoses: [
          { tests: ['TC-001'], classification: 'test_defect', confidence: 0.95 },
          { tests: ['TC-002'], classification: 'app_defect', confidence: 0.8, location: wrongLine },
          { tests: ['TC-002'], classification: 'app_defect', confidence: 0.6, location: rightLine },
        ],
      },
    });
    const v = scoreSuite(s, variants).versions[0]!;
    expect(v).toMatchObject({ primaryClass: 'test_defect', classCorrect: false, classAny: true });
    expect(v).toMatchObject({ fileCorrect: true, lineCorrect: false, fileAny: true, lineAny: true });
  });

  it('is wrong on file and line without an app_defect group with a location', async () => {
    const variants = variantsFile([code('bug-001', FILE, [100, 104])]);
    const s = await suite({
      'bug-001': { tests: { 'TC-001': 'failed', 'TC-002': 'passed', 'TC-003': 'passed' }, diagnoses: [{ tests: ['TC-001'], classification: 'environment_issue', confidence: 0.9 }] },
    });
    expect(scoreSuite(s, variants).versions[0]).toMatchObject({ classCorrect: false, fileCorrect: false, lineCorrect: false });
  });

  it('ignores groups whose tests do not count as caught', async () => {
    const variants = variantsFile([code('bug-001', FILE, [100, 104])]);
    const s = await writeSuite({
      golden: { tests: { 'TC-001': 'passed', 'TC-002': 'failed' } },
      'bug-001': {
        tests: { 'TC-001': 'failed', 'TC-002': 'failed' },
        diagnoses: [
          { tests: ['TC-002'], classification: 'test_defect', confidence: 0.99 },
          { tests: ['TC-001'], classification: 'app_defect', confidence: 0.5, location: { file: FILE, lines: [101, 101] } },
        ],
      },
    });
    cleanups.push(s.remove);
    expect(scoreSuite(await loadSuite(s.dir), variants).versions[0]).toMatchObject({ primaryClass: 'app_defect', classCorrect: true, lineCorrect: true });
  });

  it('counts a caught version that was not analysed as wrong and warns', async () => {
    const variants = variantsFile([code('bug-001', FILE, [100, 104])]);
    const score = scoreSuite(await suite({ 'bug-001': { tests: { 'TC-001': 'failed', 'TC-002': 'passed', 'TC-003': 'passed' } } }), variants);
    expect(score.versions[0]).toMatchObject({ caught: true, analyzed: false, classCorrect: false });
    expect(score.warnings.join()).toContain('not analysed');
  });
});

describe('lines', () => {
  it('overlap with the variant lines widened by 5 on each side', () => {
    expect(lineWithin([111, 111], [100, 104])).toBe(false);
    expect(lineWithin([109, 109], [100, 104])).toBe(true);
    expect(lineWithin([90, 94], [100, 104])).toBe(false);
    expect(lineWithin([90, 95], [100, 104])).toBe(true);
    expect(lineWithin([50, 300], [100, 104])).toBe(true);
  });
});

describe('equivalent mutants, environment faults and golden', () => {
  it('reports raw and adjusted mutation scores and scores environment faults on classification', async () => {
    const variants = variantsFile([code('bug-001', FILE, [10, 12]), code('bug-002', FILE, [20, 20]), env('env-01'), env('env-02')]);
    const fail = { tests: { 'TC-001': 'failed' as const, 'TC-002': 'failed' as const, 'TC-003': 'failed' as const } };
    const s = await suite({
      'bug-001': { tests: { 'TC-001': 'failed', 'TC-002': 'passed', 'TC-003': 'passed' }, diagnoses: [{ tests: ['TC-001'], classification: 'app_defect', confidence: 0.9, location: { file: FILE, lines: [11, 11] } }] },
      'bug-002': { tests: { 'TC-001': 'passed', 'TC-002': 'passed', 'TC-003': 'passed' } },
      'env-01': { ...fail, diagnoses: [{ tests: ['TC-001', 'TC-002'], classification: 'environment_issue', confidence: 0.9 }, { tests: ['TC-003'], classification: 'test_defect', confidence: 0.6 }] },
      'env-02': { ...fail, diagnoses: [{ tests: ['TC-001'], classification: 'test_defect', confidence: 0.9 }, { tests: ['TC-002', 'TC-003'], classification: 'environment_issue', confidence: 0.7 }] },
    });
    const score = scoreSuite(s, variants, ['bug-002']);
    expect(score.rates).toMatchObject({ mutationScoreRaw: 0.5, mutationScoreAdjusted: 1, codeClassification: 1, codeFile: 1, codeLine: 1, envDetection: 1, envClassification: 0.5, envClassificationAnyGroup: 1, envClassificationMajority: 1 });
    expect(score.confusion).toEqual({ app_defect: { app_defect: 1 }, environment_issue: { environment_issue: 1, test_defect: 1 } });
  });

  it('measures golden false alarms', async () => {
    const variants = variantsFile([code('bug-001', FILE, [10, 12])]);
    const s = await writeSuite({
      golden: { tests: { 'TC-001': 'failed', 'TC-002': 'failed', 'TC-003': 'passed' }, diagnoses: [{ tests: ['TC-001'], classification: 'app_defect', confidence: 0.8, location: { file: FILE, lines: [1, 1] } }, { tests: ['TC-002'], classification: 'test_defect', confidence: 0.8 }] },
      'bug-001': { tests: { 'TC-001': 'failed', 'TC-002': 'failed', 'TC-003': 'failed' } },
    });
    cleanups.push(s.remove);
    expect(scoreSuite(await loadSuite(s.dir), variants).golden).toEqual({ failures: 2, diagnosedAppDefect: 1, falseAlarmRate: 0.5 });
  });
});

describe('cost, time and aggregation', () => {
  it('sums analysis cost and time per suite', async () => {
    const variants = variantsFile([code('bug-001', FILE, [10, 12])]);
    const s = await suite({ 'bug-001': { tests: { 'TC-001': 'failed', 'TC-002': 'passed', 'TC-003': 'passed' }, durationMs: 90_000, diagnoses: [{ tests: ['TC-001'], classification: 'app_defect', confidence: 0.9, costUsd: 0.02, location: { file: FILE, lines: [10, 10] } }] } });
    const score = scoreSuite(s, variants);
    expect(score.totals.analysisCostUsd).toBeCloseTo(0.02);
    expect(score.totals.analysisMs).toBe(1000);
    expect(score.totals.executionMsMean).toBe(90_000); // variants only, golden excluded
  });

  it('gives mean, range and sample standard deviation over suites, skipping suites without a denominator', () => {
    expect(spread([0.5, 0.75, 1])).toMatchObject({ n: 3, mean: 0.75, min: 0.5, max: 1 });
    expect(spread([0.5, 0.75, 1]).sd).toBeCloseTo(0.25);
    expect(spread([0.5, null, 1])).toMatchObject({ n: 2, mean: 0.75 });
    expect(spread([0.5])).toMatchObject({ n: 1, sd: null });
    expect(spread([null, null])).toMatchObject({ n: 0, mean: null });
  });

  it('counts, per variant, the suites that caught it and lists the ones no suite caught', async () => {
    const variants = variantsFile([code('bug-001', FILE, [10, 12]), code('bug-002', FILE, [20, 20])]);
    const hit = { tests: { 'TC-001': 'failed' as const, 'TC-002': 'passed' as const, 'TC-003': 'passed' as const } };
    const miss = { tests: { 'TC-001': 'passed' as const, 'TC-002': 'passed' as const, 'TC-003': 'passed' as const } };
    const scores = [
      scoreSuite(await suite({ 'bug-001': hit, 'bug-002': miss }, 'r1'), variants),
      scoreSuite(await suite({ 'bug-001': miss, 'bug-002': miss }, 'r2'), variants),
      scoreSuite(await suite({ 'bug-001': hit, 'bug-002': miss }, 'r3'), variants),
    ];
    const agg = aggregate(scores);
    expect(agg.variants.find((v) => v.version === 'bug-001')).toMatchObject({ caughtInSuites: 2, caught: [true, false, true] });
    expect(agg.caughtByNoSuite).toEqual(['bug-002']);
    expect(agg.rates.mutationScoreRaw).toMatchObject({ values: [0.5, 0, 0.5] });
  });
});

describe('runScoring', () => {
  it('writes scores.json and scores.md with the protocol hash and prints no diagnosis text', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'awt-scoring-root-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, 'PROTOCOL.md'), 'rules\n');
    await writeFile(path.join(root, 'equivalents.json'), JSON.stringify({ equivalents: [{ id: 'bug-002', reason: 'dead branch' }] }));
    const variants = variantsFile([code('bug-001', FILE, [10, 12]), code('bug-002', FILE, [20, 20])]);
    await writeFile(path.join(root, 'variants.json'), JSON.stringify(variants));
    const s = await suite({
      'bug-001': { tests: { 'TC-001': 'failed', 'TC-002': 'passed', 'TC-003': 'passed' }, diagnoses: [{ tests: ['TC-001'], classification: 'app_defect', confidence: 0.9, location: { file: FILE, lines: [10, 10] } }] },
      'bug-002': { tests: { 'TC-001': 'passed', 'TC-002': 'passed', 'TC-003': 'passed' } },
    });
    const result = await runScoring({ suites: [s.runDir], variantsFile: path.join(root, 'variants.json'), equivalentsFile: path.join(root, 'equivalents.json'), out: path.join(root, 'out') }, root);
    const json = JSON.parse(await readFile(path.join(root, 'out', 'scores.json'), 'utf8'));
    expect(json.protocolSha256).toBe(result.protocolSha256);
    expect(json.aggregate.rates.mutationScoreAdjusted.mean).toBe(1);
    expect(await readFile(path.join(root, 'out', 'scores.md'), 'utf8')).toContain('Mutation score (raw');
    expect(JSON.stringify(json)).not.toContain('rootCause');
  });
});
