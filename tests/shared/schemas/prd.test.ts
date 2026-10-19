import { describe, expect, it } from 'vitest';
import { Prd } from '../../../src/shared/schemas.js';
import { errorPaths, example } from './helpers.js';

describe('prd.json', () => {
  const prd = example('prd.json');

  it('accepts the reference example', () => {
    expect(Prd.safeParse(prd).success).toBe(true);
  });

  it('requires evidence on requirements, API endpoints and UI routes', () => {
    const p = structuredClone(prd);
    p.requirements[0].evidence = [];
    p.apiEndpoints[0].evidence = [];
    p.uiRoutes[0].evidence = [];
    expect(errorPaths(Prd, p)).toEqual(
      expect.arrayContaining(['requirements.0.evidence', 'apiEndpoints.0.evidence', 'uiRoutes.0.evidence']),
    );
  });

  it('rejects malformed ids and unknown layers', () => {
    const p = structuredClone(prd);
    p.requirements[0].id = 'REQ-2';
    p.requirements[0].layer = 'db';
    expect(errorPaths(Prd, p)).toEqual(expect.arrayContaining(['requirements.0.id', 'requirements.0.layer']));
  });
});
