import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestIsolation } from '../../src/modules/execution-engine/isolation.js';
import type { RestoreResult } from '../../src/modules/execution-engine/lifecycle.js';
import type { ExitInfo } from '../../src/modules/execution-engine/processes.js';

// TestIsolation against a fake target: each restore's outcome and each service's state is scripted.

type Outcome = RestoreResult | Error;
const ok: RestoreResult = { durationMs: 1, via: 'full', backendHealthy: true, problems: [] };
const unhealthy: RestoreResult = { durationMs: 1, via: 'full', backendHealthy: false, problems: ['the backend did not become healthy again'] };

function fakeTarget(outcomes: Outcome[]) {
  const state = {
    restores: 0,
    frontendRestarts: 0,
    exits: { backend: null as ExitInfo | null, frontend: null as ExitInfo | null },
    frontendRestartOk: true,
  };
  const target = {
    restore: async () => {
      const outcome = outcomes[state.restores++] ?? ok;
      if (outcome instanceof Error) throw outcome;
      state.exits.backend = null; // the restore restarts the backend
      return outcome;
    },
    restartFrontend: async () => {
      state.frontendRestarts++;
      if (state.frontendRestartOk) state.exits.frontend = null;
      return { name: 'frontend', url: 'http://127.0.0.1:1', ok: state.frontendRestartOk, elapsedMs: 1 };
    },
    exitOf: (name: 'backend' | 'frontend') => state.exits[name],
  };
  return { target, state };
}

let backendLog: string;

beforeEach(async () => {
  backendLog = path.join(await mkdtemp(path.join(tmpdir(), 'awt-isolation-')), 'backend.log');
  await writeFile(backendLog, 'start-up lines\n');
});

afterEach(async () => {
  await rm(path.dirname(backendLog), { recursive: true, force: true });
});

const make = (target: ReturnType<typeof fakeTarget>['target'], frontendUp = async () => true) =>
  new TestIsolation(target, { backendLog, frontendHealthUrl: 'http://127.0.0.1:1', frontendUp });

describe('TestIsolation without a frontend (a one-process app)', () => {
  it('checks and restarts nothing for a frontend, and still restores before each test', async () => {
    const { target, state } = fakeTarget([]);
    state.exits.frontend = { code: 1, signal: null }; // would be restarted if there were a frontend
    const iso = new TestIsolation(target, { backendLog });
    await iso.before('TC-001');
    await iso.after('TC-001', '/out/TC-001');
    expect(state.frontendRestarts).toBe(0);
    expect(state.restores).toBe(1);
    expect(iso.incidents).toEqual([]);
    expect(iso.records.get('TC-001')?.isolated).toBe(true);
  });
});

describe('TestIsolation', () => {
  it('restores before every test and marks each isolated, with its own backend log range', async () => {
    const { target, state } = fakeTarget([]);
    const iso = make(target);
    await iso.before('TC-001');
    await appendFile(backendLog, 'GET /api/items\n');
    await iso.after('TC-001', '/out/TC-001');
    await iso.before('TC-002');
    await iso.after('TC-002', '/out/TC-002');
    expect(state.restores).toBe(2);
    expect(iso.restores).toBe(2);
    expect(iso.records.get('TC-001')).toEqual({ isolated: true, logStart: 15, logEnd: 30, outputDir: '/out/TC-001' });
    expect(iso.records.get('TC-002')).toMatchObject({ isolated: true, logStart: 30, logEnd: 30 });
    expect(iso.incidents).toEqual([]);
  });

  it('a failed restore marks that test not isolated; a success afterwards resets the count', async () => {
    const { target } = fakeTarget([new Error('Reset command failed (exit 3)'), ok, unhealthy, ok]);
    const iso = make(target);
    for (const id of ['TC-001', 'TC-002', 'TC-003', 'TC-004']) await iso.before(id);
    expect([...iso.records.values()].map((r) => r.isolated)).toEqual([false, true, false, true]);
    expect(iso.givenUp).toBe(false);
    expect(iso.incidents.map((i) => [i.beforeTestCaseId, i.kind])).toEqual([
      ['TC-001', 'restore-failed'],
      ['TC-003', 'restore-failed'],
    ]);
    expect(iso.incidents[0]?.detail).toBe('Reset command failed (exit 3)');
  });

  it('after 2 failed restores in a row, restores stop and every later test is not isolated', async () => {
    const { target, state } = fakeTarget([ok, new Error('Reset command failed (exit 3)'), unhealthy]);
    const iso = make(target);
    for (const id of ['TC-001', 'TC-002', 'TC-003', 'TC-004', 'TC-005']) await iso.before(id);
    expect(state.restores).toBe(3); // none after giving up
    expect(iso.givenUp).toBe(true);
    expect([...iso.records.values()].map((r) => r.isolated)).toEqual([true, false, false, false, false]);
    expect(iso.incidents.map((i) => [i.beforeTestCaseId, i.kind])).toEqual([
      ['TC-002', 'restore-failed'],
      ['TC-003', 'restore-failed'],
      ['TC-003', 'restores-given-up'],
    ]);
  });

  it('seed problems on a restore are recorded, and the test stays isolated', async () => {
    const { target } = fakeTarget([{ durationMs: 1, via: 'full', backendHealthy: true, problems: ['seed check failed: empty'] }]);
    const iso = make(target);
    await iso.before('TC-001');
    expect(iso.records.get('TC-001')?.isolated).toBe(true);
    expect(iso.incidents).toEqual([{ beforeTestCaseId: 'TC-001', kind: 'restore-problem', detail: 'seed check failed: empty' }]);
  });

  it('records a backend that crashed during the previous test (or the last one)', async () => {
    const { target, state } = fakeTarget([]);
    const iso = make(target);
    await iso.before('TC-001');
    state.exits.backend = { code: 1, signal: null };
    await iso.before('TC-002');
    expect(iso.records.get('TC-002')?.isolated).toBe(true); // the restore started it again
    state.exits.backend = { code: null, signal: 'SIGKILL' };
    iso.finish();
    expect(iso.incidents).toEqual([
      { beforeTestCaseId: 'TC-002', kind: 'backend-crashed', detail: 'the backend process had exited (code 1)' },
      { beforeTestCaseId: null, kind: 'backend-crashed', detail: 'the backend process had exited (signal SIGKILL)' },
    ]);
  });

  it('restarts a frontend that exited or stopped answering; stops trying after 2 failed restarts in a row', async () => {
    const { target, state } = fakeTarget([]);
    let up = true;
    const iso = make(target, async () => up);
    await iso.before('TC-001');
    expect(state.frontendRestarts).toBe(0);

    state.exits.frontend = { code: 1, signal: null };
    await iso.before('TC-002');
    expect(state.frontendRestarts).toBe(1);

    up = false;
    state.frontendRestartOk = false;
    await iso.before('TC-003');
    await iso.before('TC-004');
    await iso.before('TC-005');
    expect(state.frontendRestarts).toBe(3); // TC-002, TC-003, TC-004; none for TC-005
    expect(iso.incidents.map((i) => [i.beforeTestCaseId, i.kind])).toEqual([
      ['TC-002', 'frontend-restarted'],
      ['TC-003', 'frontend-restart-failed'],
      ['TC-004', 'frontend-restart-failed'],
    ]);
    expect(iso.incidents[2]?.detail).toMatch(/no further restarts$/);
    expect(iso.records.get('TC-005')?.isolated).toBe(true); // the data restore does not depend on the frontend
  });

  it('refuses /after without /before', async () => {
    const iso = make(fakeTarget([]).target);
    await expect(iso.after('TC-009', '/out')).rejects.toThrow(/without \/before/);
  });
});
