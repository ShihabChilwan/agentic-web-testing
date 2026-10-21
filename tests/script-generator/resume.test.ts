import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeLLMClient } from '../../src/llm/fake.js';
import type { ChatRequest, ChatResponse } from '../../src/llm/types.js';
import { callerBlocks, endpointsUsed, helperRanges, searchText } from '../../src/modules/script-generator/callers.js';
import type { DryRunResult } from '../../src/modules/script-generator/dry-run.js';
import { generateScripts } from '../../src/modules/script-generator/index.js';
import { linesAtCommit } from '../../src/modules/test-case-generator/context.js';
import { parseLLMConfig } from '../../src/shared/config.js';
import { PROJECT_ROOT } from '../../src/shared/paths.js';
import { createRun, llmSettings, readRunManifest, setStage } from '../../src/shared/run-manifest.js';
import { ScriptManifest } from '../../src/shared/schemas.js';
import type { TestCase } from '../../src/shared/schemas.js';
import { example } from '../shared/schemas/helpers.js';

// Under runs/ so the generated scripts type-check against the project's @playwright/test.
let root: string;
let repo: string;
let commit: string;

const CART_ACTIONS = [
  'export const addToCart = () => async (dispatch) => {',
  '  const cartItems = loadItems();',
  '  const products = getCartItems(cartItems);',
  '  const response = await axios.post(`${API_URL}/cart/add`, { products });',
  '  return response.data.cartId;',
  '};',
  '',
  // Far enough down that the call's window does not include the helper, as in a real actions file.
  ...Array.from({ length: 20 }, (_, i) => `// other action ${i + 1}`),
  'const getCartItems = cartItems => {',
  '  return cartItems.map(item => ({ product: item._id, quantity: item.quantity, price: item.price, taxable: item.taxable }));',
  '};',
].join('\n');

beforeAll(async () => {
  await mkdir(path.join(PROJECT_ROOT, 'runs'), { recursive: true });
  root = await mkdtemp(path.join(PROJECT_ROOT, 'runs', '.resume-test-'));
  repo = path.join(root, 'targets', 'fake', 'repo');
  await mkdir(path.join(repo, 'client', 'app', 'Cart'), { recursive: true });
  await mkdir(path.join(repo, 'server'), { recursive: true });
  await writeFile(path.join(repo, 'client', 'app', 'Cart', 'actions.js'), CART_ACTIONS);
  await writeFile(path.join(repo, 'server', 'cart.js'), "router.post('/add', auth, handler);\n");
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@x.test', ...a], { encoding: 'utf8' });
  git('init', '--quiet');
  git('add', '.');
  git('commit', '--quiet', '-m', 'golden');
  commit = git('rev-parse', 'HEAD').trim();
  const config = structuredClone(example('target.config.json'));
  config.name = 'fake';
  config.repoPath = 'targets/fake/repo';
  delete config.facts;
  await writeFile(path.join(root, 'targets', 'fake', 'target.config.json'), JSON.stringify(config));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const endpoints = [
  { method: 'POST' as const, path: '/api/cart/add', authRequired: true, summary: 'Creates a cart.', responses: [{ status: 200, description: 'ok' }], evidence: [{ file: 'server/cart.js', lines: [1, 1] as [number, number] }] },
  { method: 'POST' as const, path: '/api/cart/add/:cartId', authRequired: true, summary: 'Adds to a cart.', responses: [{ status: 200, description: 'ok' }], evidence: [{ file: 'server/cart.js', lines: [1, 1] as [number, number] }] },
  { method: 'POST' as const, path: '/api/auth/login', authRequired: false, summary: 'Logs in.', responses: [{ status: 200, description: 'ok' }], evidence: [{ file: 'server/cart.js', lines: [1, 1] as [number, number] }] },
];
const tc = (id: string, steps: string[] = ['Send GET /api/items']): TestCase => ({
  id, requirementIds: ['REQ-001'], title: `case ${id}`, layer: 'api', category: 'functional', priority: 'high',
  preconditions: [], fixturesUsed: [], steps, expected: [{ id: 'E1', description: 'Status 200', value: 200 }],
});

describe('endpoint callers', () => {
  it('finds the endpoints a test case mentions, matching path parameters and methods', () => {
    const used = endpointsUsed(tc('TC-001', ['Log in via POST /api/auth/login', 'Send POST /api/cart/add with one product', 'Then POST /api/cart/add/66ab12 again']), endpoints);
    expect(used.map((e) => e.path)).toEqual(['/api/auth/login', '/api/cart/add', '/api/cart/add/:cartId']);
    expect(endpointsUsed(tc('TC-002', ['Send GET /api/cart/add']), endpoints)).toEqual([]); // wrong method
  });

  it('searches for the fixed part of the path without the API prefix', () => {
    expect(searchText(endpoints[0]!, '/api')).toBe('/cart/add');
    expect(searchText(endpoints[1]!, '/api')).toBe('/cart/add');
    expect(searchText({ ...endpoints[0]!, path: '/api/:id' }, '/api')).toBeNull();
  });

  it('finds local helpers the calling code uses', () => {
    expect(helperRanges(CART_ACTIONS.split('\n'), 1, 6)).toEqual([{ start: 28, end: 30, name: 'getCartItems' }]);
    expect(helperRanges(CART_ACTIONS.split('\n'), 1, 30)).toEqual([]); // already inside the window
  });

  it('shows the frontend call and its request-building helper once, and skips the login endpoint', async () => {
    const scope = { root: repo, forbiddenPaths: [] };
    const blocks = await callerBlocks(tc('TC-003', ['POST /api/auth/login', 'POST /api/cart/add', 'POST /api/cart/add/x']), {
      endpoints, apiPrefix: '/api', frontendRoots: ['client/app'], scope, commit, read: linesAtCommit(scope, commit),
      skip: { method: 'POST', path: '/api/auth/login' },
    });
    expect(blocks.map((b) => [b.file, b.start, b.end, b.calls])).toEqual([
      ['client/app/Cart/actions.js', 1, 16, 'POST /api/cart/add'],
      ['client/app/Cart/actions.js', 28, 30, 'POST /api/cart/add, helper getCartItems'],
    ]);
  });
});

describe('generateScripts: progress, interruption and resume', () => {
  const body = `const res = await api.get('/api/items');\nexpect(res.status(), 'E1').toBe(EXPECTED.E1.value);`;

  async function makeRun() {
    const runsDir = await mkdtemp(path.join(root, 'runs-'));
    const { runId, paths } = await createRun({ target: 'fake', generationRef: 'golden', generationCommit: commit, llm: llmSettings(parseLLMConfig({ LLM_BASE_URL: 'http://m/v1' })), runsDir });
    const prd = structuredClone(example('prd.json'));
    prd.target = 'fake';
    prd.requirements = [{ ...prd.requirements[0], id: 'REQ-001' }];
    prd.apiEndpoints = endpoints;
    await writeFile(paths.prd, JSON.stringify(prd));
    const cases = ['TC-001', 'TC-002', 'TC-003'].map((id) => tc(id));
    await writeFile(paths.testCases, JSON.stringify({ schemaVersion: '1.0', generatedAt: '2026-10-24T10:00:00Z', testCases: cases, coverage: { requirementsTotal: 1, requirementsCovered: 1, uncovered: [] } }));
    return { runsDir, runId, paths };
  }

  /** A model that always submits the same body, and records which test cases it was asked about. */
  function model(slow?: { id: string; until: Promise<unknown> }) {
    const asked: string[] = [];
    const respond = async (req: ChatRequest): Promise<ChatResponse> => {
      const first = req.messages[0];
      const task = first?.role === 'user' && first.content[0]?.type === 'text' ? first.content[0].text : '';
      const id = /test for (TC-\d+)/.exec(task)?.[1] ?? '?';
      asked.push(id);
      if (slow?.id === id) await slow.until;
      return FakeLLMClient.toolCall('submit_script', { body });
    };
    return { llm: new FakeLLMClient(Array.from({ length: 30 }, () => respond)), asked };
  }

  const options = (runsDir: string, runId: string, llm: FakeLLMClient, runDryRun: (r: string, f: string) => Promise<DryRunResult>, extra = {}) => ({
    runId, runsDir, targetsDir: path.join(root, 'targets'), projectRoot: root,
    llmConfig: parseLLMConfig({ LLM_BASE_URL: 'http://m/v1' }),
    createLlm: async () => llm,
    startApp: async () => ({ stop: async () => {} }),
    runDryRun,
    ...extra,
  });

  it('writes the manifest after each case, keeps it on interruption, then resumes only what is missing', { timeout: 180_000 }, async () => {
    const { runsDir, runId, paths } = await makeRun();
    const controller = new AbortController();
    let stopped = 0;
    // TC-001 and TC-002 pass; the model's answer for TC-003 only comes after the interruption.
    const aborted = new Promise((resolve) => controller.signal.addEventListener('abort', resolve));
    const first = model({ id: 'TC-003', until: aborted });
    const pass = async (): Promise<DryRunResult> => ({ status: 'passed', message: '', durationMs: 1 });
    const running = generateScripts({
      ...options(runsDir, runId, first.llm, pass),
      signal: controller.signal,
      startApp: async () => ({ stop: async () => void stopped++ }),
    });
    // Interrupt once the manifest on disk shows the two finished cases (it is written after each one).
    const done = async () => (JSON.parse(await readFile(paths.scriptsManifest, 'utf8').catch(() => '{"scripts":[]}')) as { scripts: unknown[] }).scripts.length;
    for (let i = 0; i < 400 && (await done()) < 2; i++) await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await expect(running).rejects.toThrow('Interrupted');
    const partial = ScriptManifest.parse(JSON.parse(await readFile(paths.scriptsManifest, 'utf8')));
    expect(partial.scripts.map((s) => s.testCaseId)).toEqual(['TC-001', 'TC-002']);
    expect((await readRunManifest(paths.runJson)).stages.scripts).toMatchObject({ status: 'failed', error: 'Interrupted' });
    expect(stopped).toBe(1);

    const second = model();
    const result = await generateScripts(options(runsDir, runId, second.llm, async () => ({ status: 'passed', message: '', durationMs: 1 })));
    expect(second.asked).toEqual(['TC-003']);
    expect(result.summary).toMatchObject({ cases: 3, resumed: 2, validated: { passed: 3 } });
  });

  it('generates everything again with fresh, or when the stage was marked stale', { timeout: 240_000 }, async () => {
    const { runsDir, runId, paths } = await makeRun();
    const pass = async () => ({ status: 'passed', message: '', durationMs: 1 });
    await generateScripts(options(runsDir, runId, model().llm, pass));
    const fresh = model();
    await generateScripts(options(runsDir, runId, fresh.llm, pass, { fresh: true }));
    expect(fresh.asked.sort()).toEqual(['TC-001', 'TC-002', 'TC-003']);
    await setStage(paths.dir, 'scripts', { status: 'stale' });
    const stale = model();
    await generateScripts(options(runsDir, runId, stale.llm, pass));
    expect(stale.asked.sort()).toEqual(['TC-001', 'TC-002', 'TC-003']);
  });

  it('does not keep a validated script whose test case changed', { timeout: 180_000 }, async () => {
    const { runsDir, runId, paths } = await makeRun();
    const pass = async () => ({ status: 'passed', message: '', durationMs: 1 });
    await generateScripts(options(runsDir, runId, model().llm, pass));
    const cases = JSON.parse(await readFile(paths.testCases, 'utf8'));
    cases.testCases[1].expected[0].value = 201;
    await writeFile(paths.testCases, JSON.stringify(cases));
    await setStage(paths.dir, 'scripts', { status: 'failed' }); // not marked stale, but the locked block differs
    const again = model();
    await generateScripts(options(runsDir, runId, again.llm, pass));
    expect(again.asked).toEqual(['TC-002']);
  });
});
