import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLLMConfig } from '../../src/shared/config.js';
import { createRun, errorSummary, llmSettings, readRunManifest, setStage } from '../../src/shared/run-manifest.js';

const llm = llmSettings(parseLLMConfig({ LLM_BASE_URL: 'http://model.test/v1', LLM_API_KEY: 'sk-secret' }));
const input = (runsDir: string, now = new Date('2026-10-24T10:00:00Z')) => ({
  target: 'fake',
  generationRef: 'golden',
  generationCommit: 'abc1234',
  llm,
  runsDir,
  now,
});

describe('llmSettings', () => {
  it('records the model and the reasoning effort of every call purpose, including those outside the four modules', () => {
    const settings = llmSettings(parseLLMConfig({
      LLM_BASE_URL: 'http://model.test/v1', LLM_MODEL: 'default-model', LLM_MODEL_PRD: 'prd-model', LLM_REASONING_EFFORT: 'high', LLM_REASONING_EFFORT_CASES: 'low',
    }));
    // gaps, review, one-prompt and ping use the default model and LLM_REASONING_EFFORT.
    expect(settings.models).toEqual({ prd: 'prd-model', cases: 'default-model', scripts: 'default-model', analyzer: 'default-model', other: 'default-model' });
    expect(settings.reasoningEffort).toEqual({ prd: 'medium', cases: 'low', scripts: 'medium', analyzer: 'medium', other: 'high' });
  });

  it('an older run.json without the "other" entries still reads', async () => {
    const runsDir = await mkdtemp(path.join(tmpdir(), 'runs-'));
    const { paths } = await createRun(input(runsDir));
    const written = JSON.parse(await readFile(paths.runJson, 'utf8'));
    delete written.llm.models.other;
    delete written.llm.reasoningEffort.other;
    await writeFile(paths.runJson, JSON.stringify(written));
    expect((await readRunManifest(paths.runJson)).llm.reasoningEffort.other).toBeUndefined();
  });
});

describe('run manifest', () => {
  it('creates the run folder and a valid run.json without secrets', async () => {
    const runsDir = await mkdtemp(path.join(tmpdir(), 'runs-'));
    const { runId, paths } = await createRun(input(runsDir));
    expect(runId).toBe('fake-20261024-100000');
    const text = await readFile(paths.runJson, 'utf8');
    expect(text).not.toContain('sk-secret');
    expect(text).not.toContain('model.test');
    expect(await readRunManifest(paths.runJson)).toMatchObject({ stages: {}, executions: [], llm: { concurrency: 4 } });
    expect(await readdir(paths.dir)).toEqual(['run.json']); // no temporary file left behind
  });

  it('refuses to reuse an existing run folder', async () => {
    const runsDir = await mkdtemp(path.join(tmpdir(), 'runs-'));
    await createRun(input(runsDir));
    await expect(createRun(input(runsDir))).rejects.toThrow(/already exists/);
  });

  it('updates a stage, keeping fields not given, and records upstream providers from the call log', async () => {
    const runsDir = await mkdtemp(path.join(tmpdir(), 'runs-'));
    const { paths } = await createRun(input(runsDir));
    await setStage(paths.dir, 'prd', { status: 'running', startedAt: '2026-10-24T10:00:00Z' });
    const line = {
      ts: '2026-10-24T10:00:01Z', purpose: 'prd', provider: 'openai-compatible', model: 'm', reasoningEffort: 'medium',
      inputTokens: 1, outputTokens: 1, latencyMs: 1, ok: true, attempts: 1, costUsd: 0.1, upstreamProvider: 'Wafer',
    };
    await writeFile(paths.llmCalls, `${JSON.stringify(line)}\n`);
    const manifest = await setStage(paths.dir, 'prd', { status: 'failed', error: 'Interrupted' });
    expect(manifest.stages.prd).toEqual({ status: 'failed', startedAt: '2026-10-24T10:00:00Z', error: 'Interrupted' });
    expect((await readRunManifest(paths.runJson)).llm.upstreamProviders).toEqual(['Wafer']);
  });

  it('summarises errors as Name: message', () => {
    expect(errorSummary(new TypeError('bad'))).toBe('TypeError: bad');
    expect(errorSummary('plain')).toBe('plain');
  });
});
