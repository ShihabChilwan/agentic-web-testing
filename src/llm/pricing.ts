import { readFile } from 'node:fs/promises';
import { Pricing } from '../shared/schemas.js';
import type { Usage } from './types.js';

/** Reads config/pricing.json. A missing file means no prices (every costUsd is null); an invalid one is an error. */
export async function loadPricing(file: string): Promise<Pricing | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const result = Pricing.safeParse(JSON.parse(text));
  if (!result.success) {
    throw new Error(`Invalid ${file}: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return result.data;
}

/** Cost of one call in US dollars, or null when the model has no token price. */
export function costUsd(pricing: Pricing | null, model: string, usage: Usage): number | null {
  const price = pricing?.models[model];
  if (!price) return null;
  return (usage.inputTokens * price.inputUsdPerMTok + usage.outputTokens * price.outputUsdPerMTok) / 1_000_000;
}
