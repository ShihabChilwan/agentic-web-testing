import { describe, expect, it } from 'vitest';
import { ExecutionRequest, ExecutionResults } from '../../../src/shared/schemas.js';
import { errorPaths, example } from './helpers.js';

describe('execution request', () => {
  it('accepts a config override where null removes a variable', () => {
    const request = {
      execId: 'x-02',
      ref: 'golden',
      configOverride: { backend: { env: { JWT_SECRET: null, PORT: '3000' } }, lifecycle: { startupTimeoutMs: 1000 } },
    };
    expect(ExecutionRequest.safeParse(request).success).toBe(true);
  });

  it('rejects overrides of fields other than env and startupTimeoutMs', () => {
    const request = { execId: 'x-02', ref: 'golden', configOverride: { backend: { start: 'node evil.js' } } };
    expect(errorPaths(ExecutionRequest, request)).toContain('configOverride.backend');
  });
});

describe('results.json', () => {
  const results = example('results.json');

  it('accepts the reference example', () => {
    expect(ExecutionResults.safeParse(results).success).toBe(true);
  });

  it('accepts one-prompt ablation ids and a seed request with no response', () => {
    const r = structuredClone(results);
    r.results[0].testCaseId = 'OP-001';
    r.environment.seed[0] = { request: 'POST /api/auth/register', status: null, ok: false };
    expect(ExecutionResults.safeParse(r).success).toBe(true);
  });

  it('accepts results with or without a seed check, including one with no response', () => {
    const r = structuredClone(results);
    expect(ExecutionResults.parse(r).environment.seedCheck).toEqual({ ok: true, status: 200, detail: 'ok' });
    r.environment.seedCheck = { ok: false, status: null, detail: 'no response (connect ECONNREFUSED)' };
    expect(ExecutionResults.safeParse(r).success).toBe(true);
    delete r.environment.seedCheck;
    expect(ExecutionResults.safeParse(r).success).toBe(true);
    r.environment.seedCheck = { ok: false, status: 200 };
    expect(errorPaths(ExecutionResults, r)).toContain('environment.seedCheck.detail');
  });

  it('rejects unknown statuses and unsafe execution ids', () => {
    const r = structuredClone(results);
    r.results[0].status = 'skipped';
    r.execId = '../golden';
    expect(errorPaths(ExecutionResults, r)).toEqual(expect.arrayContaining(['results.0.status', 'execId']));
  });
});

describe('older results.json', () => {
  it('reads a results.json written before isolation, skipped and incidents existed, never assuming isolation', async () => {
    const { readFile } = await import('node:fs/promises');
    const raw = JSON.parse(await readFile(new URL('../../fixtures/older/results-before-isolation.json', import.meta.url), 'utf8'));
    const parsed = ExecutionResults.parse(raw);
    expect(parsed.summary).toMatchObject({ skipped: 0, notIsolated: 0 });
    expect(parsed.skipped).toEqual([]);
    expect(parsed.incidents).toEqual([]);
    expect(parsed.results[0]?.isolated).toBe(false);
  });

  it('rejects an unknown incident kind or result category', () => {
    const r = structuredClone(example('results.json'));
    r.incidents[0].kind = 'meteor-strike';
    r.results[0].error.category = 'bad-luck';
    expect(errorPaths(ExecutionResults, r)).toEqual(expect.arrayContaining(['incidents.0.kind', 'results.0.error.category']));
  });
});
