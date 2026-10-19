import { describe, expect, it } from 'vitest';
import { ScriptManifest } from '../../../src/shared/schemas.js';
import { errorPaths, example } from './helpers.js';

describe('scripts/manifest.json', () => {
  const manifest = example('manifest.json');

  it('accepts the reference example', () => {
    expect(ScriptManifest.safeParse(manifest).success).toBe(true);
  });

  it('accepts one-prompt ablation ids', () => {
    const m = structuredClone(manifest);
    m.scripts[0].testCaseId = 'OP-001';
    expect(ScriptManifest.safeParse(m).success).toBe(true);
  });

  it('requires validationOutcome to match status', () => {
    const invalidWithOutcome = structuredClone(manifest);
    invalidWithOutcome.scripts[0].status = 'invalid';
    expect(errorPaths(ScriptManifest, invalidWithOutcome)).toContain('scripts.0.validationOutcome');

    const validatedWithoutOutcome = structuredClone(manifest);
    validatedWithoutOutcome.scripts[0].validationOutcome = null;
    expect(errorPaths(ScriptManifest, validatedWithoutOutcome)).toContain('scripts.0.validationOutcome');
  });
});
