import { describe, expect, it } from 'vitest';
// @ts-expect-error plain browser module
import { planReplay, viewAt } from '../public/replay.js';

const stage = (key: string, ms: number) => ({ key, label: key, status: 'done', elapsedMs: ms, runningSince: null, error: '' });
const view = () => ({
  run: { workMs: 0, mode: 'full' },
  stages: [stage('prd', 60000), stage('cases', 60000), stage('scripts', 120000), stage('gaps', 30000), stage('execute', 0), stage('analyze', 0)],
  prd: { requirements: 2 },
  cases: { total: 4, api: 2, browser: 2, list: [{ id: 'TC-1' }, { id: 'TC-2' }, { id: 'TC-3' }, { id: 'TC-4' }] },
  scripts: { totals: {}, list: [{ id: 'TC-1', status: 'passed' }, { id: 'TC-2', status: 'invalid' }, { id: 'TC-3', status: 'passed' }, { id: 'TC-4', status: 'repaired' }] },
  coverage: { reached: 1, total: 2 },
  executions: [{ execId: 'x-01', label: 'bug-001', kind: 'code', executeStatus: 'done', analyzeStatus: 'done', startedAt: '2026-11-01T10:00:00Z', durationMs: 100000, analysisMs: 20000, total: 4, done: 4, passed: 3, failed: 1, errored: 0, seq: 'pppf' }],
  diagnoses: [{ execId: 'x-01', label: 'bug-001', mode: 'full', items: [{ id: 'DX-1' }, { id: 'DX-2' }] }],
});

describe('replay', () => {
  it('plans stages, then each execution followed by its analysis', () => {
    const plan = planReplay(view());
    expect(plan.segments.map((s: { type: string }) => s.type)).toEqual(['stage', 'stage', 'stage', 'stage', 'exec', 'diag']);
    expect(plan.total).toBe(60000 + 60000 + 120000 + 30000 + 100000 + 20000);
  });

  it('shows nothing before it starts and everything at the end', () => {
    const v = view();
    const plan = planReplay(v);
    const start = viewAt(v, plan, 0);
    expect(start.prd).toBeNull();
    expect(start.executions).toHaveLength(0);
    expect(start.stages.every((s: { status: string }) => s.status === 'pending')).toBe(true);
    const end = viewAt(v, plan, plan.total);
    expect(end.stages.every((s: { status: string }) => s.status === 'done')).toBe(true);
    expect(end.executions[0].analyzeStatus).toBe('done');
    expect(end.diagnoses[0].items).toHaveLength(2);
    expect(end.replay.finished).toBe(true);
  });

  it('reveals scripts and test results in recorded order while a stage runs', () => {
    const v = view();
    const plan = planReplay(v);
    const mid = viewAt(v, plan, 120000 + 60000); // half way through scripts
    expect(mid.scripts.list).toHaveLength(2);
    expect(mid.scripts.totals).toMatchObject({ passed: 1, invalid: 1, pending: 2 });
    const exec = viewAt(v, plan, 270000 + 50000); // half way through the execution
    expect(exec.executions[0]).toMatchObject({ executeStatus: 'running', done: 2, passed: 2, failed: 0 });
    expect(exec.stages.find((s: { key: string }) => s.key === 'execute').status).toBe('running');
    expect(exec.run.mode).toBeNull();
  });
});
