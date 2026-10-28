import { rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRunView, MAX_EXCERPT_CHARS, revisionsOf } from '../../src/modules/report/view-model.js';
import { messageValue } from '../../src/modules/script-generator/suspected.js';
import { RunView } from '../../src/shared/schemas.js';
import { COMMIT, makeReportRun, PNG } from './fixture.js';

let run: Awaited<ReturnType<typeof makeReportRun>>;
let view: RunView;

beforeAll(async () => {
  run = await makeReportRun();
  view = await buildRunView(run.dir, new Date('2026-10-25T00:00:00Z'));
});

afterAll(async () => {
  await rm(run.runsDir, { recursive: true, force: true });
});

describe('buildRunView', () => {
  it('describes the run and its stages, with cost from the call log inside each stage window', () => {
    expect(RunView.safeParse(view).success).toBe(true);
    expect(view.run).toMatchObject({ runId: run.runId, target: 'mern-ecommerce', generationRef: 'golden', generationCommit: COMMIT });
    expect(view.stages.map((s) => [s.name, s.durationMs, s.calls, s.costUsd])).toEqual([
      ['prd', 180_000, 2, expect.closeTo(0.03, 10)], // the prd call at 12:00 is outside the window
      ['cases', 120_000, 1, null],
      ['scripts', 2_700_000, 1, 0.5],
    ]);
  });

  it('links requirements to test cases and script outcomes, with coverage numbers', () => {
    expect(view.coverage).toMatchObject({ requirements: 1, covered: 1, testCases: 4, scripts: { passed: 2, assertionFailed: 1, invalid: 1, none: 0 } });
    expect(view.requirements[0]?.testCases.map((t) => [t.id, t.outcome, t.failureCategory])).toEqual([
      ['TC-001', 'passed', null],
      ['TC-002', 'passed', null],
      ['TC-003', 'invalid', 'locator'],
      ['TC-004', 'assertion_failed', null],
    ]);
  });

  it('lists the test cases the generation version contradicts as suspected defects, with the requirement, expected and actual', () => {
    expect(view.suspectedDefects).toEqual([
      {
        testCaseId: 'TC-004',
        title: expect.stringContaining('Non-admin cannot approve'),
        requirements: [{ id: 'REQ-002', statement: expect.any(String) }],
        expectationId: 'E1',
        expectation: 'Response status is 403',
        expected: '403',
        received: '200',
        message: expect.stringMatching(/^Error: E1\n/),
        review: null,
      },
    ]);
  });

  it('shows each execution with a label for people, its tests, skipped scripts and evidence', () => {
    expect(view.executions.map((e) => [e.execId, e.label, e.summary !== null])).toEqual([
      ['x-01', 'golden', true],
      ['x-02', 'golden + dev-001-login.patch', true],
      ['x-03', 'golden, seed skipped', false],
      ['x-04', 'golden', true],
    ]);
    const x2 = view.executions[1]!;
    expect(x2.tests.map((t) => [t.testCaseId, t.status, t.skipReason ?? null])).toEqual([
      ['TC-001', 'failed', null],
      ['TC-002', 'passed', null],
      ['TC-003', 'skipped', 'invalid'],
    ]);
    const f = x2.tests[0]!.failure!;
    expect(f).toMatchObject({ expected: '400', received: '200', expectationId: 'E1', category: 'assertion_failed', diagnosisId: 'DX-001', noToolsDiagnosisId: null });
    expect(f.screenshot).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(f.trace).toBe('executions/x-02/artifacts/TC-001/trace.zip');
    expect(f.excerpts.serverLog?.endsWith('POST /api/auth/login 200\n')).toBe(true);
    expect(f.excerpts.serverLog!.length).toBeLessThan(MAX_EXCERPT_CHARS + 100);
    expect(f.excerpts).toMatchObject({ lastResponse: '{"status":200}', network: null, console: null });
    expect(x2.analysis.full).toMatchObject({ costUsd: 0.0015 });
    expect(view.executions[2]).toMatchObject({ error: 'Error: boom', tests: [], incidents: [], diagnoses: null });
  });

  it('reads files written by older versions: never assumed isolated, no analysis summary', () => {
    const x4 = view.executions[3]!;
    expect(x4.tests[0]).toMatchObject({ status: 'failed', isolated: false });
    expect(x4.analysis.full).toBeNull();
    expect(x4.diagnoses?.length).toBe(1);
  });

  it('compares every pair of executions with results', () => {
    expect(Object.keys(view.comparisons)).toEqual(['x-01|x-02', 'x-01|x-04', 'x-02|x-04']);
    expect(view.comparisons['x-01|x-02']).toEqual([{ testCaseId: 'TC-001', from: 'passed', to: 'failed', kind: 'newly-failing' }]);
  });

  it('a run with only run.json gives an empty view', async () => {
    const { createRun, llmSettings } = await import('../../src/shared/run-manifest.js');
    const { parseLLMConfig } = await import('../../src/shared/config.js');
    const empty = await createRun({ target: 'fake', generationRef: 'golden', generationCommit: COMMIT, llm: llmSettings(parseLLMConfig({ LLM_BASE_URL: 'http://m.test/v1' })), runsDir: run.runsDir });
    const v = await buildRunView(empty.paths.dir);
    expect(v).toMatchObject({ stages: [], requirements: [], executions: [], comparisons: {}, coverage: { requirements: 0, testCases: 0 } });
  });
});

describe('messageValue', () => {
  it('reads Playwright\'s Expected and Received lines', () => {
    const m = 'Error: E2\n\nexpect(locator).toHaveText(expected) failed\n\nLocator: getByRole(\'alert\')\nExpected string: "Password Incorrect"\nReceived string: ""\nTimeout: 5000ms';
    expect(messageValue(m, 'Expected')).toBe('"Password Incorrect"');
    expect(messageValue(m, 'Received')).toBe('""');
    expect(messageValue('- Expected  - 1\n+ Received  + 1', 'Expected')).toBeNull();
  });
});

describe('revisionsOf', () => {
  const rev = (expectationId: string, change: 'value' | 'remove') => ({
    expectationId, change, from: { description: `before ${expectationId}`, value: 1 }, to: change === 'remove' ? null : { description: `after ${expectationId}`, value: 2 },
    citation: { file: 'server/x.js', lines: [1, 2] as [number, number] }, explanation: `why ${expectationId}`, revisedAt: '2026-10-28T12:00:00.000Z',
  });
  const tc = (id: string, over: Record<string, unknown>) => ({
    id, requirementIds: ['REQ-001'], title: `case ${id}`, layer: 'api', category: 'functional', priority: 'high',
    preconditions: [], fixturesUsed: [], steps: ['s'], expected: [{ id: 'E1', description: 'd' }], ...over,
  }) as never;

  it('lists changes and removals of all cases, current and earlier, removals first', () => {
    const list = revisionsOf([
      tc('TC-001', { revision: rev('E1', 'value') }),
      tc('TC-002', { earlierRevisions: [rev('E1', 'remove')], revision: rev('E2', 'value') }),
      tc('TC-003', {}),
    ]);
    expect(list.map((r) => [r.testCaseId, r.expectationId, r.change])).toEqual([['TC-002', 'E1', 'remove'], ['TC-001', 'E1', 'value'], ['TC-002', 'E2', 'value']]);
    expect(list[0]).toMatchObject({ title: 'case TC-002', to: null, citation: { file: 'server/x.js' }, explanation: 'why E1' });
  });
});
