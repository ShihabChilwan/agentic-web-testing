import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeRunId, runPaths } from '../../src/shared/paths.js';
import { RunManifest } from '../../src/shared/schemas.js';

describe('makeRunId', () => {
  it('formats <target>-YYYYMMDD-HHmmss in UTC', () => {
    expect(makeRunId('mern-ecommerce', new Date('2026-10-24T10:00:05Z'))).toBe('mern-ecommerce-20261024-100005');
    expect(makeRunId('planka', new Date('2026-01-02T03:04:05.999Z'))).toBe('planka-20260102-030405');
  });

  it('produces ids that run.json accepts', () => {
    const runId = makeRunId('mern-ecommerce');
    expect(RunManifest.shape.runId.safeParse(runId).success).toBe(true);
  });
});

describe('runPaths', () => {
  it('lays out the run directory as documented', () => {
    const p = runPaths('r-20261024-100000', '/runs');
    expect(p.llmCalls).toBe(path.join('/runs', 'r-20261024-100000', 'llm-calls.jsonl'));
    expect(p.scriptsManifest).toBe(path.join('/runs', 'r-20261024-100000', 'scripts', 'manifest.json'));
    expect(p.results('x-07')).toBe(path.join('/runs', 'r-20261024-100000', 'executions', 'x-07', 'results.json'));
    expect(p.artifactsDir('x-07', 'TC-004')).toBe(
      path.join('/runs', 'r-20261024-100000', 'executions', 'x-07', 'artifacts', 'TC-004'),
    );
    expect(p.diagnosesNoTools('golden')).toBe(
      path.join('/runs', 'r-20261024-100000', 'executions', 'golden', 'diagnoses.no-tools.json'),
    );
  });
});
