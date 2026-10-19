import { describe, expect, it } from 'vitest';
import { Pricing } from '../../../src/shared/schemas.js';
import { errorPaths, example } from './helpers.js';

describe('config/pricing.json', () => {
  const pricing = example('pricing.json');

  it('accepts the reference example, with or without gpuUsdPerHour', () => {
    expect(Pricing.safeParse(pricing).success).toBe(true);
    const { gpuUsdPerHour: _g, ...noGpu } = pricing;
    expect(Pricing.safeParse(noGpu).success).toBe(true);
  });

  it('rejects negative prices and misspelled fields', () => {
    const p = structuredClone(pricing);
    p.models['example-priced-model'].inputUsdPerMTok = -1;
    p.models['example-priced-model'].outputUsdPerMtok = 2;
    expect(errorPaths(Pricing, p)).toEqual(
      expect.arrayContaining(['models.example-priced-model.inputUsdPerMTok', 'models.example-priced-model']),
    );
  });
});
