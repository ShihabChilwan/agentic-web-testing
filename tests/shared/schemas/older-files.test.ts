import { copyFile, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SubmitTestCases } from '../../../src/modules/test-case-generator/checks.js';
import { setStage } from '../../../src/shared/run-manifest.js';
import { RunManifest, ScriptManifest, TestCases } from '../../../src/shared/schemas.js';
import { example } from './helpers.js';

// Files written by an earlier version of the pipeline must still read: fields added later get defaults.

const olderRunJson = new URL('../../fixtures/older/run-before-fixture-mutation.json', import.meta.url);

describe('older run.json', () => {
  it('reads a run.json written before fixture-mutation, restores and restoreMs existed', async () => {
    const raw = JSON.parse(await readFile(olderRunJson, 'utf8'));
    expect(raw.stages.scripts.scripts.invalidByCategory).not.toHaveProperty('fixture-mutation');
    expect(raw.stages.scripts.scripts).not.toHaveProperty('restores');
    const parsed = RunManifest.parse(raw);
    expect(parsed.stages.scripts?.scripts).toMatchObject({
      // Existing counts are kept as they were; only the missing key is added.
      invalidByCategory: { ...raw.stages.scripts.scripts.invalidByCategory, 'fixture-mutation': 0 },
      restores: 0,
      restoreMs: 0,
    });
  });

  it('can update a stage in that run.json, and writes the filled-in defaults back', async () => {
    const dir = path.join(await mkdtemp(path.join(tmpdir(), 'older-run-')), 'fake-20261024-100000');
    await mkdir(dir);
    await copyFile(olderRunJson, path.join(dir, 'run.json'));
    await setStage(dir, 'scripts', { status: 'running' });
    const written = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8'));
    expect(written.stages.scripts.status).toBe('running');
    expect(written.stages.scripts.scripts.invalidByCategory['fixture-mutation']).toBe(0);
  });

  it('fills any missing count key with 0 in every stage summary', () => {
    const run = structuredClone(example('run.json'));
    run.stages.cases = {
      status: 'done',
      generation: {
        calls: 1, sessions: 1, casesByLayer: { api: 1 }, casesByCategory: {}, uncoveredByReasonKind: { other: 2 },
        rejected: { invalidInput: 0, checkFailed: 0 }, costUsd: null, warnings: [],
      },
    };
    expect(RunManifest.parse(run).stages.cases?.generation).toMatchObject({
      casesByLayer: { api: 1, ui: 0 },
      casesByCategory: { functional: 0, 'e2e-journey': 0 },
      uncoveredByReasonKind: { other: 2, 'third-party-disabled': 0 },
    });
  });
});

describe('older scripts/manifest.json', () => {
  const entry = (over: Record<string, unknown>) => ({
    testCaseId: 'TC-001', file: 'scripts/TC-001.spec.ts', status: 'invalid', validationOutcome: null, attempts: 1,
    attemptLog: [{ attempt: 1, stage: 'dry-run', error: 'x', category: 'timeout', durationMs: 1 }], ...over,
  });

  it('gives an invalid entry without failureCategory the category of its last attempt, or no-submit', () => {
    const parsed = ScriptManifest.parse({
      schemaVersion: '1.0',
      generationRef: 'golden',
      scripts: [
        entry({}),
        entry({ testCaseId: 'TC-002', attemptLog: [{ attempt: 1, stage: 'dry-run', error: 'x', durationMs: 1 }] }),
        entry({ testCaseId: 'TC-003', status: 'validated', validationOutcome: 'passed' }),
      ],
    });
    expect(parsed.scripts.map((s) => s.failureCategory)).toEqual(['timeout', 'no-submit', null]);
    expect(parsed.helpersHash).toBeUndefined();
  });
});

describe('older testcases.json', () => {
  it('defaults a missing reasonKind to other, but the model must still choose one', () => {
    const cases = structuredClone(example('testcases.json'));
    delete cases.coverage.uncovered[0].reasonKind;
    delete cases.coverage.partial;
    const parsed = TestCases.parse(cases);
    expect(parsed.coverage.uncovered[0]?.reasonKind).toBe('other');
    expect(parsed.coverage.partial).toEqual([]);
    const fromModel = SubmitTestCases.safeParse({ testCases: [], declined: [{ requirementId: 'REQ-001', reason: 'x' }] });
    expect(fromModel.success).toBe(false);
  });
});
