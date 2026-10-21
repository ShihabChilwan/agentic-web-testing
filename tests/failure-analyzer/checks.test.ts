import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkDiagnoses, SubmitDiagnoses } from '../../src/modules/failure-analyzer/checks.js';
import { Prd } from '../../src/shared/schemas.js';
import { example } from '../shared/schemas/helpers.js';

let root: string;
const prd = Prd.parse(example('prd.json'));

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'awt-checks-'));
  await mkdir(path.join(root, 'server', 'node_modules', 'lib'), { recursive: true });
  await writeFile(path.join(root, 'server', 'auth.js'), 'a\nb\nc\nd\ne\n');
  await writeFile(path.join(root, 'server', 'node_modules', 'lib', 'index.js'), 'x\n');
  await symlink('/etc/hostname', path.join(root, 'server', 'outside.js'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const draft = (over: Record<string, unknown> = {}) => ({
  testCaseIds: ['TC-001', 'TC-002'],
  classification: 'app_defect',
  confidence: 0.8,
  summary: 'Login accepts a wrong password.',
  rootCause: 'The check never fires.',
  location: { file: 'server/auth.js', lines: [2, 4] },
  evidence: [{ source: 'code', detail: 'auth.js:3' }],
  violatedRequirementIds: ['REQ-002'],
  suggestedFix: { description: 'Negate the check.' },
  ...over,
});

const check = (diagnoses: unknown[]) =>
  checkDiagnoses(SubmitDiagnoses.parse({ diagnoses }), { groupTestIds: ['TC-001', 'TC-002'], scope: { root, forbiddenPaths: [] }, prd });

describe('checkDiagnoses', () => {
  it('accepts a complete, grounded submit', async () => {
    expect(await check([draft()])).toEqual([]);
    expect(await check([draft({ testCaseIds: ['TC-001'] }), draft({ testCaseIds: ['TC-002'], classification: 'environment_issue', location: null })])).toEqual([]);
  });

  it('needs every test of the group exactly once, and no other test', async () => {
    expect(await check([draft({ testCaseIds: ['TC-001'] })])).toEqual(['Every test must be in exactly one diagnosis; missing: TC-002.']);
    expect(await check([draft(), draft({ testCaseIds: ['TC-002', 'TC-009'] })])).toEqual([
      'diagnoses[1]: TC-009 is not one of the tests you are diagnosing (TC-001, TC-002).',
      'Every test must be in exactly one diagnosis; in more than one: TC-002.',
    ]);
  });

  it('needs a location for an app_defect, in a readable file of the source tree, within its lines', async () => {
    expect(await check([draft({ location: null })])).toEqual(['diagnoses[0]: an app_defect needs a location (file and lines in the app source).']);
    expect((await check([draft({ location: { file: 'server/nope.js', lines: [1, 1] } })]))[0]).toMatch(/does not exist/);
    expect((await check([draft({ location: { file: 'server/auth.js', lines: [4, 9] } })]))[0]).toMatch(/go past the end of server\/auth.js \(5 lines\)/);
    expect((await check([draft({ location: { file: 'server', lines: [1, 1] } })]))[0]).toMatch(/is not a readable file/);
    for (const file of ['../etc/passwd', '/etc/passwd', 'server/node_modules/lib/index.js', '.git/config', 'server/outside.js']) {
      const problems = await check([draft({ location: { file, lines: [1, 1] } })]);
      expect(problems, file).toHaveLength(1);
      expect(problems[0], file).toMatch(/location\.file/);
    }
  });

  it('rejects unknown requirement ids', async () => {
    expect(await check([draft({ violatedRequirementIds: ['REQ-002', 'REQ-999'] })])).toEqual(['diagnoses[0]: unknown requirement ids REQ-999.']);
  });

  it('the submit schema is strict: no id, toolCalls or unknown fields, at least one evidence item', () => {
    expect(SubmitDiagnoses.safeParse({ diagnoses: [draft({ id: 'DX-001' })] }).success).toBe(false);
    expect(SubmitDiagnoses.safeParse({ diagnoses: [draft({ evidence: [] })] }).success).toBe(false);
    expect(SubmitDiagnoses.safeParse({ diagnoses: [draft({ evidence: [{ source: 'git', detail: 'x' }] })] }).success).toBe(false);
  });
});
