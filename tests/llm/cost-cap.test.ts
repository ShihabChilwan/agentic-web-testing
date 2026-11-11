import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CostCap, RunBudget } from '../../src/llm/budget.js';
import { RunLLMClient } from '../../src/llm/client.js';
import { LLMBudgetExceededError } from '../../src/llm/errors.js';
import { FakeLLMClient } from '../../src/llm/fake.js';
import type { ChatRequest } from '../../src/llm/types.js';
import { parseLLMConfig } from '../../src/shared/config.js';

const dirs: string[] = [];
const tempDir = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cost-cap-'));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const config = parseLLMConfig({ LLM_BASE_URL: 'http://model.test/v1', LLM_API_KEY: 'k', LLM_CONCURRENCY: '1' });
const request: ChatRequest = { purpose: 'analyzer', system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }], maxTokens: 10 };
const costing = (costUsd: number) => FakeLLMClient.text('ok', { usage: { inputTokens: 1, outputTokens: 1, costUsd } });

describe('CostCap', () => {
  it('stops at 80% of the cap, counting every process in the ledger folder', async () => {
    const ledger = await tempDir();
    // Another analysis already spent 0.5 USD.
    await writeFile(path.join(ledger, '999-other.json'), JSON.stringify({ spentUsd: 0.5 }));
    const cap = new CostCap({ capUsd: 1, ledgerDir: ledger });
    expect(cap.stopAtUsd).toBeCloseTo(0.8);
    await cap.check();
    await cap.add(0.25);
    expect(await cap.spentUsd()).toBeCloseTo(0.75);
    await cap.check();
    await cap.add(0.06);
    await expect(cap.check()).rejects.toThrow(LLMBudgetExceededError);
    // Its own spend is in the ledger for the other processes.
    expect((await readdir(ledger)).filter((n) => n.endsWith('.json'))).toHaveLength(2);
  });

  it('without a ledger counts this process only, and refuses a cap that is not a positive number', async () => {
    const cap = new CostCap({ capUsd: 0.1 });
    await cap.add(0.07);
    await cap.check();
    await cap.add(0.02);
    await expect(cap.check()).rejects.toThrow(/cost cap reached: \$0\.0900 spent of a \$0\.10 cap/);
    expect(() => new CostCap({ capUsd: Number.NaN })).toThrow(/positive/);
  });

  it('is checked before every model call: the call after the stop point never reaches the provider', async () => {
    const dir = await tempDir();
    const provider = new FakeLLMClient([costing(0.05), costing(0.04), costing(0.01)]);
    const client = new RunLLMClient(config, {
      provider,
      pricing: null,
      budget: new RunBudget({ maxTokens: 1_000_000, maxCostUsd: 2 }),
      costCap: new CostCap({ capUsd: 0.1 }),
      callLogFile: path.join(dir, 'llm-calls.jsonl'),
    });
    expect((await client.chat(request)).usage.costUsd).toBe(0.05);
    await client.chat(request);
    await expect(client.chat(request)).rejects.toThrow(LLMBudgetExceededError);
    expect(provider.requests).toHaveLength(2);
  });
});
