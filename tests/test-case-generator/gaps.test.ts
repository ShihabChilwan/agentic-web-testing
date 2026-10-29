import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeLLMClient } from '../../src/llm/fake.js';
import type { ChatRequest, ChatResponse } from '../../src/llm/types.js';
import { describesEndpoint, endpointRoundProblems, relatesToEndpoint, sharesResource } from '../../src/modules/test-case-generator/generate.js';
import { describeGaps, describeMeasurement, endpointReach, generateGaps, measureEndpoints } from '../../src/modules/test-case-generator/gaps.js';
import type { MeasureCoverageOptions } from '../../src/modules/execution-engine/coverage.js';
import { parseLLMConfig } from '../../src/shared/config.js';
import { createRun, llmSettings, readRunManifest, setStage } from '../../src/shared/run-manifest.js';
import { CoverageReport, TestCases } from '../../src/shared/schemas.js';
import type { Prd, PrdRequirement } from '../../src/shared/schemas.js';
import { example } from '../shared/schemas/helpers.js';

let root: string;
let commit: string;

const ITEMS_JS = [
  "const router = require('express').Router();",
  "router.get('/', async (req, res) => {",
  "  res.status(200).json({ items: [{ name: 'Hat' }] });",
  '});',
  '',
  "router.get('/:id', async (req, res) => {",
  "  if (!req.params.id) return res.status(404).json({ error: 'No item found.' });",
  "  res.status(200).json({ item: { name: 'Hat' } });",
  '});',
].join('\n');

// A route behind a disabled feature: the switch is named in the route's own lines.
const MAIL_JS = ["router.post('/notify',", '  auth.featureAccess([env.MAILGUN_KEY]),', '  notify);'].join('\n');

const llmConfig = parseLLMConfig({ LLM_BASE_URL: 'http://model.test/v1' });
const config = (coverage = true) => {
  const c = structuredClone(example('target.config.json'));
  c.name = 'fake';
  c.repoPath = 'targets/fake/repo';
  delete c.facts;
  if (coverage) c.coverage = { kind: 'node-v8' };
  return c;
};

const ev = (lines: [number, number]) => [{ file: 'server/items.js', lines }];
const requirements: PrdRequirement[] = [
  { id: 'REQ-001', featureId: 'F-01', layer: 'api', priority: 'high', statement: 'GET /api/items lists the items.', acceptanceCriteria: [{ text: 'Status 200 with items', evidence: ev([2, 4]) }] },
  // Names no path: it describes GET /api/items/:id through its evidence.
  { id: 'REQ-002', featureId: 'F-01', layer: 'api', priority: 'medium', statement: 'One item can be read by its id.', acceptanceCriteria: [{ text: 'Status 200 with the item', evidence: ev([6, 9]) }] },
];
const endpoints: Prd['apiEndpoints'] = [
  { method: 'GET', path: '/api/items', authRequired: false, summary: 'Lists items.', responses: [{ status: 200, description: 'items' }], evidence: ev([2, 4]) },
  { method: 'GET', path: '/api/items/:id', authRequired: false, summary: 'Reads one item.', responses: [{ status: 200, description: 'item' }], evidence: ev([6, 9]) },
];
const prd = (): Prd => ({
  schemaVersion: '1.0', target: 'fake', sourceRef: 'golden', generatedAt: '2026-10-25T10:00:00Z',
  features: [{ id: 'F-01', name: 'Items', description: 'Items can be listed and read.' }],
  apiEndpoints: endpoints, uiRoutes: [], requirements, assumptions: [], openQuestions: [],
});

const draft = (over: Record<string, unknown> = {}) => ({
  requirementIds: ['REQ-001'], title: 'Items are listed', layer: 'api', category: 'functional', priority: 'high',
  preconditions: [], fixturesUsed: [], steps: ['Send GET /api/items'],
  expected: [{ description: 'Status 200', value: 200 }, { description: 'First item name', value: 'Hat' }],
  ...over,
});
const existing = TestCases.parse({
  schemaVersion: '1.0', generatedAt: '2026-10-25T10:00:00Z',
  testCases: [{ id: 'TC-001', ...draft(), expected: draft().expected.map((e, i) => ({ id: `E${i + 1}`, ...e })) }],
  coverage: { requirementsTotal: 2, requirementsCovered: 1, uncovered: [{ requirementId: 'REQ-002', reasonKind: 'other', reason: 'No test case after the gap round.' }], partial: [] },
});

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'gaps-'));
  const repoDir = path.join(root, 'targets', 'fake', 'repo');
  await mkdir(path.join(repoDir, 'server'), { recursive: true });
  await writeFile(path.join(repoDir, 'server', 'items.js'), ITEMS_JS);
  await writeFile(path.join(repoDir, 'server', 'mail.js'), MAIL_JS);
  await writeFile(path.join(root, 'targets', 'fake', 'target.config.json'), JSON.stringify(config()));
  const git = (...args: string[]) => execFileSync('git', ['-C', repoDir, '-c', 'user.name=t', '-c', 'user.email=t@x.test', ...args], { encoding: 'utf8' });
  git('init', '--quiet');
  git('add', '.');
  git('commit', '--quiet', '-m', 'golden');
  commit = git('rev-parse', 'HEAD').trim();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The scripts manifest of a run: TC-001 passed its dry run, its source is `source`. */
async function writeScripts(paths: { dir: string; scriptsDir: string; scriptsManifest: string }, source = '// a script that sends nothing\n') {
  await mkdir(paths.scriptsDir, { recursive: true });
  await writeFile(path.join(paths.scriptsDir, 'TC-001.spec.ts'), source);
  const entry = { testCaseId: 'TC-001', file: 'scripts/TC-001.spec.ts', status: 'validated', validationOutcome: 'passed', attempts: 1, attemptLog: [{ attempt: 1, stage: 'dry-run', error: null, durationMs: 10 }] };
  await writeFile(paths.scriptsManifest, JSON.stringify({ schemaVersion: '1.0', generationRef: 'golden', scripts: [entry] }));
}

/** A run whose scripts stage is done, with one test case for REQ-001. */
async function makeRun(scripts: 'done' | 'failed' = 'done', source?: string) {
  const runsDir = await mkdtemp(path.join(root, 'runs-'));
  const { runId, paths } = await createRun({ target: 'fake', generationRef: 'golden', generationCommit: commit, llm: llmSettings(llmConfig), runsDir });
  await writeFile(paths.prd, JSON.stringify(prd()));
  await writeFile(paths.testCases, JSON.stringify(existing));
  await setStage(paths.dir, 'scripts', { status: scripts, startedAt: '2026-10-25T10:00:00.000Z', finishedAt: '2026-10-25T10:30:00.000Z' });
  await writeScripts(paths, source);
  return { runId, runsDir, paths };
}

/** The measurement: only the list handler ran (lines 2-3). */
const measured: Array<MeasureCoverageOptions> = [];
const measure = async (options: MeasureCoverageOptions) => {
  measured.push(options);
  return {
    commit,
    processes: 3,
    files: { 'server/items.js': [2, 3] },
    results: { summary: { total: 1, passed: 1, failed: 0, errored: 0, skipped: 0, notIsolated: 0 } } as never,
  };
};

const submit = (testCases: unknown[], declined: unknown[] = []) => FakeLLMClient.toolCall('submit_test_cases', { testCases, declined });

function fakeModel(responses: ChatResponse[]) {
  const tasks: string[] = [];
  const respond = (req: ChatRequest): ChatResponse => {
    const first = req.messages[0];
    if (req.messages.length === 1 && first?.role === 'user' && first.content[0]?.type === 'text') tasks.push(first.content[0].text);
    const next = responses.shift();
    if (!next) throw new Error('no scripted response');
    return next;
  };
  return { llm: new FakeLLMClient(Array.from({ length: 10 }, () => respond)), tasks };
}

describe('which endpoints a test reached', () => {
  it('an endpoint is reached when a line of its evidence ran', () => {
    expect(endpointReach(endpoints, { 'server/items.js': [3] }).map((e) => e.reached)).toEqual([true, false]);
    expect(endpointReach(endpoints, {}).map((e) => e.reached)).toEqual([false, false]);
  });

  it('a requirement describes an endpoint by naming it or by overlapping evidence', () => {
    expect(describesEndpoint(requirements[0]!, endpoints[0]!, endpoints)).toBe(true);
    expect(describesEndpoint(requirements[0]!, endpoints[1]!, endpoints)).toBe(false);
    expect(describesEndpoint(requirements[1]!, endpoints[1]!, endpoints)).toBe(true);
  });

  it('the endpoint round needs a case calling each endpoint, or a decline of a requirement describing it', () => {
    const asked = [endpoints[1]!];
    const sub = (testCases: unknown[], declined: unknown[] = []) => ({ testCases, declined }) as never;
    expect(endpointRoundProblems(sub([draft()]), asked, requirements, endpoints)).toEqual([
      'No api test case calls GET /api/items/:id; add one with a step that sends it (e.g. "Send GET /api/items/:id" with real values for its parameters) and checks what it returns, or decline the requirement that describes it with the reason',
    ]);
    expect(endpointRoundProblems(sub([draft({ steps: ['Send GET /api/items/42'] })]), asked, requirements, endpoints)).toEqual([]);
    expect(endpointRoundProblems(sub([], [{ requirementId: 'REQ-002', reasonKind: 'other', reason: 'x' }]), asked, requirements, endpoints)).toEqual([]);
  });
});

describe('generateGaps', () => {
  const options = (runsDir: string, llm: FakeLLMClient, runId: string) => ({
    runId, runsDir, targetsDir: path.join(root, 'targets'), projectRoot: root, llmConfig, createLlm: async () => llm, measure,
  });

  it('measures, asks for the unreached endpoint, appends the new case with the next id and sets the scripts stage to resume', async () => {
    const { runId, runsDir, paths } = await makeRun();
    const readOne = draft({ requirementIds: ['REQ-002'], title: 'One item is read', priority: 'medium', steps: ['Send GET /api/items/42'] });
    const { llm, tasks } = fakeModel([submit([draft()]), submit([readOne])]);
    const result = await generateGaps(options(runsDir, llm, runId));

    expect(measured.at(-1)).toMatchObject({ generationRef: 'golden', runDir: paths.dir });
    expect(tasks[0]).toContain('Measured with code coverage, no test reaches these endpoints yet: GET /api/items/:id.');
    expect(tasks[0]).toContain('Link each case to the listed requirement closest in meaning');
    expect(tasks[0]).toContain('- REQ-002');
    expect(tasks[0]).not.toContain('- REQ-001 ');
    const coverage = CoverageReport.parse(JSON.parse(await readFile(paths.coverage, 'utf8')));
    expect(coverage).toMatchObject({ kind: 'node-v8', generationCommit: commit, scripts: { run: 1, passed: 1 }, processes: 3, files: { 'server/items.js': { lines: [2, 3] } } });
    expect(coverage.endpoints.map((e) => e.reached)).toEqual([true, false]);

    const file = TestCases.parse(JSON.parse(await readFile(paths.testCases, 'utf8')));
    expect(file.testCases.map((c) => [c.id, c.requirementIds[0]])).toEqual([['TC-001', 'REQ-001'], ['TC-002', 'REQ-002']]);
    expect(file.testCases[0]).toEqual(existing.testCases[0]); // existing cases keep their id and content, so their scripts stay valid
    expect(file.coverage).toMatchObject({ requirementsCovered: 2, uncovered: [], partial: [] });
    expect(result.added).toEqual(['TC-002']);

    const manifest = await readRunManifest(paths.runJson);
    expect(manifest.stages.scripts?.status).toBe('pending');
    expect(manifest.stages.gaps).toMatchObject({
      status: 'done',
      gaps: { endpoints: { total: 2, reached: 1 }, unreached: ['GET /api/items/:id'], asked: ['GET /api/items/:id'], casesAdded: 1, sessions: 1, rejected: { checkFailed: 1 } },
    });
    expect(describeGaps(result)).toEqual([
      'API endpoints reached by a passing script: 1 of 2 (scripts run 1, passed 1)',
      'not reached: GET /api/items/:id',
      'endpoint round: 1 endpoints asked in 1 sessions; 1 test cases added (TC-002..TC-002)',
      '2 model calls, cost unknown; rejected submits: 0 invalid input, 1 failed checks',
      `Next: npm run agent -- scripts --run ${runId} --redo none (writes scripts for the new cases only)`,
    ]);
  });

  it('adds nothing and leaves testcases.json and the scripts stage alone when every endpoint was reached', async () => {
    const { runId, runsDir, paths } = await makeRun();
    const { llm } = fakeModel([]);
    const before = await readFile(paths.testCases, 'utf8');
    const all = async (o: MeasureCoverageOptions) => ({ ...(await measure(o)), files: { 'server/items.js': [3, 8] } });
    const result = await generateGaps({ ...options(runsDir, llm, runId), measure: all });
    expect(result.summary).toMatchObject({ endpoints: { total: 2, reached: 2 }, asked: [], casesAdded: 0, sessions: 0 });
    expect(await readFile(paths.testCases, 'utf8')).toBe(before);
    expect((await readRunManifest(paths.runJson)).stages.scripts?.status).toBe('done');
  });

  it('--measure-only writes coverage.json and adds nothing: no model call, no stage change', async () => {
    const { runId, runsDir, paths } = await makeRun();
    const before = await readFile(paths.testCases, 'utf8');
    const stagesBefore = (await readRunManifest(paths.runJson)).stages;
    const result = await measureEndpoints({ runId, runsDir, targetsDir: path.join(root, 'targets'), projectRoot: root, measure });
    expect(result.coverage.endpoints.map((e) => e.reached)).toEqual([true, false]);
    expect(CoverageReport.parse(JSON.parse(await readFile(paths.coverage, 'utf8'))).endpoints).toEqual(result.coverage.endpoints);
    expect(await readFile(paths.testCases, 'utf8')).toBe(before);
    expect((await readRunManifest(paths.runJson)).stages).toEqual(stagesBefore);
    expect(describeMeasurement(result)).toEqual([
      'API endpoints reached by a passing script: 1 of 2 (scripts run 1, passed 1)',
      'not reached: GET /api/items/:id',
      `written: runs/${runId}/coverage/coverage.json (no test cases added)`,
    ]);
  });

  it('needs a finished scripts stage, and a coverage setting in the target config', async () => {
    const unfinished = await makeRun('failed');
    await expect(generateGaps(options(unfinished.runsDir, fakeModel([]).llm, unfinished.runId))).rejects.toThrow(/scripts stage of .* is failed, not done/);
    const { runId, runsDir, paths } = await makeRun();
    await writeFile(path.join(root, 'targets', 'fake', 'target.config.json'), JSON.stringify(config(false)));
    try {
      await expect(generateGaps(options(runsDir, fakeModel([]).llm, runId))).rejects.toThrow(/no "coverage" setting/);
      expect((await readRunManifest(paths.runJson)).stages.gaps).toBeUndefined();
    } finally {
      await writeFile(path.join(root, 'targets', 'fake', 'target.config.json'), JSON.stringify(config()));
    }
  });
});

describe('endpoints of one resource, and endpoints behind a disabled setting (replayed on a recorded PRD)', () => {
  const slice = JSON.parse(readFileSync(new URL('../fixtures/gaps/recorded-api-slice.json', import.meta.url), 'utf8')) as {
    apiEndpoints: Prd['apiEndpoints'];
    requirements: PrdRequirement[];
    reached: boolean[];
  };
  const find = (method: string, p: string) => slice.apiEndpoints.find((e) => e.method === method && e.path === p)!;
  const relatedIds = (e: Prd['apiEndpoints'][number]) => slice.requirements.filter((r) => relatesToEndpoint(r, e, slice.apiEndpoints, '/api/v2')).map((r) => r.id);

  it('two endpoints share a resource when two leading literal segments after the prefix match', () => {
    const e = (p: string) => ({ ...endpoints[0]!, path: p });
    expect(sharesResource(e('/api/v2/links/admin/{id}'), e('/api/v2/links/admin/ban/{id}'), '/api/v2')).toBe(true);
    expect(sharesResource(e('/api/v2/domains/admin/{id}'), e('/api/v2/domains/admin'), '/api/v2')).toBe(true);
    expect(sharesResource(e('/api/v2/links/{id}'), e('/api/v2/links/{id}/stats'), '/api/v2')).toBe(false); // one literal segment
    expect(sharesResource(e('/api/v2/auth/new-password'), e('/api/v2/auth/reset-password'), '/api/v2')).toBe(false);
    expect(sharesResource(e('/api/v2/domains/{id}'), e('/api/v2/domains/admin/{id}'), '/api/v2')).toBe(false);
  });

  it('the three endpoints no requirement named now get the requirement of a sibling; the others are unchanged', () => {
    expect(slice.requirements.filter((r) => describesEndpoint(r, find('DELETE', '/api/v2/domains/admin/{id}'), slice.apiEndpoints))).toEqual([]); // before
    expect(relatedIds(find('DELETE', '/api/v2/domains/admin/{id}'))).toEqual(['REQ-033']);
    expect(relatedIds(find('POST', '/api/v2/domains/admin/ban/{id}'))).toEqual(['REQ-033']);
    expect(relatedIds(find('PATCH', '/api/v2/links/admin/{id}'))).toEqual(['REQ-016', 'REQ-017']);
    // Nothing shares a resource with this one, so it stays unasked and is reported as such.
    expect(relatedIds(find('POST', '/api/v2/auth/new-password'))).toEqual([]);
    // An endpoint a requirement already named keeps exactly that requirement.
    expect(relatedIds(find('POST', '/api/v2/links/report'))).toEqual(['REQ-036']);
  });

  it('a decline of a sibling requirement settles the endpoint round for the endpoints it covers', () => {
    const asked = [find('DELETE', '/api/v2/domains/admin/{id}')];
    const problems = (declined: string[]) => endpointRoundProblems({ testCases: [], declined: declined.map((requirementId) => ({ requirementId, reasonKind: 'other', reason: 'x' })) } as never, asked, slice.requirements, slice.apiEndpoints, '/api/v2');
    expect(problems([])).toHaveLength(1);
    expect(problems(['REQ-033'])).toEqual([]);
  });

});

describe('generateGaps with an endpoint behind a disabled setting', () => {
  async function run(scriptSource: string) {
    const runsDir = await mkdtemp(path.join(root, 'runs-'));
    const { runId, paths } = await createRun({ target: 'fake', generationRef: 'golden', generationCommit: commit, llm: llmSettings(llmConfig), runsDir });
    const gatedEndpoint = { ...endpoints[0]!, method: 'POST' as const, path: '/api/items/notify', evidence: [{ file: 'server/mail.js', lines: [1, 3] as [number, number] }] };
    const withGated: Prd = { ...prd(), apiEndpoints: [...endpoints, gatedEndpoint] };
    const notifyReq: PrdRequirement = { id: 'REQ-003', featureId: 'F-01', layer: 'api', priority: 'low', statement: 'POST /api/items/notify sends a notification.', acceptanceCriteria: [{ text: 'Status 200', evidence: [{ file: 'server/mail.js', lines: [1, 3] }] }] };
    await writeFile(paths.prd, JSON.stringify({ ...withGated, requirements: [...requirements, notifyReq] }));
    await writeFile(paths.testCases, JSON.stringify(existing));
    await setStage(paths.dir, 'scripts', { status: 'done', startedAt: '2026-10-25T10:00:00.000Z', finishedAt: '2026-10-25T10:30:00.000Z' });
    await writeScripts(paths, scriptSource);
    const readOne = draft({ requirementIds: ['REQ-002'], title: 'One item is read', steps: ['Send GET /api/items/42'] });
    const notify = draft({ requirementIds: ['REQ-003'], title: 'Notify', steps: ['Send POST /api/items/notify', 'Send GET /api/items'], expected: [{ description: 'Status 200', value: 200 }, { description: 'The list still has the item', value: 'Hat', readBack: true }] });
    // The session asked for both endpoints needs a case for each; the other asks for one.
    const { llm, tasks } = fakeModel([submit(scriptSource.includes('notify') ? [readOne] : [readOne, notify])]);
    const result = await generateGaps({ runId, runsDir, targetsDir: path.join(root, 'targets'), projectRoot: root, llmConfig, createLlm: async () => llm, measure });
    return { result, tasks, paths };
  }

  it('does not ask for it when a passing script already sends it and it was turned away; counts it apart and names the setting', async () => {
    const { result, tasks, paths } = await run("await api.post('/api/items/notify', { data: {} });\n");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toContain('no test reaches these endpoints yet: GET /api/items/:id.'); // the round lists only this one
    expect(result.summary).toMatchObject({ endpoints: { total: 3, reached: 1 }, asked: ['GET /api/items/:id'], gated: ['POST /api/items/notify (MAILGUN_KEY)'] });
    expect(result.summary.unreached).toContain('POST /api/items/notify');
    expect(result.summary.warnings.join('\n')).not.toContain('notify');
    expect(CoverageReport.parse(JSON.parse(await readFile(paths.coverage, 'utf8'))).endpoints.map((e) => e.gatedBy)).toEqual([undefined, undefined, 'MAILGUN_KEY']);
    expect(describeGaps(result)).toContain('not asked for, turned away behind a disabled setting: POST /api/items/notify (MAILGUN_KEY)');
  });

  it('still asks for it when no passing script sends it: a mention of the setting alone proves nothing', async () => {
    const { result, tasks } = await run('// nothing is sent\n');
    expect(result.summary.gated).toEqual([]);
    expect(result.summary.asked).toEqual(['GET /api/items/:id', 'POST /api/items/notify']);
    expect(tasks.join('\n')).toContain('POST /api/items/notify');
  });
});

describe('an endpoint whose evidence is only its route declaration', () => {
  it('is counted as reached when a passing script sends it, and asked for when none does', async () => {
    const asRoute = (source: string) => makeRun('done', source);
    const routeOnly = { ...endpoints[1]!, evidence: [{ file: 'server/mail.js', lines: [1, 1] as [number, number] }] }; // "router.post('/notify'," : no function body
    const measureRoute = async () => {
      const { runId, runsDir, paths } = await asRoute("await api.get('/api/items/42');\n");
      await writeFile(paths.prd, JSON.stringify({ ...prd(), apiEndpoints: [endpoints[0]!, routeOnly] }));
      const result = await measureEndpoints({ runId, runsDir, targetsDir: path.join(root, 'targets'), projectRoot: root, measure });
      return result;
    };
    const sent = await measureRoute();
    expect(sent.coverage.endpoints.map((e) => [e.reached, e.observed])).toEqual([[true, undefined], [true, true]]);
    expect(describeMeasurement(sent)).toContain('counted as reached by request (evidence has no code coverage can see): GET /api/items/:id');
    const { runId, runsDir, paths } = await asRoute('// nothing is sent\n');
    await writeFile(paths.prd, JSON.stringify({ ...prd(), apiEndpoints: [endpoints[0]!, routeOnly] }));
    const notSent = await measureEndpoints({ runId, runsDir, targetsDir: path.join(root, 'targets'), projectRoot: root, measure });
    expect(notSent.coverage.endpoints.map((e) => e.reached)).toEqual([true, false]);
  });
});
