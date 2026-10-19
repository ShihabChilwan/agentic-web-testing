import { describe, expect, it } from 'vitest';
import { LineRange, LLMCallLogLine, RelPath, RunManifest } from '../../../src/shared/schemas.js';
import { errorPaths, example } from './helpers.js';

describe('building blocks', () => {
  it('accepts relative paths and rejects absolute or escaping ones', () => {
    expect(RelPath.safeParse('server/routes/api/auth.js').success).toBe(true);
    expect(RelPath.safeParse('/etc/passwd').success).toBe(false);
    expect(RelPath.safeParse('C:\\repo\\file.js').success).toBe(false);
    expect(RelPath.safeParse('server/../../secret').success).toBe(false);
  });

  it('accepts 1-based inclusive line ranges only', () => {
    expect(LineRange.safeParse([12, 60]).success).toBe(true);
    expect(LineRange.safeParse([39, 39]).success).toBe(true);
    expect(LineRange.safeParse([0, 5]).success).toBe(false);
    expect(LineRange.safeParse([10, 5]).success).toBe(false);
    expect(LineRange.safeParse([1]).success).toBe(false);
  });
});

describe('llm-calls.jsonl line', () => {
  const line = example('llm-call.json');

  it('accepts the reference example and a failed call with an error', () => {
    expect(LLMCallLogLine.safeParse(line).success).toBe(true);
    const failed = { ...line, ok: false, attempts: 4, outputTokens: 0, error: '503 Service Unavailable' };
    expect(LLMCallLogLine.safeParse(failed).success).toBe(true);
  });

  it('accepts lines without the optional provider fields (older logs, endpoints that report none)', () => {
    const { costSource: _c, cachedInputTokens: _t, reasoningTokens: _r, upstreamProvider: _u, systemFingerprint: _f, ...plain } = line;
    expect(LLMCallLogLine.safeParse({ ...plain, costUsd: null }).success).toBe(true);
    expect(LLMCallLogLine.safeParse({ ...plain, costUsd: null, costSource: null }).success).toBe(true);
  });

  it('rejects an unknown cost source and negative token counts', () => {
    expect(errorPaths(LLMCallLogLine, { ...line, costSource: 'guess' })).toContain('costSource');
    expect(errorPaths(LLMCallLogLine, { ...line, reasoningTokens: -1 })).toContain('reasoningTokens');
  });

  it('requires attempts and a UTC timestamp', () => {
    const { attempts: _a, ...noAttempts } = line;
    expect(errorPaths(LLMCallLogLine, noAttempts)).toContain('attempts');
    expect(errorPaths(LLMCallLogLine, { ...line, ts: '24/10/2026 10:00' })).toContain('ts');
  });
});

describe('run.json', () => {
  const run = example('run.json');

  it('accepts the reference example', () => {
    expect(RunManifest.safeParse(run).success).toBe(true);
  });

  it('accepts run.json with or without upstream providers', () => {
    expect(RunManifest.parse(run).llm.upstreamProviders).toEqual(['Near AI']);
    const r = structuredClone(run);
    delete r.llm.upstreamProviders;
    expect(RunManifest.safeParse(r).success).toBe(true);
    r.llm.upstreamProviders = [''];
    expect(errorPaths(RunManifest, r)).toContain('llm.upstreamProviders.0');
  });

  it('accepts a failed stage and a failed execution with errors', () => {
    const failed = structuredClone(run);
    failed.stages.scripts = { status: 'failed', startedAt: '2026-10-24T10:12:00Z', error: 'LLMBudgetExceededError' };
    failed.executions[0] = { ...failed.executions[0], executeStatus: 'failed', error: 'checkout failed' };
    expect(RunManifest.safeParse(failed).success).toBe(true);
  });

  it('accepts only the prd, cases and scripts stages', () => {
    const r = structuredClone(run);
    r.stages.execute = { status: 'done' };
    expect(errorPaths(RunManifest, r)).toContain('stages');
  });

  it('requires executeStatus and analyzeStatus, without stale', () => {
    const r = structuredClone(run);
    delete r.executions[0].executeStatus;
    r.executions[0].analyzeStatus = 'stale';
    expect(errorPaths(RunManifest, r)).toEqual(
      expect.arrayContaining(['executions.0.executeStatus', 'executions.0.analyzeStatus']),
    );
  });

  it('rejects unknown stage statuses and malformed run ids', () => {
    const r = structuredClone(run);
    r.stages.prd.status = 'ok';
    r.runId = 'mern-ecommerce-2026-10-24';
    expect(errorPaths(RunManifest, r)).toEqual(expect.arrayContaining(['stages.prd.status', 'runId']));
  });
});
