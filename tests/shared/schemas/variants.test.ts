import { describe, expect, it } from 'vitest';
import { OnePromptSubmission, Variants } from '../../../src/shared/schemas.js';
import { errorPaths, example } from './helpers.js';

describe('variants.json', () => {
  const variants = example('variants.json');

  it('accepts the reference example and defaults skipSeed', () => {
    expect(Variants.parse(variants).variants.map((v) => v.kind)).toEqual(['code', 'environment']);
    const v = structuredClone(variants);
    delete v.variants[1].skipSeed;
    const env = Variants.parse(v).variants[1];
    expect(env?.kind === 'environment' && env.skipSeed).toBe(false);
  });

  it('accepts env-02 removing JWT_SECRET with null', () => {
    const v = structuredClone(variants);
    v.variants[1].configOverride = { backend: { env: { JWT_SECRET: null } } };
    expect(Variants.safeParse(v).success).toBe(true);
  });

  it('allows null mutator and seed only for manual variants', () => {
    const v = structuredClone(variants);
    v.seed = null;
    v.variants[0].mutator = null;
    expect(errorPaths(Variants, v)).toEqual(expect.arrayContaining(['seed', 'variants.0.mutator']));
    v.method = 'manual';
    expect(Variants.safeParse(v).success).toBe(true);
  });

  it('rejects an unknown variant kind and code fields on an environment variant', () => {
    const v = structuredClone(variants);
    v.variants[0].kind = 'data';
    v.variants[1].mutator = 'BooleanLiteral';
    expect(errorPaths(Variants, v)).toEqual(expect.arrayContaining(['variants.0.kind', 'variants.1']));
  });
});

describe('one-prompt submission', () => {
  it('accepts OP ids and rejects TC ids', () => {
    const script = { id: 'OP-001', title: 'Login works', code: "test('OP-001', async () => {});" };
    expect(OnePromptSubmission.safeParse({ scripts: [script] }).success).toBe(true);
    expect(OnePromptSubmission.safeParse({ scripts: [{ ...script, id: 'TC-001' }] }).success).toBe(false);
  });
});
