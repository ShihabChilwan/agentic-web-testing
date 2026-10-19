import { describe, expect, it } from 'vitest';
import { Diagnoses } from '../../../src/shared/schemas.js';
import { errorPaths, example } from './helpers.js';

describe('diagnoses.json', () => {
  const diagnoses = example('diagnoses.json');

  it('accepts the reference example', () => {
    expect(Diagnoses.safeParse(diagnoses).success).toBe(true);
  });

  it('requires a location for app_defect only', () => {
    const d = structuredClone(diagnoses);
    delete d.diagnoses[0].location;
    expect(errorPaths(Diagnoses, d)).toContain('diagnoses.0.location');

    d.diagnoses[0].classification = 'environment_issue';
    expect(Diagnoses.safeParse(d).success).toBe(true);
  });

  it('rejects confidence outside 0..1 and unknown evidence sources', () => {
    const d = structuredClone(diagnoses);
    d.diagnoses[0].confidence = 1.2;
    d.diagnoses[0].evidence[0].source = 'screenshot';
    expect(errorPaths(Diagnoses, d)).toEqual(
      expect.arrayContaining(['diagnoses.0.confidence', 'diagnoses.0.evidence.0.source']),
    );
  });
});
