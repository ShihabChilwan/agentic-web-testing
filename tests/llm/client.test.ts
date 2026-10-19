import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunBudget } from '../../src/llm/budget.js';
import { readCallLog } from '../../src/llm/call-log.js';
import { createLLMClient, RunLLMClient } from '../../src/llm/client.js';
import { LLMBudgetExceededError, LLMRequestError } from '../../src/llm/errors.js';
import { FakeLLMClient } from '../../src/llm/fake.js';
import type { FakeStep } from '../../src/llm/fake.js';
import type { ChatRequest } from '../../src/llm/types.js';
import { parseLLMConfig } from '../../src/shared/config.js';
import type { Pricing } from '../../src/shared/schemas.js';

const SECRETS = { key: 'sk-test-secret-key', header: 'modal-secret-value' };

const config = parseLLMConfig({
  LLM_BASE_URL: 'http://model.test/v1',
  LLM_API_KEY: SECRETS.key,
  LLM_EXTRA_HEADERS: JSON.stringify({ 'Modal-Secret': SECRETS.header }),
  LLM_MODEL_ANALYZER: 'analyzer-model',
  LLM_CONCURRENCY: '2',
});

const request: ChatRequest = {
  purpose: 'analyzer',
  system: 'sys',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
  maxTokens: 100,
};

async function setup(steps: FakeStep[], opts: { pricing?: Pricing; budget?: RunBudget } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'llm-client-'));
  const callLogFile = path.join(dir, 'llm-calls.jsonl');
  const provider = new FakeLLMClient(steps);
  const warnings: string[] = [];
  const client = new RunLLMClient(config, {
    provider,
    pricing: opts.pricing ?? null,
    budget: opts.budget ?? new RunBudget({ maxTokens: 1_000_000, maxCostUsd: 2 }),
    callLogFile,
    retry: { maxAttempts: 4, maxTimeoutRetries: 1, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => {} },
    warn: (m) => warnings.push(m),
  });
  const log = async () => (await readCallLog(callLogFile)).lines;
  const rawLog = () => readFile(callLogFile, 'utf8');
  return { client, provider, warnings, log, rawLog, callLogFile };
}

describe('RunLLMClient settings', () => {
  it('resolves model, sampling and reasoning effort per purpose', async () => {
    const { client, provider } = await setup([FakeLLMClient.text('ok')]);
    await client.chat(request);
    expect(provider.requests[0]).toMatchObject({ model: 'analyzer-model', temperature: 1, topP: 1, reasoningEffort: 'high' });
  });

  it('lets the request override reasoning effort and sampling', async () => {
    const { client, provider } = await setup([FakeLLMClient.text('ok')]);
    await client.chat({ ...request, reasoningEffort: 'low', temperature: 0.2 });
    expect(provider.requests[0]).toMatchObject({ reasoningEffort: 'low', temperature: 0.2 });
  });
});

describe('RunLLMClient call log', () => {
  it('logs a successful call with tokens, attempts and cost', async () => {
    const pricing: Pricing = { schemaVersion: '1.0', models: { 'analyzer-model': { inputUsdPerMTok: 1, outputUsdPerMTok: 2 } } };
    const { client, log } = await setup(
      [FakeLLMClient.text('ok', { usage: { inputTokens: 1_000_000, outputTokens: 500_000 } })],
      { pricing },
    );
    await client.chat(request);
    expect(await log()).toEqual([
      expect.objectContaining({
        purpose: 'analyzer',
        provider: 'openai-compatible',
        model: 'analyzer-model',
        reasoningEffort: 'high',
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        ok: true,
        attempts: 1,
        costUsd: 2,
      }),
    ]);
  });

  it('logs costUsd null for a model without a price', async () => {
    const { client, log } = await setup([FakeLLMClient.text('ok')]);
    await client.chat(request);
    expect((await log())[0]?.costUsd).toBeNull();
  });

  it('counts retries in attempts', async () => {
    const { client, log } = await setup([
      new LLMRequestError('503 overloaded', 'server', 503),
      new LLMRequestError('429 slow down', 'rate_limit', 429),
      FakeLLMClient.text('ok'),
    ]);
    await client.chat(request);
    expect((await log())[0]).toMatchObject({ ok: true, attempts: 3 });
  });

  it('logs a failed call and rethrows, without any key or header value', async () => {
    const leaky = `401 invalid key ${SECRETS.key} for header ${SECRETS.header}`;
    const { client, log, rawLog } = await setup([new LLMRequestError(leaky, 'client', 401)]);
    const err = await client.chat(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMRequestError);
    expect((err as Error).message).not.toContain(SECRETS.key);
    expect((err as Error).message).not.toContain(SECRETS.header);
    expect((err as LLMRequestError).attempts).toBe(1);
    expect((await log())[0]).toMatchObject({ ok: false, attempts: 1, inputTokens: 0, error: expect.stringContaining('[redacted]') });
    const raw = await rawLog();
    expect(raw).not.toContain(SECRETS.key);
    expect(raw).not.toContain(SECRETS.header);
  });
});

describe('RunLLMClient reasoning_effort rejection', () => {
  const rejection = () => new LLMRequestError('400 Unrecognized request argument: reasoning_effort', 'client', 400);

  it('warns once, retries without it, and stops sending it for the rest of the run', async () => {
    const { client, provider, warnings, log } = await setup([rejection(), FakeLLMClient.text('a'), FakeLLMClient.text('b')]);
    await client.chat(request);
    await client.chat(request);
    expect(provider.requests.map((r) => r.reasoningEffort)).toEqual(['high', undefined, undefined]);
    expect(warnings).toHaveLength(1);
    expect((await log()).map((l) => [l.reasoningEffort, l.attempts])).toEqual([
      [null, 2],
      [null, 1],
    ]);
  });

  it('does not treat other 400 errors as a rejection', async () => {
    const { client, provider, warnings } = await setup([new LLMRequestError('400 context length exceeded', 'client', 400)]);
    await expect(client.chat(request)).rejects.toThrow('context length');
    expect(provider.requests).toHaveLength(1);
    expect(warnings).toHaveLength(0);
  });
});

describe('RunLLMClient budget', () => {
  it('throws LLMBudgetExceededError before calling the provider', async () => {
    const budget = new RunBudget({ maxTokens: 100, maxCostUsd: 2 });
    budget.add(100, null);
    const { client, provider } = await setup([FakeLLMClient.text('never')], { budget });
    await expect(client.chat(request)).rejects.toThrow(LLMBudgetExceededError);
    expect(provider.requests).toHaveLength(0);
  });

  it('adds each call to the totals, so the next call is stopped', async () => {
    const budget = new RunBudget({ maxTokens: 150, maxCostUsd: 2 });
    const { client, provider } = await setup(
      [FakeLLMClient.text('a', { usage: { inputTokens: 100, outputTokens: 60 } }), FakeLLMClient.text('b')],
      { budget },
    );
    await client.chat(request);
    await expect(client.chat(request)).rejects.toThrow(LLMBudgetExceededError);
    expect(provider.requests).toHaveLength(1);
  });
});

describe('RunLLMClient concurrency', () => {
  it('keeps at most LLM_CONCURRENCY calls in flight', async () => {
    let active = 0;
    let peak = 0;
    const slow: FakeStep = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return FakeLLMClient.text('ok');
    };
    const { client } = await setup(Array.from({ length: 6 }, () => slow));
    await Promise.all(Array.from({ length: 6 }, () => client.chat(request)));
    expect(peak).toBe(2);
  });
});

describe('createLLMClient', () => {
  it('rebuilds the run totals from an existing call log', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'llm-create-'));
    const callLogFile = path.join(dir, 'llm-calls.jsonl');
    const line = {
      ts: '2026-10-24T10:00:00Z',
      purpose: 'prd',
      provider: 'openai-compatible',
      model: 'm',
      reasoningEffort: 'medium',
      inputTokens: 4_000_000,
      outputTokens: 1_000_000,
      latencyMs: 1,
      ok: true,
      attempts: 1,
      costUsd: null,
    };
    await writeFile(callLogFile, JSON.stringify(line) + '\n');
    const client = await createLLMClient(config, { callLogFile, pricingFile: path.join(dir, 'missing.json') });
    // 5,000,000 tokens already used: the default cap is reached, so no request is made.
    await expect(client.chat(request)).rejects.toThrow(LLMBudgetExceededError);
  });

  it('refuses the anthropic provider for now', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'llm-create-'));
    const anthropic = parseLLMConfig({ LLM_PROVIDER: 'anthropic' });
    await expect(
      createLLMClient(anthropic, { callLogFile: path.join(dir, 'l.jsonl'), pricingFile: path.join(dir, 'p.json') }),
    ).rejects.toThrow(/not implemented/);
  });
});
