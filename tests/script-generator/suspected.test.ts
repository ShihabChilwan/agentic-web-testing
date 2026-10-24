import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeSuspectedDefects, readSuspectedDefects, suspectedDefects } from '../../src/modules/script-generator/suspected.js';
import { Prd, ScriptManifest, TestCases } from '../../src/shared/schemas.js';
import { example } from '../shared/schemas/helpers.js';

// Real dry-run errors of assertion_failed scripts, as recorded from Playwright 1.64.0 in a run.
const STATUS = "Error: E1\n\nexpect(received).toBe(expected) // Object.is equality\n\nExpected: 403\nReceived: 200\n\n  12 |   expect(res.status(), 'E1').toBe(EXPECTED.E1.value);";
const STRING = 'Error: E2\n\nexpect(received).toBe(expected) // Object.is equality\n\nExpected: "alice@example.test"\nReceived: "hacked@example.test"';

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function inputs() {
  const base = example('testcases.json').testCases[0];
  const testCases = TestCases.parse({
    ...example('testcases.json'),
    testCases: [
      { ...base, id: 'TC-001', title: 'Passing case' },
      { ...base, id: 'TC-068', title: 'Non-admin cannot approve a merchant', expected: [{ id: 'E1', description: 'Response status is 403', value: 403 }] },
      { ...base, id: 'TC-021', title: 'Profile email cannot be changed', expected: [{ id: 'E1', description: 'Status 200', value: 200 }, { id: 'E2', description: 'Email unchanged' }] },
    ],
  });
  const entry = (id: string, outcome: string | null, error: string | null) => ({
    testCaseId: id,
    file: `scripts/${id}.spec.ts`,
    status: outcome ? 'validated' : 'invalid',
    validationOutcome: outcome,
    attempts: 1,
    attemptLog: [{ attempt: 1, stage: 'dry-run', error, durationMs: 1, ...(outcome ? {} : { category: 'locator' }) }],
    failureCategory: outcome ? null : 'locator',
  });
  const manifest = ScriptManifest.parse({
    schemaVersion: '1.0',
    generationRef: 'golden',
    scripts: [entry('TC-001', 'passed', null), entry('TC-068', 'assertion_failed', STATUS), entry('TC-021', 'assertion_failed', STRING), entry('TC-099', null, 'x')],
  });
  return { testCases, manifest, prd: Prd.parse(example('prd.json')) };
}

describe('suspected defects', () => {
  it('lists only assertion_failed cases, with requirement, the locked value as expected and what the app gave', () => {
    const { testCases, manifest, prd } = inputs();
    const list = suspectedDefects(manifest, testCases, prd);
    expect(list.map((d) => [d.testCaseId, d.expectationId, d.expectation, d.expected, d.received])).toEqual([
      ['TC-068', 'E1', 'Response status is 403', '403', '200'],
      // E2 has no locked value in the case: the expected text comes from Playwright's message.
      ['TC-021', 'E2', 'Email unchanged', '"alice@example.test"', '"hacked@example.test"'],
    ]);
    expect(list[0]!.requirements).toEqual([{ id: 'REQ-002', statement: prd.requirements.find((r) => r.id === 'REQ-002')!.statement }]);
  });

  it('describes them for a person, and says nothing when there are none', () => {
    const { testCases, manifest } = inputs();
    expect(describeSuspectedDefects(suspectedDefects(manifest, testCases, null))).toEqual([
      'Suspected defects in the current version (2): the app contradicts these locked expectations; the test case or the app is wrong. They are not executed.',
      '  TC-068 E1 (REQ-002) "Response status is 403": expected 403, got 200',
      '  TC-021 E2 (REQ-002) "Email unchanged": expected "alice@example.test", got "hacked@example.test"',
    ]);
    expect(describeSuspectedDefects([])).toEqual([]);
  });

  it('reads them from a run folder, and returns none before the scripts stage', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'suspected-'));
    tempDirs.push(dir);
    expect(await readSuspectedDefects(dir)).toEqual([]);
    const { testCases, manifest } = inputs();
    await mkdir(path.join(dir, 'scripts'));
    await writeFile(path.join(dir, 'testcases.json'), JSON.stringify(testCases));
    await writeFile(path.join(dir, 'scripts', 'manifest.json'), JSON.stringify(manifest));
    expect((await readSuspectedDefects(dir)).map((d) => d.testCaseId)).toEqual(['TC-068', 'TC-021']); // no prd.json: statements null
  });
});
