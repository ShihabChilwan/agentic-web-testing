import { describe, expect, it } from 'vitest';
import { Prd, requirementEvidence } from '../../../src/shared/schemas.js';
import { errorPaths, example } from './helpers.js';

describe('prd.json', () => {
  const prd = example('prd.json');

  it('accepts the reference example', () => {
    expect(Prd.safeParse(prd).success).toBe(true);
  });

  it('requires evidence on every acceptance criterion, API endpoint and UI route', () => {
    const p = structuredClone(prd);
    p.requirements[0].acceptanceCriteria[1].evidence = [];
    p.apiEndpoints[0].evidence = [];
    p.uiRoutes[0].evidence = [];
    expect(errorPaths(Prd, p)).toEqual(
      expect.arrayContaining(['requirements.0.acceptanceCriteria.1.evidence', 'apiEndpoints.0.evidence', 'uiRoutes.0.evidence']),
    );
  });

  it('takes 1 to 4 criteria, each an object with text and evidence', () => {
    const p = structuredClone(prd);
    const c = p.requirements[0].acceptanceCriteria[0];
    p.requirements[0].acceptanceCriteria = [c, c, c, c, c];
    expect(errorPaths(Prd, p)).toContain('requirements.0.acceptanceCriteria');
    p.requirements[0].acceptanceCriteria = ['The user stays on the login page'];
    expect(errorPaths(Prd, p)).toContain('requirements.0.acceptanceCriteria.0');
    p.requirements[0].acceptanceCriteria = [];
    expect(errorPaths(Prd, p)).toContain('requirements.0.acceptanceCriteria');
  });

  it('derives a requirement\'s evidence from its criteria, without duplicates', () => {
    const r = Prd.parse(prd).requirements[0]!;
    const twice = { ...r, acceptanceCriteria: [...r.acceptanceCriteria, r.acceptanceCriteria[0]!] };
    expect(requirementEvidence(twice)).toEqual([
      { file: 'server/routes/api/auth.js', lines: [30, 45] },
      { file: 'client/app/containers/Login/index.js', lines: [40, 75] },
    ]);
  });

  it('rejects malformed ids and unknown layers', () => {
    const p = structuredClone(prd);
    p.requirements[0].id = 'REQ-2';
    p.requirements[0].layer = 'db';
    expect(errorPaths(Prd, p)).toEqual(expect.arrayContaining(['requirements.0.id', 'requirements.0.layer']));
  });
});
