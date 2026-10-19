import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { costUsd, loadPricing } from '../../src/llm/pricing.js';

describe('pricing', () => {
  it('returns null prices when the file is missing', async () => {
    const pricing = await loadPricing(path.join(tmpdir(), 'no-such-dir', 'pricing.json'));
    expect(pricing).toBeNull();
    expect(costUsd(pricing, 'any', { inputTokens: 1000, outputTokens: 1000 })).toBeNull();
  });

  it('computes cost per million tokens for priced models only', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'pricing-')), 'pricing.json');
    await writeFile(
      file,
      JSON.stringify({ schemaVersion: '1.0', models: { priced: { inputUsdPerMTok: 1, outputUsdPerMTok: 4 } } }),
    );
    const pricing = await loadPricing(file);
    expect(costUsd(pricing, 'priced', { inputTokens: 500_000, outputTokens: 250_000 })).toBeCloseTo(1.5);
    expect(costUsd(pricing, 'openai/gpt-oss-120b', { inputTokens: 500_000, outputTokens: 250_000 })).toBeNull();
  });

  it('rejects an invalid file', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'pricing-')), 'pricing.json');
    await writeFile(file, JSON.stringify({ schemaVersion: '1.0', models: { m: { inputUsdPerMTok: -1 } } }));
    await expect(loadPricing(file)).rejects.toThrow(/Invalid/);
  });
});
