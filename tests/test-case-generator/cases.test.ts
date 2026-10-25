import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeCasesSummary } from '../../src/modules/test-case-generator/generate.js';
import { FakeLLMClient } from '../../src/llm/fake.js';
import type { ChatRequest, ChatResponse } from '../../src/llm/types.js';
import { checkSubmission, fixtureExists, isGrounded, isGroundedIn, missingNegativeCases } from '../../src/modules/test-case-generator/checks.js';
import { collectEvidence, groundingText } from '../../src/modules/test-case-generator/context.js';
import { buildSystemPrompt, featureQuotas, generateTestCases } from '../../src/modules/test-case-generator/index.js';
import { parseLLMConfig } from '../../src/shared/config.js';
import { createRun, latestRunWith, llmSettings, readRunManifest, setStage } from '../../src/shared/run-manifest.js';
import { PageSnapshots, TargetConfig, TestCases } from '../../src/shared/schemas.js';
import type { Prd } from '../../src/shared/schemas.js';
import type { PrdRequirement } from '../../src/shared/schemas.js';
import { example } from '../shared/schemas/helpers.js';

// A tiny target: a git repo whose committed files differ from the working tree, so the tests
// can prove that evidence comes from the generation commit, not from whatever is checked out.
let root: string;
let repoDir: string;
let commit: string;

const AUTH_JS = [
  "const router = require('express').Router();",
  ...Array.from({ length: 8 }, (_, i) => `// setup ${i + 2}`),
  "router.post('/login', async (req, res) => {",
  '  if (!req.body.email) {',
  "    return res.status(400).json({ error: 'You must enter an email address.' });",
  '  }',
  '  res.status(200).json({ success: true });',
  '});',
  ...Array.from({ length: 14 }, (_, i) => `// more ${i + 16}`),
].join('\n');
const LOGIN_JS = ['export default function Login() {', "  return <h1>Please sign in</h1>;", '}', ...Array.from({ length: 7 }, (_, i) => `// ${i + 4}`)].join('\n');

const llmConfig = parseLLMConfig({ LLM_BASE_URL: 'http://model.test/v1' });
const config = () => {
  const c = structuredClone(example('target.config.json'));
  c.name = 'fake';
  c.repoPath = 'targets/fake/repo';
  return c;
};
const target = TargetConfig.parse(config());

const criterion = (text: string, file: string, lines: [number, number]) => ({ text, evidence: [{ file, lines }] });
const requirements: PrdRequirement[] = [
  {
    id: 'REQ-001', featureId: 'F-01', layer: 'api', priority: 'high',
    statement: 'Logging in without an email is rejected.',
    acceptanceCriteria: [criterion('The response is 400 with an error', 'server/auth.js', [10, 14])],
  },
  {
    id: 'REQ-002', featureId: 'F-01', layer: 'ui', priority: 'medium',
    statement: 'The sign-in page shows a heading.',
    acceptanceCriteria: [criterion('The heading is visible', 'client/app/Login.js', [1, 3])],
  },
  {
    id: 'REQ-003', featureId: 'F-02', layer: 'e2e', priority: 'medium',
    statement: 'A password reset link from the email lets the user set a new password.',
    acceptanceCriteria: [
      criterion('The reset form accepts the token', 'server/auth.js', [10, 14]),
      criterion('The reset page is shown', 'client/app/Login.js', [1, 3]),
    ],
  },
];
const prd = (): Prd => ({
  schemaVersion: '1.0', target: 'fake', sourceRef: 'golden', generatedAt: '2026-10-24T10:00:00Z',
  features: [
    { id: 'F-01', name: 'Sign-in', description: 'Users sign in.' },
    { id: 'F-02', name: 'Password reset', description: 'Users reset a forgotten password.' },
  ],
  apiEndpoints: [
    { method: 'POST', path: '/api/auth/login', authRequired: false, summary: 'Logs in with email and password and returns a token.', responses: [{ status: 200, description: 'token' }], evidence: [{ file: 'server/auth.js', lines: [10, 15] }] },
    { method: 'POST', path: '/api/items', authRequired: true, summary: 'Admins create an item.', request: { body: { item: { name: 'string' } } }, responses: [{ status: 200, description: 'created' }], evidence: [{ file: 'server/auth.js', lines: [1, 2] }] },
  ],
  uiRoutes: [], requirements, assumptions: [], openQuestions: [],
});

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cases-gen-'));
  repoDir = path.join(root, 'targets', 'fake', 'repo');
  await mkdir(path.join(repoDir, 'server'), { recursive: true });
  await mkdir(path.join(repoDir, 'client', 'app'), { recursive: true });
  await writeFile(path.join(repoDir, 'server', 'auth.js'), AUTH_JS);
  await writeFile(path.join(repoDir, 'client', 'app', 'Login.js'), LOGIN_JS);
  await writeFile(path.join(root, 'targets', 'fake', 'target.config.json'), JSON.stringify(config()));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repoDir, '-c', 'user.name=t', '-c', 'user.email=t@x.test', ...args], { encoding: 'utf8' });
  git('init', '--quiet');
  git('add', '.');
  git('commit', '--quiet', '-m', 'golden');
  commit = git('rev-parse', 'HEAD').trim();
  await writeFacts(commit);
  // The working tree now holds something else (e.g. a variant): evidence must not come from it.
  await writeFile(path.join(repoDir, 'server', 'auth.js'), AUTH_JS.replace('You must enter an email address.', 'WORKING TREE TEXT'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const factsFile = () => path.join(root, 'targets', 'fake', 'facts.json');
/** facts.json observed at the given commit: a role refusal and a seeded product list. */
async function writeFacts(goldenCommit: string) {
  await writeFile(
    factsFile(),
    JSON.stringify({
      schemaVersion: '1.0', target: 'fake', goldenCommit, observedAt: '2026-10-24T10:00:00Z',
      facts: [
        { name: 'itemsAsMember', request: { method: 'GET', path: '/api/items', as: 'users.alice' }, status: 403, body: 'Only admins may do this.', truncated: false },
        { name: 'productList', request: { method: 'GET', path: '/api/products', as: null }, status: 200, body: { products: [{ name: 'Rustic Granite Hat', price: 943, isActive: true }], count: 100 }, truncated: true },
      ],
    }),
  );
}

/** A fresh run with the given prd.json; each test gets its own runs folder. */
async function makeRun(prdJson: unknown = prd()) {
  const runsDir = await mkdtemp(path.join(root, 'runs-'));
  const { runId, paths } = await createRun({ target: 'fake', generationRef: 'golden', generationCommit: commit, llm: llmSettings(llmConfig), runsDir });
  await writeFile(paths.prd, JSON.stringify(prdJson));
  return { runId, runsDir, paths };
}

const tc = (over: Record<string, unknown> = {}) => ({
  requirementIds: ['REQ-001'],
  title: 'Login without email is rejected',
  layer: 'api',
  category: 'error-handling',
  priority: 'high',
  preconditions: [],
  fixturesUsed: ['users.alice'],
  steps: ['Send POST /api/auth/login without an email'],
  expected: [
    { description: 'Status is 400', value: 400 },
    { description: 'Error text', value: 'You must enter an email address.' },
  ],
  ...over,
});
const uiCase = (over: Record<string, unknown> = {}) =>
  tc({ requirementIds: ['REQ-002'], title: 'Heading shows', layer: 'ui', category: 'functional', priority: 'medium',
    expected: [{ description: 'Heading', value: 'Please sign in' }], ...over });
const submit = (testCases: unknown[], declined: unknown[] = []) => FakeLLMClient.toolCall('submit_test_cases', { testCases, declined });

/**
 * A fake model that answers per session: the key is the feature id, with "gap:" for the gap round.
 * Sessions run in parallel, so the order of calls between features is not fixed.
 */
function fakeBySession(script: Record<string, ChatResponse[]>) {
  const tasks: Record<string, string> = {};
  const respond = (req: ChatRequest): ChatResponse => {
    const first = req.messages[0];
    const task = first?.role === 'user' && first.content[0]?.type === 'text' ? first.content[0].text : '';
    const feature = /feature (F-\d+)/.exec(task)?.[1] ?? '?';
    const round = task.includes('No test case opens these pages yet') ? 'page:' : task.includes('got no test case') ? 'gap:' : '';
    const key = `${round}${round === 'page:' ? (/Feature (F-\d+)/.exec(task)?.[1] ?? '?') : feature}`;
    tasks[key] = task;
    const next = script[key]?.shift();
    if (!next) throw new Error(`no scripted response for ${key}`);
    return next;
  };
  return { llm: new FakeLLMClient(Array.from({ length: 30 }, () => respond)), tasks };
}

/** Page snapshots the fake app returns, by path (unknown paths: the page cannot be opened). */
let fakePages: Record<string, string> = {};
let appStarts = 0;
const run = (runsDir: string, llm: FakeLLMClient, runId?: string) =>
  generateTestCases({
    ...(runId ? { runId } : {}),
    runsDir,
    targetsDir: path.join(root, 'targets'),
    projectRoot: root,
    llmConfig,
    createLlm: async () => llm,
    startApp: async () => {
      appStarts++;
      return { stop: async () => {} };
    },
    takeSnapshots: async (_config, requests) => requests.map((r) => (fakePages[r.path] ? { finalPath: r.path, aria: fakePages[r.path]! } : null)),
  });

describe('generateTestCases', () => {
  it('runs one session per feature, assigns ids in code, computes coverage and writes the files', async () => {
    const { runsDir, paths } = await makeRun();
    const { llm, tasks } = fakeBySession({
      'F-01': [submit([uiCase(), tc()])],
      'F-02': [submit([], [{ requirementId: 'REQ-003', reasonKind: 'third-party-disabled', reason: 'The reset token only travels by email.' }])],
    });
    const result = await run(runsDir, llm);

    const file = TestCases.parse(JSON.parse(await readFile(paths.testCases, 'utf8')));
    expect(file.testCases.map((c) => [c.id, c.requirementIds[0]])).toEqual([['TC-001', 'REQ-001'], ['TC-002', 'REQ-002']]);
    expect(file.coverage).toEqual({
      requirementsTotal: 3,
      requirementsCovered: 2,
      uncovered: [{ requirementId: 'REQ-003', reasonKind: 'third-party-disabled', reason: 'The reset token only travels by email.' }],
      partial: [],
      pages: { total: 0, opened: 0, unopened: [] }, // this PRD lists no pages
    });
    expect(result.summary).toMatchObject({
      sessions: 2,
      calls: 2,
      casesByLayer: { api: 1, ui: 1 },
      casesByCategory: { 'error-handling': 1, functional: 1, boundary: 0, auth: 0, 'e2e-journey': 0 },
      uncoveredByReasonKind: { 'third-party-disabled': 1, 'data-not-reachable': 0, 'out-of-scope': 0, other: 0 },
      rejected: { invalidInput: 0, checkFailed: 0 },
      costUsd: null,
      warnings: [],
    });
    const manifest = await readRunManifest(paths.runJson);
    expect(manifest.stages.cases).toMatchObject({ status: 'done', generation: result.summary });

    // The task carries the code at the generation commit (not the working tree), fixtures and limits.
    expect(tasks['F-01']).toContain('12:     return res.status(400).json({ error: \'You must enter an email address.\' });');
    expect(tasks['F-01']).not.toContain('WORKING TREE TEXT');
    expect(tasks['F-01']).toContain('"alice@example.test"');
    expect(tasks['F-01']).toContain('At most 100 test cases');
  });

  it('numbers expectations in code and fills in the title and empty lists the model left out', async () => {
    const { runsDir, paths } = await makeRun();
    const bare = { ...tc() } as Record<string, unknown>;
    delete bare.preconditions;
    delete bare.fixturesUsed;
    delete bare.title;
    const { llm } = fakeBySession({
      'F-01': [submit([bare, uiCase()])],
      'F-02': [submit([], [{ requirementId: 'REQ-003', reasonKind: 'third-party-disabled', reason: 'Email only.' }])],
    });
    const result = await run(runsDir, llm);
    expect(result.summary.rejected).toEqual({ invalidInput: 0, checkFailed: 0 });
    const file = TestCases.parse(JSON.parse(await readFile(paths.testCases, 'utf8')));
    expect(file.testCases[0]).toMatchObject({
      title: 'Status is 400', // from the first expectation, as the model left the title out
      preconditions: [],
      fixturesUsed: [],
      expected: [{ id: 'E1', value: 400 }, { id: 'E2' }],
    });
  });

  it('keeps the reason of a partial decline in coverage.partial', async () => {
    const { runsDir } = await makeRun();
    const { llm } = fakeBySession({
      'F-01': [submit([tc(), uiCase()])],
      'F-02': [
        submit(
          [tc({ requirementIds: ['REQ-003'], layer: 'ui', category: 'e2e-journey', priority: 'medium', expected: [{ description: 'An invalid token is rejected' }] })],
          [{ requirementId: 'REQ-003', reasonKind: 'third-party-disabled', reason: 'The happy path needs the emailed token.' }],
        ),
      ],
    });
    const result = await run(runsDir, llm);
    expect(result.testCases.coverage).toMatchObject({
      requirementsCovered: 3,
      uncovered: [],
      partial: [{ requirementId: 'REQ-003', reason: 'The happy path needs the emailed token.' }],
    });
  });

  it('tells the gap round what the failed session got wrong', async () => {
    const { runsDir } = await makeRun();
    const bad = submit([tc({ requirementIds: ['REQ-009'] })]);
    const { llm, tasks } = fakeBySession({
      'F-01': [submit([tc(), uiCase()])],
      'F-02': [bad, bad, bad],
      'gap:F-02': [submit([], [{ requirementId: 'REQ-003', reasonKind: 'third-party-disabled', reason: 'Email only.' }])],
    });
    await run(runsDir, llm);
    expect(tasks['gap:F-02']).toContain('An earlier attempt for these requirements was rejected');
    expect(tasks['gap:F-02']).toContain('- testCases[0].requirementIds: REQ-009 is not one of the requirements given in this task');
    expect(tasks['F-02']).not.toContain('An earlier attempt');
  });

  it('gives every session the observed facts and the endpoint index, and accepts values from the facts', async () => {
    const { runsDir } = await makeRun();
    const { llm, tasks } = fakeBySession({
      'F-01': [
        submit([
          tc({ category: 'auth', expected: [{ description: 'Refused', value: 403 }, { description: 'Message', value: 'Only admins may do this.' }] }),
          uiCase({ expected: [{ description: 'A seeded product is listed', value: 'Rustic Granite Hat' }] }),
        ]),
      ],
      'F-02': [submit([], [{ requirementId: 'REQ-003', reasonKind: 'third-party-disabled', reason: 'Email only.' }])],
    });
    const result = await run(runsDir, llm);
    expect(result.summary.rejected).toEqual({ invalidInput: 0, checkFailed: 0 });
    expect(result.summary.warnings).toEqual([]);
    expect(tasks['F-01']).toContain('## Facts observed on the running application');
    expect(tasks['F-01']).toContain('- itemsAsMember: GET /api/items (logged in as users.alice) → status 403');
    expect(tasks['F-01']).toContain('## Endpoints you may use in steps to set up data');
    expect(tasks['F-01']).toContain('- POST /api/items (login required): Admins create an item.');
    expect(tasks['F-01']).toContain('  sends: body {"item":{"name":"string"}}');
  });

  it('warns when facts.json is missing or was observed at another commit', async () => {
    try {
      await rm(factsFile());
      const missing = await makeRun();
      const one = fakeBySession({
        'F-01': [submit([tc(), uiCase()])],
        'F-02': [submit([], [{ requirementId: 'REQ-003', reasonKind: 'other', reason: 'x' }])],
      });
      expect((await run(missing.runsDir, one.llm)).summary.warnings[0]).toMatch(/^No targets\/fake\/facts.json/);
      expect(one.tasks['F-01']).not.toContain('## Facts observed');

      await writeFacts('0000000');
      const stale = await makeRun();
      const two = fakeBySession({
        'F-01': [submit([tc(), uiCase()])],
        'F-02': [submit([], [{ requirementId: 'REQ-003', reasonKind: 'other', reason: 'x' }])],
      });
      expect((await run(stale.runsDir, two.llm)).summary.warnings[0]).toMatch(/^facts.json was observed at 0000000, .* the facts may be stale$/);
    } finally {
      await writeFacts(commit);
    }
  });

  it('moves the earlier run\'s transcripts aside on a rerun of the stage', async () => {
    const { runsDir, runId, paths } = await makeRun();
    const script = () => ({
      'F-01': [submit([tc(), uiCase()])],
      'F-02': [submit([], [{ requirementId: 'REQ-003', reasonKind: 'other', reason: 'x' }])],
    });
    await run(runsDir, fakeBySession(script()).llm, runId);
    await run(runsDir, fakeBySession(script()).llm, runId);
    const entries = await readdir(paths.transcriptsDir);
    expect(entries.filter((e) => e.startsWith('cases-')).sort()).toEqual(['cases-1.jsonl', 'cases-2.jsonl']);
    const previous = entries.filter((e) => e.startsWith('previous-'));
    expect(previous).toHaveLength(1);
    expect((await readdir(path.join(paths.transcriptsDir, previous[0]!))).sort()).toEqual(['cases-1.jsonl', 'cases-2.jsonl']);
  });

  it('returns failed checks to the model and counts invalid input and failed checks separately', async () => {
    const { runsDir } = await makeRun();
    const { llm } = fakeBySession({
      'F-01': [
        FakeLLMClient.toolCall('submit_test_cases', { testCases: 'not a list', declined: [] }),
        submit([tc({ expected: [{ description: 'x', value: 'Made-up message' }] }), uiCase()]),
        submit([tc(), uiCase()]),
      ],
      'F-02': [submit([], [{ requirementId: 'REQ-003', reasonKind: 'third-party-disabled', reason: 'Email only.' }])],
    });
    const result = await run(runsDir, llm);
    expect(result.summary.rejected).toEqual({ invalidInput: 1, checkFailed: 1 });
    expect(result.summary.calls).toBe(4);
    const retry = llm.requests.find((r) => JSON.stringify(r.messages).includes('Made-up message') && r.messages.length > 2);
    expect(JSON.stringify(retry?.messages)).toContain('is not found in the code, fixtures or observed facts you were given');
  });

  it('sends requirements with no case and no decline to one gap round', async () => {
    const { runsDir } = await makeRun();
    const { llm, tasks } = fakeBySession({
      'F-01': [submit([tc()])],
      'gap:F-01': [submit([uiCase()])],
      'F-02': [submit([])],
      'gap:F-02': [submit([])],
    });
    const result = await run(runsDir, llm);
    expect(tasks['gap:F-01']).toContain('REQ-002');
    expect(tasks['gap:F-01']).not.toContain('- REQ-001');
    expect(result.testCases.coverage.requirementsCovered).toBe(2);
    expect(result.testCases.coverage.uncovered).toEqual([
      { requirementId: 'REQ-003', reasonKind: 'other', reason: 'No test case after the gap round.' },
    ]);
    expect(result.summary.sessions).toBe(4);
    expect(result.summary.warnings).toEqual(['REQ-003 has no test case and no reason from the model']);
  });

  it('leaves a failed session to the gap round and warns about it', async () => {
    const { runsDir } = await makeRun();
    const bad = submit([tc({ requirementIds: ['REQ-009'] })]);
    const { llm } = fakeBySession({
      'F-01': [submit([tc(), uiCase()])],
      'F-02': [bad, bad, bad],
      'gap:F-02': [submit([], [{ requirementId: 'REQ-003', reasonKind: 'third-party-disabled', reason: 'Email only.' }])],
    });
    const result = await run(runsDir, llm);
    expect(result.summary.warnings[0]).toMatch(/^F-02: first session failed \(AgentSubmitError/);
    expect(result.testCases.coverage.uncovered[0]?.reasonKind).toBe('third-party-disabled');
  });

  it('warns when a high-priority requirement has no negative case', async () => {
    const { runsDir } = await makeRun();
    const { llm } = fakeBySession({
      'F-01': [submit([tc({ category: 'functional' }), uiCase()])],
      'F-02': [submit([], [{ requirementId: 'REQ-003', reasonKind: 'third-party-disabled', reason: 'Email only.' }])],
    });
    const result = await run(runsDir, llm);
    expect(result.summary.warnings).toEqual(['REQ-001 (high priority) has no negative test case (error-handling, boundary or auth)']);
  });

  it('uses the newest run with a prd.json by default, and marks earlier scripts stale', async () => {
    const { runsDir, runId, paths } = await makeRun();
    await setStage(paths.dir, 'scripts', { status: 'done' });
    expect(await latestRunWith('prd.json', runsDir)).toBe(runId);
    const { llm } = fakeBySession({
      'F-01': [submit([tc(), uiCase()])],
      'F-02': [submit([], [{ requirementId: 'REQ-003', reasonKind: 'other', reason: 'x' }])],
    });
    expect((await run(runsDir, llm)).runId).toBe(runId);
    expect((await readRunManifest(paths.runJson)).stages.scripts?.status).toBe('stale');
  });

  it('refuses a prd.json in the old format with a clear message', async () => {
    const old = structuredClone(prd()) as unknown as { requirements: Array<Record<string, unknown>> };
    old.requirements[0]!.acceptanceCriteria = ['The response is 400'];
    const { runsDir } = await makeRun(old);
    await expect(run(runsDir, new FakeLLMClient())).rejects.toThrow(/does not match the current prd.json format.*agent prd/);
  });

  it('fails clearly when there is no run with a prd.json', async () => {
    const runsDir = await mkdtemp(path.join(root, 'empty-'));
    await expect(run(runsDir, new FakeLLMClient())).rejects.toThrow(/No run with a prd.json/);
  });
});

describe('test case checks', () => {
  const grounding = "return res.status(400).json({ error: 'You must enter an email address.' });\nLogin\nisActive: true\nalice@example.test\n/api";
  const ctx = { requirements, fixtures: target.fixtures, grounding: { code: grounding, factStatuses: [], factStrings: [] }, quota: 10 };
  const check = (testCases: unknown[], declined: unknown[] = []) =>
    checkSubmission({ testCases, declined } as never, ctx);

  it('matches numbers whole, strings verbatim outside longer words, and booleans as words', () => {
    expect(isGrounded(400, grounding)).toBe(true);
    expect(isGrounded(40, grounding)).toBe(false);
    expect(isGrounded(4000, 'status(400)')).toBe(false);
    expect(isGrounded('You must enter an email address.', grounding)).toBe(true);
    expect(isGrounded('you must enter', grounding)).toBe(false); // case matters
    expect(isGrounded('Log', grounding)).toBe(false); // part of "Login"
    expect(isGrounded('/api', grounding)).toBe(true);
    expect(isGrounded(true, grounding)).toBe(true);
    expect(isGrounded(false, grounding)).toBe(false);
    expect(isGrounded('', grounding)).toBe(false);
  });

  it('accepts status codes and strings observed in facts, but not their booleans or plain numbers', () => {
    const g = { code: 'nothing here', factStatuses: [200, 403], factStrings: ['Only admins may do this.', 'Rustic Granite Hat'] };
    expect(isGroundedIn(403, g)).toBe(true);
    expect(isGroundedIn('Only admins may do this.', g)).toBe(true);
    expect(isGroundedIn('Rustic Granite Hat', g)).toBe(true);
    expect(isGroundedIn('Granite', g)).toBe(true); // a whole word inside an observed string
    expect(isGroundedIn('Gran', g)).toBe(false);
    expect(isGroundedIn(943, g)).toBe(false); // a price in a body is not a status code
    expect(isGroundedIn(true, g)).toBe(false);
  });

  it('does not accept the requirement text as a source for values', async () => {
    const evidence = await collectEvidence([requirements[0]!], async () => null);
    const text = groundingText(evidence, target);
    expect(isGrounded('Logging in without an email is rejected.', text)).toBe(false);
    expect(isGrounded('alice@example.test', text)).toBe(true); // fixtures count
    expect(isGrounded('http://localhost:3000', text)).toBe(true); // base URLs count
  });

  it('rejects unknown or foreign requirements, unknown fixtures and out-of-order expectation ids', () => {
    expect(check([tc({ requirementIds: ['REQ-099'] })])).toEqual(['testCases[0].requirementIds: REQ-099 is not one of the requirements given in this task']);
    expect(check([tc({ fixturesUsed: ['users.mallory'] })])).toEqual(['testCases[0].fixturesUsed: users.mallory is not in the fixtures; use only the fixture paths listed']);
  });

  it('maps layers: api to api, ui to ui, e2e to ui with category e2e-journey', () => {
    expect(check([tc({ layer: 'ui' })])[0]).toMatch(/REQ-001 is an api requirement/);
    expect(check([uiCase({ layer: 'api' })])[0]).toMatch(/REQ-002 is a ui requirement/);
    const e2e = tc({ requirementIds: ['REQ-003'], layer: 'ui', category: 'functional', expected: [{ description: 'x' }] });
    expect(check([e2e])[0]).toMatch(
      /REQ-003 is an e2e requirement: cover it with a test case with layer "ui" and category "e2e-journey" that goes through the pages; an API-only test belongs under a related api requirement instead/,
    );
    expect(check([{ ...e2e, category: 'e2e-journey' }])).toEqual([]);
  });

  it('rejects one test case for requirements of different layers', () => {
    const mixed = tc({ requirementIds: ['REQ-001', 'REQ-003'] });
    expect(check([mixed])).toContain('testCases[0]: it combines requirements of different layers (api, e2e); write a separate test case for each');
  });

  it('explains an empty value and a boolean that is not a literal in the code, separately', () => {
    const problems = check([tc({ expected: [{ description: 'a', value: '' }, { description: 'b', value: false }] })]);
    expect(problems).toEqual([
      'testCases[0].expected[0].value is empty; leave value out and keep the description',
      'testCases[0].expected[1].value false is not a literal in the code you were given; for checks like "is visible" or "is shown", leave value out (the description says what to check)',
    ]);
  });

  it('limits cases per requirement and per submission, and accepts a partial decline', () => {
    expect(check(Array.from({ length: 5 }, () => tc()))).toContain('REQ-001 has 5 test cases; at most 4');
    expect(checkSubmission({ testCases: [tc(), tc()], declined: [] } as never, { ...ctx, quota: 1 })[0]).toMatch(/more than the limit of 1/);
    // A decline for a covered requirement is a partial decline, not a mistake.
    expect(check([tc()], [{ requirementId: 'REQ-001', reasonKind: 'other', reason: 'x' }])).toEqual([]);
    expect(check([], [{ requirementId: 'REQ-002', reasonKind: 'other', reason: 'x' }, { requirementId: 'REQ-002', reasonKind: 'other', reason: 'y' }])).toEqual([
      'declined[1]: REQ-002 is declined twice',
    ]);
  });

  it('finds fixture paths and high-priority requirements without a negative case', () => {
    expect(fixtureExists(target.fixtures, 'users.alice')).toBe(true);
    expect(fixtureExists(target.fixtures, 'users.alice.email')).toBe(true);
    expect(fixtureExists(target.fixtures, 'users.zed')).toBe(false);
    expect(missingNegativeCases(requirements, [tc({ category: 'functional' })] as never)).toHaveLength(1);
    expect(missingNegativeCases(requirements, [tc()] as never)).toEqual([]);
  });
});

describe('evidence and quotas', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);

  it('merges overlapping and adjacent ranges per file and keeps them in file order', async () => {
    const reqs = [
      { ...requirements[0]!, acceptanceCriteria: [criterion('a', 'a.js', [1, 5]), criterion('b', 'a.js', [6, 8]), criterion('c', 'a.js', [3, 4])] },
    ];
    const { blocks, omitted } = await collectEvidence(reqs, async () => lines(20));
    expect(blocks.map((b) => [b.file, b.start, b.end])).toEqual([['a.js', 1, 8]]);
    expect(omitted).toEqual([]);
  });

  it('fills the size cap high-priority first and lists what was left out', async () => {
    const reqs = [
      { ...requirements[1]!, priority: 'low' as const, acceptanceCriteria: [criterion('low', 'low.js', [1, 50])] },
      { ...requirements[0]!, priority: 'high' as const, acceptanceCriteria: [criterion('high', 'high.js', [1, 50])] },
    ];
    const { blocks, omitted } = await collectEvidence(reqs, async () => lines(60), 700);
    expect(blocks.map((b) => b.file)).toEqual(['high.js']);
    expect(omitted).toEqual(['low.js:1-50']);
  });

  it('gives each feature its share of 150, never fewer than one case per requirement', () => {
    expect(featureQuotas([8, 5, 1])).toEqual([85, 53, 10]);
    expect(featureQuotas([2, 1], 2)).toEqual([2, 1]);
    const q = featureQuotas([8, 5, 5, 5, 3, 3, 6, 3, 7, 4, 1, 2, 10, 2]);
    expect(q.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(150);
  });
});

describe('test case prompt', () => {
  it('tells the model never to change a fixture user, and to create missing data through endpoints', () => {
    expect(buildSystemPrompt()).toContain('Never change a fixture user');
    expect(buildSystemPrompt()).toContain('created in the test\'s steps, through the API endpoints listed');
  });

    it('is the same for every target and names no app', () => {
    expect(buildSystemPrompt()).not.toMatch(/ecommerce|product|cart|mongo|mern|client\/app/i);
  });
});

describe('pages', () => {
  // Pages of the frontend: /login is opened by REQ-002's case; /settings is named by a ui requirement but no case opens it
  // until the page round; /about is named by no ui requirement; "/*" is a catch-all and never counted.
  const withPages = (): Prd => {
    const p = prd();
    p.uiRoutes = [
      { path: '/login', summary: 'Sign-in page', authRequired: false, evidence: [{ file: 'client/app/Login.js', lines: [1, 3] }] },
      { path: '/settings', summary: 'Settings page', authRequired: true, evidence: [{ file: 'client/app/Login.js', lines: [1, 3] }] },
      { path: '/about', summary: 'About page', authRequired: false, evidence: [{ file: 'client/app/Login.js', lines: [1, 3] }] },
      { path: '/*', summary: 'Not found', authRequired: false, evidence: [{ file: 'client/app/Login.js', lines: [1, 3] }] },
    ];
    p.requirements = [
      ...p.requirements,
      { id: 'REQ-004', featureId: 'F-01', layer: 'ui', priority: 'low', statement: 'The /settings page shows the email.', acceptanceCriteria: [criterion('The heading is visible', 'client/app/Login.js', [1, 3])] },
    ];
    return p;
  };
  const opensLogin = uiCase({ steps: ['Open /login', 'Look at the heading'] });
  const opensSettings = uiCase({ requirementIds: ['REQ-004'], title: 'Settings show the email', steps: ['Log in as users.alice', 'Open http://localhost:8080/settings'] });
  const reset = submit([], [{ requirementId: 'REQ-003', reasonKind: 'third-party-disabled', reason: 'Email only.' }]);

  it('asks every ui test case to name the page it opens by its path, and lists the pages in the task', async () => {
    const { runsDir } = await makeRun(withPages());
    const { llm, tasks } = fakeBySession({
      'F-01': [submit([uiCase(), tc(), opensSettings]), submit([opensLogin, tc(), opensSettings])],
      'F-02': [reset],
    });
    await run(runsDir, llm);
    const rejection = JSON.stringify(llm.requests.find((r) => JSON.stringify(r.messages.at(-1)).includes('a ui test case names the page'))!.messages.at(-1));
    expect(rejection).toContain('testCases[0]: a ui test case names the page it opens by its path from the page list, e.g. \\"Open /login\\"');
    expect(tasks['F-01']).toContain('## Pages of the frontend');
    expect(tasks['F-01']).toContain('- /settings (login required): Settings page');
    expect(tasks['F-01']).not.toContain('- /*'); // a catch-all cannot be opened
  });

  it('runs a page round for pages no case opens, from the ui requirements naming them, and records page coverage', async () => {
    const { runsDir, paths } = await makeRun(withPages());
    const { llm, tasks } = fakeBySession({
      'F-01': [submit([opensLogin, tc()], [{ requirementId: 'REQ-004', reasonKind: 'other', reason: 'later' }])],
      'F-02': [reset],
      'page:F-01': [submit([opensSettings])],
    });
    const result = await run(runsDir, llm);
    expect(tasks['page:F-01']).toContain('No test case opens these pages yet: /settings.');
    expect(tasks['page:F-01']).toContain('- REQ-004 [layer ui');
    expect(tasks['page:F-01']).not.toContain('- REQ-001 ');
    const file = TestCases.parse(JSON.parse(await readFile(paths.testCases, 'utf8')));
    expect(file.testCases.map((c) => c.requirementIds[0])).toEqual(['REQ-001', 'REQ-002', 'REQ-004']);
    expect(file.coverage.pages).toEqual({ total: 3, opened: 2, unopened: [{ path: '/about', reason: 'No ui or e2e requirement describes this page.' }] });
    expect(result.summary.sessions).toBe(3);
    expect(describeCasesSummary(result)).toContain('pages opened by a ui test case: 2 of 3; not opened: /about');
  });

  it('requires the page round to open each page asked for, unless a requirement naming it is declined', async () => {
    const { runsDir, paths } = await makeRun(withPages());
    const { llm } = fakeBySession({
      'F-01': [submit([opensLogin, tc()], [{ requirementId: 'REQ-004', reasonKind: 'other', reason: 'later' }])],
      'F-02': [reset],
      'page:F-01': [submit([opensLogin]), submit([], [{ requirementId: 'REQ-004', reasonKind: 'data-not-reachable', reason: 'Settings need a disabled service.' }])],
    });
    await run(runsDir, llm);
    expect(JSON.stringify(llm.requests.at(-1)!.messages.at(-1))).toContain('No ui test case opens /settings');
    const file = TestCases.parse(JSON.parse(await readFile(paths.testCases, 'utf8')));
    expect(file.coverage.pages?.unopened.map((u) => [u.path, u.reason])).toEqual([
      ['/settings', 'The ui or e2e requirements that describe it got no test case that opens it.'],
      ['/about', 'No ui or e2e requirement describes this page.'],
    ]);
  });
});

describe('cases see the page', () => {
  const withLogin = (): Prd => {
    const p = prd();
    p.uiRoutes = [{ path: '/login', summary: 'Sign-in page', authRequired: false, evidence: [{ file: 'client/app/Login.js', lines: [1, 3] }] }];
    p.requirements = p.requirements.map((r) => (r.id === 'REQ-002' ? { ...r, statement: 'The /login page shows a heading.' } : r));
    return p;
  };
  const reset = submit([], [{ requirementId: 'REQ-003', reasonKind: 'third-party-disabled', reason: 'Email only.' }]);
  const heading = (value: string, extra: Record<string, unknown> = {}) =>
    uiCase({ steps: ['Open /login', 'Look at the heading'], expected: [{ description: 'Heading', value, ...extra }] });

  it('takes the snapshots once per run, shows them in the task and rejects text the page does not show', async () => {
    fakePages = { '/login': '- heading "Please sign in" [level=1]\n- link "Home":\n  - /url: /x-6ade07a6ffd7' };
    appStarts = 0;
    const { runsDir, runId, paths } = await makeRun(withLogin());
    const first = fakeBySession({ 'F-01': [submit([heading('Welcome back'), tc()]), submit([heading('Please sign in'), tc()])], 'F-02': [reset] });
    const result = await run(runsDir, first.llm);
    expect(appStarts).toBe(1);
    expect(first.tasks['F-01']).toContain('### /login (not logged in)\n```yaml\n- heading "Please sign in" [level=1]\n- link "Home":\n```');
    const rejection = JSON.stringify(first.llm.requests.find((r) => JSON.stringify(r.messages.at(-1)).includes('is not on /login'))!.messages.at(-1));
    expect(rejection).toContain('\\"Welcome back\\" is not on /login as a visitor sees it');
    expect(result.testCases.testCases.find((c) => c.layer === 'ui')!.expected[0]!.value).toBe('Please sign in');
    const file = PageSnapshots.parse(JSON.parse(await readFile(path.join(paths.dir, 'pages', 'snapshots.json'), 'utf8')));
    expect(file.pages.map((p) => [p.path, p.user])).toEqual([['/login', null]]);
    // A rerun of the stage reuses the file: the app is not started again.
    const again = fakeBySession({ 'F-01': [submit([heading('Please sign in'), tc()])], 'F-02': [reset] });
    await run(runsDir, again.llm, runId);
    expect(appStarts).toBe(1);
  });

  it('counts afterAction expectations in the summary', async () => {
    fakePages = { '/login': '- heading "Please sign in" [level=1]' };
    const { runsDir } = await makeRun(withLogin());
    const after = uiCase({ steps: ['Open /login', 'Submit the empty form'], expected: [{ description: 'Error', value: 'Please sign in' }, { description: 'Error text', value: 'Please sign in', afterAction: true }] });
    const { llm } = fakeBySession({ 'F-01': [submit([after, tc()])], 'F-02': [reset] });
    const result = await run(runsDir, llm);
    expect(describeCasesSummary(result)).toContain('ui expectations marked afterAction (text that appears only after a step acts on the page): 1');
  });
});
