import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeRunAll, runAll, type StageFunctions } from '../src/modules/pipeline.js';
import { parseLLMConfig } from '../src/shared/config.js';
import { runPaths } from '../src/shared/paths.js';
import { createRun, llmSettings, readRunManifest, setExecution, setStage } from '../src/shared/run-manifest.js';
import { example } from './shared/schemas/helpers.js';

// runAll with fake stage functions that only write the files and run.json states the real ones would.

const COMMIT = 'abc1234def5678abc1234def5678abc1234def56';
const llm = llmSettings(parseLLMConfig({ LLM_BASE_URL: 'http://model.test/v1' }));
let runsDir: string;
let calls: string[];

beforeEach(async () => {
  runsDir = await mkdtemp(path.join(tmpdir(), 'awt-all-'));
  calls = [];
  clock = 0;
});

afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

const at = (min: number) => new Date(Date.UTC(2026, 9, 24, 10, min)).toISOString();
// A clock that moves one minute per stage, so later stages always finish after earlier ones.
let clock = 0;
const tick = () => at(++clock);
const results = (execId: string, startedAt: string) => ({
  schemaVersion: '1.0', execId, startedAt, finishedAt: startedAt,
  environment: { healthChecks: [], seed: [] }, summary: { total: 1, passed: 1, failed: 0, errored: 0, skipped: 0, notIsolated: 0 }, results: [],
});

async function writeExecution(dir: string, execId: string, startedAt: string, extra: Record<string, unknown> = {}) {
  const paths = runPaths(path.basename(dir), path.dirname(dir));
  await mkdir(paths.executionDir(execId), { recursive: true });
  await writeFile(paths.results(execId), JSON.stringify(results(execId, startedAt)));
  await setExecution(dir, { execId, ref: 'golden', commit: COMMIT, executeStatus: 'done', analyzeStatus: 'pending', ...extra });
}

function fakes(fail?: string, gaps: { configured: boolean; added: number } = { configured: false, added: 0 }): StageFunctions {
  const dirOf = (runId: string) => runPaths(runId, runsDir).dir;
  const step = (name: string) => {
    calls.push(name);
    if (name === fail) throw new Error(`${name} exploded`);
  };
  return {
    generatePrd: (async (o: { target: string; onRunCreated?: (d: string) => void }) => {
      const { runId, paths } = await createRun({ target: o.target, generationRef: 'golden', generationCommit: COMMIT, llm, runsDir, now: new Date(Date.parse(tick()) + 3_600_000) });
      o.onRunCreated?.(paths.dir);
      step('prd');
      await writeFile(paths.prd, '{}');
      await setStage(paths.dir, 'prd', { status: 'done', startedAt: tick(), finishedAt: tick() });
      return { runId };
    }) as never,
    generateTestCases: (async (o: { runId: string }) => {
      step('cases');
      await setStage(dirOf(o.runId), 'cases', { status: 'done', startedAt: tick(), finishedAt: tick() });
    }) as never,
    generateScripts: (async (o: { runId: string; redo?: string[] }) => {
      step(o.redo ? `scripts(redo ${o.redo.join(',') || 'none'})` : 'scripts');
      await setStage(dirOf(o.runId), 'scripts', { status: 'done', startedAt: tick(), finishedAt: tick() });
    }) as never,
    coverageConfigured: async () => gaps.configured,
    generateGaps: (async (o: { runId: string }) => {
      step('gaps');
      const summary = { endpoints: { total: 10, reached: 7 }, unreached: [], asked: [], casesAdded: gaps.added, sessions: 1, calls: 1, rejected: { invalidInput: 0, checkFailed: 0 }, costUsd: null, warnings: [] };
      await setStage(dirOf(o.runId), 'gaps', { status: 'done', startedAt: tick(), finishedAt: tick(), gaps: summary });
      if (gaps.added > 0) await setStage(dirOf(o.runId), 'scripts', { status: 'pending' });
      return { added: Array.from({ length: gaps.added }, (_, i) => `TC-10${i}`) };
    }) as never,
    executeRun: (async (o: { runId: string }) => {
      step('execute');
      const execId = `x-0${(await readRunManifest(runPaths(o.runId, runsDir).runJson)).executions.length + 1}`;
      const startedAt = tick();
      await writeExecution(dirOf(o.runId), execId, startedAt);
      return { execId, results: results(execId, startedAt) };
    }) as never,
    analyzeExecution: (async (o: { runId: string; execId: string }) => {
      step('analyze');
      const paths = runPaths(o.runId, runsDir);
      await writeFile(paths.diagnoses(o.execId), JSON.stringify({ ...example('diagnoses.json'), execId: o.execId, diagnoses: [], summary: { groups: 0, sessions: 0, failedSessions: 0, calls: 0, toolCalls: 0, costUsd: null, durationMs: 5 } }));
      const entry = (await readRunManifest(paths.runJson)).executions.find((e) => e.execId === o.execId)!;
      await setExecution(paths.dir, { ...entry, analyzeStatus: 'done' });
    }) as never,
  };
}

const actions = (r: Awaited<ReturnType<typeof runAll>>) => r.stages.map((s) => `${s.stage}:${s.action}`);

describe('runAll', () => {
  it('runs every stage for a new target, then reuses all of them on the next call', async () => {
    const first = await runAll({ target: 'shop', runsDir, stages: fakes() });
    expect(calls).toEqual(['prd', 'cases', 'scripts', 'execute', 'analyze']);
    expect(actions(first)).toEqual(['prd:ran', 'cases:ran', 'scripts:ran', 'gaps:skipped', 'execute:ran', 'analyze:ran']);
    expect(first.failure).toBeNull();
    calls = [];
    const again = await runAll({ target: 'shop', runsDir, stages: fakes() });
    expect(calls).toEqual([]);
    expect(again.runId).toBe(first.runId);
    expect(actions(again)).toEqual(['prd:reused', 'cases:reused', 'scripts:reused', 'gaps:skipped', 'execute:reused', 'analyze:reused']);
    expect(again.stages[0]).toMatchObject({ durationMs: 60_000 });
    expect(again.stages[4]?.detail).toBe('x-01: 1 passed, 0 failed, 0 errored, 0 skipped');
  });

  it('reruns a stale stage and everything after it, because the execution is then older than the scripts', async () => {
    const first = await runAll({ target: 'shop', runsDir, stages: fakes() });
    await setStage(runPaths(first.runId!, runsDir).dir, 'scripts', { status: 'stale' });
    calls = [];
    const again = await runAll({ runId: first.runId!, runsDir, stages: fakes() });
    expect(calls).toEqual(['scripts', 'execute', 'analyze']);
    expect(actions(again)).toEqual(['prd:reused', 'cases:reused', 'scripts:ran', 'gaps:skipped', 'execute:ran', 'analyze:ran']);
    expect(again.stages[4]?.detail).toMatch(/^x-02:/);
  });

  it('never reuses a patched or seed-skipped execution as the golden one', async () => {
    const first = await runAll({ target: 'shop', runsDir, stages: fakes('execute') });
    const dir = runPaths(first.runId!, runsDir).dir;
    await writeExecution(dir, 'x-01', tick(), { patch: 'targets/shop/dev-bugs/a.patch' });
    await writeExecution(dir, 'x-02', tick(), { skipSeed: true });
    calls = [];
    await runAll({ runId: first.runId!, runsDir, stages: fakes() });
    expect(calls).toEqual(['execute', 'analyze']);
  });

  it('stops at the first failing stage and says how to continue', async () => {
    const result = await runAll({ target: 'shop', runsDir, stages: fakes('scripts') });
    expect(actions(result)).toEqual(['prd:ran', 'cases:ran', 'scripts:failed', 'gaps:not-run', 'execute:not-run', 'analyze:not-run']);
    expect(result.failure).toEqual({ stage: 'scripts', error: 'Error: scripts exploded', next: `npm run agent -- all --run ${result.runId}` });
    const lines = describeRunAll(result);
    expect(lines.at(-1)).toBe(`To continue: npm run agent -- all --run ${result.runId}`);
    expect(result.suspectedDefects).toEqual([]);
    const defect = { testCaseId: 'TC-068', title: 't', requirements: [{ id: 'REQ-001', statement: null }], expectationId: 'E1', expectation: 'Status 403', expected: '403', received: '200', message: '', review: null };
    expect(describeRunAll({ ...result, suspectedDefects: [defect] })).toContain('  TC-068 E1 (REQ-001) "Status 403": expected 403, got 200');
  });

  it('--fresh starts a new run of the same target', async () => {
    const first = await runAll({ target: 'shop', runsDir, stages: fakes() });
    calls = [];
    const fresh = await runAll({ runId: first.runId!, fresh: true, runsDir, stages: fakes() });
    expect(calls).toEqual(['prd', 'cases', 'scripts', 'execute', 'analyze']);
    expect(fresh.runId).not.toBe(first.runId);
    expect((await readRunManifest(runPaths(fresh.runId!, runsDir).runJson)).target).toBe('shop');
  });

  it('with coverage configured, runs the gaps stage once and then scripts for the new cases only, before executing', async () => {
    const first = await runAll({ target: 'shop', runsDir, stages: fakes(undefined, { configured: true, added: 3 }) });
    expect(calls).toEqual(['prd', 'cases', 'scripts', 'gaps', 'scripts(redo none)', 'execute', 'analyze']);
    expect(actions(first)).toEqual(['prd:ran', 'cases:ran', 'scripts:ran', 'gaps:ran', 'execute:ran', 'analyze:ran']);
    expect(first.stages[3]?.detail).toBe('endpoints reached 7/10; +3 test cases');
    calls = [];
    const again = await runAll({ runId: first.runId!, runsDir, stages: fakes(undefined, { configured: true, added: 3 }) });
    expect(calls).toEqual([]);
    expect(actions(again)[3]).toBe('gaps:reused');
  });

  it('after an interrupted gaps-caused scripts run, resumes the scripts keeping every earlier outcome', async () => {
    const first = await runAll({ target: 'shop', runsDir, stages: fakes(undefined, { configured: true, added: 0 }) });
    expect(calls).toEqual(['prd', 'cases', 'scripts', 'gaps', 'execute', 'analyze']);
    await setStage(runPaths(first.runId!, runsDir).dir, 'scripts', { status: 'pending' });
    calls = [];
    await runAll({ runId: first.runId!, runsDir, stages: fakes(undefined, { configured: true, added: 0 }) });
    expect(calls).toEqual(['scripts(redo none)', 'execute', 'analyze']);
  });

  it('needs a target when there is no run to continue', async () => {
    await expect(runAll({ runsDir, stages: fakes() })).rejects.toThrow('give --target');
  });

  it('a run whose prd stage failed starts a new run', async () => {
    const { runId, paths } = await createRun({ target: 'shop', generationRef: 'golden', generationCommit: COMMIT, llm, runsDir, now: new Date(Date.UTC(2026, 9, 24, 9)) });
    await setStage(paths.dir, 'prd', { status: 'failed', error: 'x' });
    const result = await runAll({ runId, runsDir, stages: fakes() });
    expect(result.runId).not.toBe(runId);
    expect(calls[0]).toBe('prd');
    expect(JSON.parse(await readFile(runPaths(result.runId!, runsDir).runJson, 'utf8')).stages.prd.status).toBe('done');
  });
});
