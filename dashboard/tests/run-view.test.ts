import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildView, listRuns, listVariants, resolveVariantPatch } from '../run-view.js';

let root: string;
const w = (rel: string, data: unknown) => mkdir(path.dirname(path.join(root, rel)), { recursive: true }).then(() => writeFile(path.join(root, rel), typeof data === 'string' ? data : JSON.stringify(data)));

beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'dash-test-')); });
afterEach(() => rm(root, { recursive: true, force: true }));

const manifest = (runningExec = false) => ({
  target: 'demo', createdAt: '2026-11-01T10:00:00.000Z', generationRef: 'golden', generationCommit: 'abc',
  llm: { models: { scripts: 'vendor/model-x', other: 'vendor/model-x' }, reasoningEffort: {} },
  stages: {
    prd: { status: 'done', startedAt: '2026-11-01T10:00:00.000Z', finishedAt: '2026-11-01T10:04:00.000Z' },
    cases: { status: 'done', startedAt: '2026-11-01T10:04:00.000Z', finishedAt: '2026-11-01T10:06:00.000Z' },
    scripts: { status: 'running', startedAt: '2026-11-01T10:06:00.000Z', scripts: { removedExpectations: [{}] } },
  },
  executions: [{ execId: 'x-01', ref: 'golden', commit: 'abc', executeStatus: runningExec ? 'running' : 'done', analyzeStatus: 'pending' }],
});

describe('feature rows', () => {
  it('links endpoints to features by evidence and marks reach only when coverage was recorded', async () => {
    await w('r2/run.json', manifest());
    const ev = (file: string, a: number, b: number) => ({ file, lines: [a, b] });
    await w('r2/prd.json', {
      features: [{ id: 'F-01', name: 'Login' }, { id: 'F-02', name: 'Cart' }],
      requirements: [
        { id: 'REQ-001', featureId: 'F-01', statement: 'Users log in.', priority: 'high', acceptanceCriteria: [{ text: 'POST /api/auth/login works', evidence: [ev('a.js', 1, 10)] }] },
        { id: 'REQ-002', featureId: 'F-02', statement: 'Cart.', priority: 'low', acceptanceCriteria: [{ text: 'adds', evidence: [ev('c.js', 5, 9)] }] },
      ],
      apiEndpoints: [
        { method: 'POST', path: '/api/auth/login', evidence: [ev('a.js', 4, 8)] },
        { method: 'GET', path: '/api/cart', evidence: [ev('c.js', 1, 6)] },
        { method: 'GET', path: '/api/lonely', evidence: [ev('z.js', 1, 2)] },
      ],
      uiRoutes: [],
    });
    await w('r2/testcases.json', { testCases: [{ id: 'TC-001', title: 'a', layer: 'api', category: 'functional', priority: 'high', requirementIds: ['REQ-001'] }] });
    let v = await buildView('r2', { runsDir: root });
    expect(v.prd.reachRecorded).toBe(false);
    expect(v.prd.featureRows[0]).toMatchObject({ name: 'Login', tests: 1, endpoints: [{ path: '/api/auth/login', reached: null }] });
    expect(v.prd.featureRows[1].endpoints).toHaveLength(1);
    expect(v.prd.otherEndpoints).toEqual([{ method: 'GET', path: '/api/lonely', reached: null }]);
    await w('r2/coverage/coverage.json', { endpoints: [{ method: 'POST', path: '/api/auth/login', reached: true }, { method: 'GET', path: '/api/cart', reached: false }, { method: 'GET', path: '/api/lonely', observed: true }] });
    v = await buildView('r2', { runsDir: root });
    expect(v.prd.reachRecorded).toBe(true);
    expect(v.prd.featureRows.map((r: { endpoints: Array<{ reached: boolean }> }) => r.endpoints[0]!.reached)).toEqual([true, false]);
    expect(v.prd.otherEndpoints[0].reached).toBe(true);
  });
});

describe('buildView', () => {
  it('reads stages, scripts and cases of a run that is still writing scripts', async () => {
    await w('r1/run.json', manifest());
    await w('r1/prd.json', { features: [{ id: 'F-01', name: 'Login' }], apiEndpoints: [{}, {}], uiRoutes: [{}], requirements: [{ id: 'REQ-001', featureId: 'F-01' }] });
    await w('r1/testcases.json', { testCases: [
      { id: 'TC-001', title: 'a', layer: 'api', category: 'functional', priority: 'high', requirementIds: ['REQ-001'] },
      { id: 'TC-002', title: 'b', layer: 'ui', category: 'functional', priority: 'high', requirementIds: ['REQ-001'] },
      { id: 'TC-003', title: 'c', layer: 'ui', category: 'auth', priority: 'low', requirementIds: [] },
    ] });
    await w('r1/scripts/manifest.json', { scripts: [
      { testCaseId: 'TC-001', status: 'validated', validationOutcome: 'passed', attempts: 1, failureCategory: null },
      { testCaseId: 'TC-002', status: 'validated', validationOutcome: 'passed', attempts: 3, failureCategory: null },
    ] });
    const v = await buildView('r1', { runsDir: root });
    expect(v.run.model).toBe('vendor/model-x');
    expect(v.stages.find((s: { key: string }) => s.key === 'prd').elapsedMs).toBe(240000);
    expect(v.stages.find((s: { key: string }) => s.key === 'scripts').runningSince).toBe('2026-11-01T10:06:00.000Z');
    expect(v.prd).toMatchObject({ features: 1, endpoints: 2, uiRoutes: 1, requirements: 1 });
    expect(v.cases).toMatchObject({ total: 3, api: 1, browser: 2 });
    expect(v.cases.list[0].feature).toBe('Login');
    expect(v.scripts.totals).toMatchObject({ passed: 1, repaired: 1, pending: 1, total: 3 });
  });

  it('reads live progress of a running execution from playwright.log', async () => {
    await w('r2/run.json', manifest(true));
    await w('r2/executions/x-01/playwright.log', ['', 'Running 10 tests using 1 worker', '', '[1/10] a', '[2/10] b', '  1) [chromium] › x', '[3/10] c', ''].join('\n'));
    const v = await buildView('r2', { runsDir: root });
    expect(v.executions[0]).toMatchObject({ total: 10, done: 2, failed: 1, passed: 1, label: 'golden', executeStatus: 'running' });
  });

  it('takes a finished execution from results.json and shows only the variant id', async () => {
    const m = manifest();
    (m.executions[0] as Record<string, unknown>).patch = 'targets/demo/variants/bug-004.patch';
    await w('r3/run.json', m);
    await w('r3/executions/x-01/results.json', { startedAt: '2026-11-01T11:00:00.000Z', finishedAt: '2026-11-01T11:04:00.000Z', summary: { total: 3, passed: 2, failed: 1, errored: 0, skipped: 1 }, results: [{ status: 'passed' }, { status: 'failed' }, { status: 'passed' }], incidents: [] });
    await w('r3/executions/x-01/diagnoses.json', { mode: 'no-tools', generatedAt: 'x', summary: { durationMs: 5000 }, diagnoses: [{ id: 'DX-001', testCaseIds: ['TC-1'], classification: 'app_defect', confidence: 0.9, summary: 's', rootCause: 'r', location: { file: 'a.js', lines: [1, 2] }, evidence: [], suggestedFix: { description: 'f' } }] });
    const v = await buildView('r3', { runsDir: root });
    expect(v.executions[0]).toMatchObject({ label: 'bug-004', kind: 'code', passed: 2, failed: 1, seq: 'pfp', durationMs: 240000 });
    expect(v.run.mode).toBe('no-tools');
    expect(v.diagnoses[0].items[0].location).toEqual({ file: 'a.js', lines: [1, 2] });
  });

  it('rejects a run id that tries to leave the runs folder', async () => {
    expect(await buildView('../etc', { runsDir: root })).toBeNull();
  });
});

describe('variants', () => {
  it('lists ids only and resolves a patch inside the targets folder', async () => {
    await w('targets/demo/variants.json', { variants: [
      { id: 'bug-001', kind: 'code', patch: 'variants/bug-001.patch', file: 'secret.js', lines: [1, 1], original: 'a', mutated: 'b', description: 'secret' },
      { id: 'env-01', kind: 'environment', description: 'secret env' },
    ] });
    await w('targets/demo/variants/bug-001.patch', 'diff');
    const list = await listVariants('demo', path.join(root, 'targets'));
    expect(list).toEqual([{ value: 'draw:bug-001', id: 'bug-001', group: 'draw' }]);
    expect(JSON.stringify(list)).not.toMatch(/secret|patch|mutated/);
    expect(await resolveVariantPatch('demo', 'draw:bug-001', path.join(root, 'targets'))).toMatch(/variants\/bug-001\.patch$/);
    expect(await resolveVariantPatch('demo', 'draw:env-01', path.join(root, 'targets'))).toBeNull();
  });
});

describe('listRuns', () => {
  it('skips folders without a run.json and sorts newest first', async () => {
    await w('a/run.json', { ...manifest(), createdAt: '2026-11-01T10:00:00.000Z' });
    await w('b/run.json', { ...manifest(), createdAt: '2026-11-02T10:00:00.000Z' });
    await mkdir(path.join(root, 'cloud'), { recursive: true });
    expect((await listRuns(root)).map((r) => r.id)).toEqual(['b', 'a']);
  });
});
