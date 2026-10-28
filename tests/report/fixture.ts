import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRun, llmSettings, setExecution, setStage } from '../../src/shared/run-manifest.js';
import { parseLLMConfig } from '../../src/shared/config.js';
import { example } from '../shared/schemas/helpers.js';

// A run folder for the report: three test cases (two scripts passed, one invalid), a golden execution,
// a patched one with a failure, its evidence and diagnosis, a failed execution without results, and an
// execution written by an older version (results.json before isolation, diagnoses.json without summary).

export const COMMIT = 'abc1234def5678abc1234def5678abc1234def56';
// A 1×1 PNG.
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
/** A dry-run error as recorded from Playwright 1.64.0 for a locked value that differed (TC-068 of a real run). */
export const SUSPECTED_ERROR = 'Error: E1\n\nexpect(received).toBe(expected) // Object.is equality\n\nExpected: 403\nReceived: 200\n\n  12 |   expect(res.status(), \'E1\').toBe(EXPECTED.E1.value);';
export const EVIL = '</script><img src=x onerror="document.title=\'pwned\'">';

const result = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ testCaseId: id, status, isolated: true, durationMs: 100, artifacts: {}, ...extra });
const results = (execId: string, tests: unknown[], skipped: unknown[], startedAt = '2026-10-24T11:00:00.000Z') => ({
  schemaVersion: '1.0', execId, startedAt, finishedAt: '2026-10-24T11:05:00.000Z',
  environment: { healthChecks: [{ name: 'backend', url: 'http://localhost:3000/h', ok: true, elapsedMs: 900 }], seed: [] },
  summary: { total: tests.length, passed: tests.filter((t) => (t as { status: string }).status === 'passed').length, failed: 1, errored: 0, skipped: skipped.length, notIsolated: 0 },
  skipped, incidents: [], timing: { startupMs: 9000, suiteMs: 60000, restores: 2, restoreMs: 6000 }, results: tests,
});

export async function makeReportRun() {
  const runsDir = await mkdtemp(path.join(tmpdir(), 'awt-report-'));
  const llm = llmSettings(parseLLMConfig({ LLM_BASE_URL: 'http://model.test/v1' }));
  const { runId, paths } = await createRun({ target: 'mern-ecommerce', generationRef: 'golden', generationCommit: COMMIT, llm, runsDir, now: new Date('2026-10-24T10:00:00Z') });
  const dir = paths.dir;
  await writeFile(paths.prd, JSON.stringify(example('prd.json')));
  const tcs = example('testcases.json');
  const base = tcs.testCases[0];
  tcs.testCases = [
    { ...base, id: 'TC-001', title: 'Wrong password is rejected' },
    { ...base, id: 'TC-002', title: 'Missing email is rejected' },
    // Revised after review (S3): an expectation removed, with hostile text in the reason to check escaping.
    {
      ...base, id: 'TC-003', title: 'Login page heading',
      revision: {
        expectationId: 'E2', change: 'remove', from: { description: 'The heading says Welcome', value: 'Welcome' }, to: null,
        citation: { file: 'client/app/Login.js', lines: [3, 9] }, explanation: `The page has no such heading ${EVIL}`, revisedAt: '2026-10-28T12:00:00.000Z',
      },
    },
    // The generation version contradicts it: a suspected defect (§6.4). Hostile text checks escaping.
    { ...base, id: 'TC-004', title: `Non-admin cannot approve ${EVIL}`, expected: [{ id: 'E1', description: 'Response status is 403', value: 403 }] },
  ];
  await writeFile(paths.testCases, JSON.stringify(tcs));
  const attempt = { attempt: 1, stage: 'dry-run', error: null, durationMs: 1 };
  await mkdir(paths.scriptsDir, { recursive: true });
  await writeFile(paths.scriptsManifest, JSON.stringify({ schemaVersion: '1.0', generationRef: 'golden', scripts: [
    { testCaseId: 'TC-001', file: 'scripts/TC-001.spec.ts', status: 'validated', validationOutcome: 'passed', attempts: 1, attemptLog: [attempt], failureCategory: null },
    { testCaseId: 'TC-002', file: 'scripts/TC-002.spec.ts', status: 'validated', validationOutcome: 'passed', attempts: 1, attemptLog: [attempt], failureCategory: null },
    { testCaseId: 'TC-003', file: 'scripts/TC-003.spec.ts', status: 'invalid', validationOutcome: null, attempts: 3, attemptLog: [{ ...attempt, error: 'x', category: 'locator' }], failureCategory: 'locator' },
    { testCaseId: 'TC-004', file: 'scripts/TC-004.spec.ts', status: 'validated', validationOutcome: 'assertion_failed', attempts: 1, attemptLog: [{ ...attempt, error: SUSPECTED_ERROR }], failureCategory: null },
  ] }));
  for (const [stage, start, end] of [['prd', '10:00', '10:03'], ['cases', '10:03', '10:05'], ['scripts', '10:05', '10:50']] as const) {
    await setStage(dir, stage, { status: 'done', startedAt: `2026-10-24T${start}:00.000Z`, finishedAt: `2026-10-24T${end}:00.000Z` });
  }
  const call = (purpose: string, ts: string, costUsd: number | null) => JSON.stringify({ ...example('llm-call.json'), purpose, ts: `2026-10-24T${ts}:00.000Z`, costUsd });
  await writeFile(paths.llmCalls, [call('prd', '10:01', 0.01), call('prd', '10:02', 0.02), call('cases', '10:04', null), call('scripts', '10:10', 0.5), call('prd', '12:00', 9)].join('\n') + '\n');

  // x-01: golden, all passed.
  const x1 = paths.executionDir('x-01');
  await mkdir(x1, { recursive: true });
  await writeFile(paths.results('x-01'), JSON.stringify(results('x-01', [result('TC-001', 'passed'), result('TC-002', 'passed')], [{ testCaseId: 'TC-003', reason: 'invalid' }])));
  await setExecution(dir, { execId: 'x-01', ref: 'golden', commit: COMMIT, executeStatus: 'done', analyzeStatus: 'done' });

  // x-02: patched, TC-001 fails with evidence and a diagnosis.
  const x2 = paths.executionDir('x-02');
  const art = path.join(x2, 'artifacts', 'TC-001');
  await mkdir(art, { recursive: true });
  await writeFile(path.join(art, 'screenshot.png'), PNG);
  await writeFile(path.join(art, 'trace.zip'), 'zip');
  await writeFile(path.join(art, 'backend.log'), `${'x'.repeat(12_000)}\nPOST /api/auth/login 200\n`);
  await writeFile(path.join(art, 'last-response.json'), '{"status":200}');
  const failed = result('TC-001', 'failed', {
    error: { message: 'Error: E1\n\nexpect(received).toBe(expected)\n\nExpected: 400\nReceived: 200', expectationId: 'E1', category: 'assertion_failed' },
    artifacts: { screenshot: 'artifacts/TC-001/screenshot.png', trace: 'artifacts/TC-001/trace.zip', serverLog: 'artifacts/TC-001/backend.log', lastResponse: 'artifacts/TC-001/last-response.json' },
  });
  await writeFile(paths.results('x-02'), JSON.stringify(results('x-02', [failed, result('TC-002', 'passed')], [{ testCaseId: 'TC-003', reason: 'invalid' }])));
  const diagnosis = { ...example('diagnoses.json').diagnoses[0], id: 'DX-001', testCaseIds: ['TC-001'], summary: `Login accepts any password ${EVIL}` };
  await writeFile(paths.diagnoses('x-02'), JSON.stringify({ ...example('diagnoses.json'), execId: 'x-02', diagnoses: [diagnosis],
    summary: { groups: 1, sessions: 1, failedSessions: 0, calls: 5, toolCalls: 6, costUsd: 0.0015, durationMs: 17000 } }));
  await setExecution(dir, { execId: 'x-02', ref: 'golden', commit: COMMIT, patch: 'targets/mern-ecommerce/dev-bugs/dev-001-login.patch', executeStatus: 'done', analyzeStatus: 'done' });

  // x-03: failed before writing results.
  await setExecution(dir, { execId: 'x-03', ref: 'golden', commit: COMMIT, skipSeed: true, executeStatus: 'failed', analyzeStatus: 'pending', error: 'Error: boom' });

  // x-04: files written by an older version.
  const x4 = paths.executionDir('x-04');
  await mkdir(x4, { recursive: true });
  await copyFile(new URL('../fixtures/older/results-before-isolation.json', import.meta.url), paths.results('x-04'));
  const older = example('diagnoses.json');
  delete older.summary;
  await writeFile(paths.diagnoses('x-04'), JSON.stringify({ ...older, execId: 'x-04' }));
  await setExecution(dir, { execId: 'x-04', ref: 'golden', commit: COMMIT, executeStatus: 'done', analyzeStatus: 'done' });
  void x1;
  return { runsDir, runId, dir, paths };
}
