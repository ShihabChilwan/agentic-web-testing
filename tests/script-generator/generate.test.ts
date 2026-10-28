import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeLLMClient } from '../../src/llm/fake.js';
import type { ChatRequest, ChatResponse } from '../../src/llm/types.js';
import { generateScripts } from '../../src/modules/script-generator/index.js';
import { parseLLMConfig } from '../../src/shared/config.js';
import { PROJECT_ROOT } from '../../src/shared/paths.js';
import { createRun, llmSettings, readRunManifest } from '../../src/shared/run-manifest.js';
import { ScriptManifest } from '../../src/shared/schemas.js';
import { example } from '../shared/schemas/helpers.js';

// The whole stage with real Playwright and Chromium against a small local app; only the model is fake.
// It lives under runs/ so the generated scripts resolve @playwright/test from the project.

const TOKEN = 'Bearer test-token-123';
// The app's data: alice's password can be changed (a fixture mutation); restore() puts it back.
const SEEDED = { alicePassword: 'Passw0rd!alice' };
let data = { ...SEEDED, others: new Map<string, string>() };
let server: http.Server;
let url: string;
let root: string;

const PAGE = `<!doctype html><html><body>
<h1>Shop</h1>
<p id="status"></p>
<form id="login"><input placeholder="Your email"><input placeholder="Your password" type="password"><button>Sign in</button></form>
<script>
  const t = localStorage.getItem('token');
  document.getElementById('status').textContent = t ? 'Signed in' : 'Signed out';
  document.getElementById('login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const [email, password] = [...document.querySelectorAll('input')].map((i) => i.value);
    const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const body = await res.json();
    if (res.ok) { localStorage.setItem('token', body.token); location.href = '/account'; }
  });
</script></body></html>`;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = (status: number, v: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v));
      if (req.url === '/api/auth/login') {
        const { email, password } = JSON.parse(body || '{}');
        const ok = (email === 'alice@example.test' && password === data.alicePassword) || data.others.get(email) === password;
        // Every fixture user in the shared test config logs in with its own password.
        const fixture = (email === 'admin@example.com' && password === 'admin123') || (email === 'bob@example.test' && password === 'Passw0rd!bob');
        return ok || fixture ? json(200, { token: TOKEN }) : json(400, { error: 'Password Incorrect' });
      }
      if (req.url === '/api/register') {
        const { email, password } = JSON.parse(body || '{}');
        data.others.set(email, password);
        return json(200, { ok: true });
      }
      if (req.url === '/api/password') {
        const { email, password } = JSON.parse(body || '{}');
        if (email === 'alice@example.test') data.alicePassword = password;
        else data.others.set(email, password);
        return json(200, { ok: true });
      }
      if (req.url === '/api/items') return json(200, { items: [{ name: 'Hat' }] });
      if (req.url === '/api/me') return req.headers.authorization === TOKEN ? json(200, { email: 'alice@example.test' }) : res.writeHead(401).end('Unauthorized');
      res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await mkdir(path.join(PROJECT_ROOT, 'runs'), { recursive: true });
  root = await mkdtemp(path.join(PROJECT_ROOT, 'runs', '.scripts-test-'));
  const repo = path.join(root, 'targets', 'fake', 'repo');
  await mkdir(repo, { recursive: true });
  await writeFile(path.join(repo, 'app.js'), 'export const x = 1;\n');
  execFileSync('git', ['-C', repo, 'init', '--quiet']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@x.test', 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@x.test', 'commit', '--quiet', '-m', 'golden']);
  const config = structuredClone(example('target.config.json'));
  config.name = 'fake';
  config.repoPath = 'targets/fake/repo';
  config.backend.baseUrl = url;
  config.frontend.baseUrl = url;
  config.auth.uiLogin = {
    path: '/',
    fields: { email: { placeholder: 'Your email' }, password: { placeholder: 'Your password' } },
    submit: { role: 'button', name: 'Sign in' },
    waitFor: { urlNot: '/login-never' },
  };
  delete config.facts;
  await writeFile(path.join(root, 'targets', 'fake', 'target.config.json'), JSON.stringify(config));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (!process.env.KEEP_SCRIPTS_TEST) await rm(root, { recursive: true, force: true });
});

const tc = (id: string, layer: 'api' | 'ui', expected: Array<{ id: string; description: string; value?: string | number }>) => ({
  id, requirementIds: ['REQ-001'], title: `case ${id}`, layer, category: 'functional', priority: 'high',
  preconditions: [], fixturesUsed: ['users.alice'], steps: ['do it'], expected,
});

const CASES = [
  tc('TC-001', 'api', [{ id: 'E1', description: 'Status 200', value: 200 }, { id: 'E2', description: 'The first item is a hat', value: 'Hat' }]),
  tc('TC-002', 'api', [{ id: 'E1', description: 'Status 404', value: 404 }]),
  tc('TC-003', 'ui', [{ id: 'E1', description: 'The page says Signed in', value: 'Signed in' }]),
  tc('TC-004', 'ui', [{ id: 'E1', description: 'The account page shows Signed in', value: 'Signed in' }]),
  tc('TC-005', 'ui', [{ id: 'E1', description: 'A welcome banner is visible' }]),
  tc('TC-006', 'api', [{ id: 'E1', description: 'Status 200', value: 200 }]),
  tc('TC-008', 'api', [{ id: 'E1', description: 'Password change accepted', value: 200 }]),
  tc('TC-009', 'api', [{ id: 'E1', description: 'Status 200', value: 200 }]),
  tc('TC-010', 'api', [{ id: 'E1', description: 'The first item is a hat', value: 'Hat' }]),
  tc('TC-007', 'ui', [{ id: 'E1', description: 'Signed in at first', value: 'Signed in' }, { id: 'E2', description: 'Still signed out after logging out and reloading', value: 'Signed out' }]),
];

const BODIES: Record<string, string[]> = {
  // passes at once
  'TC-001': [`const res = await api.get('/api/items');
expect(res.status(), 'E1').toBe(EXPECTED.E1.value);
const body = await bodyOf(res);
expect(body.items[0].name, 'E2').toBe(EXPECTED.E2.value);`],
  // the app answers 401 with a plain-text body (bodyOf reads it without throwing), the locked value says 404:
  // a real disagreement, kept
  'TC-002': [`const res = await api.get('/api/me');
expect(await bodyOf(res)).toBe('Unauthorized');
expect(res.status(), 'E1').toBe(EXPECTED.E1.value);`],
  // value used inside the locator (lock check), then fixed
  'TC-003': [
    `await loggedInPage(page, fixtures.users.alice);
await page.goto('/');
await expect(page.getByText(EXPECTED.E1.value), 'E1').toBeVisible();`,
    `await loggedInPage(page, fixtures.users.alice);
await page.goto('/');
await expect(page.locator('#status'), 'E1').toHaveText(EXPECTED.E1.value);`,
  ],
  // wrong locator first (failed attempt), then the real login form
  'TC-004': [
    `await page.goto('/');
await expect(page.locator('#nope'), 'E1').toHaveText(EXPECTED.E1.value, { timeout: 1000 });`,
    `await loginViaUi(page, fixtures.users.alice);
await expect(page.locator('#status'), 'E1').toHaveText(EXPECTED.E1.value);`,
  ],
  // a value-less check that never passes: invalid, kept for review as value-less-expect
  'TC-005': [
    `await page.goto('/');
await expect(page.getByRole('banner'), 'E1').toBeVisible({ timeout: 1000 });`,
  ],
  // loggedInPage sets the token once per tab: logging out and reloading stays logged out
  'TC-007': [`await loggedInPage(page, fixtures.users.alice);
await page.goto('/');
await expect(page.locator('#status'), 'E1').toHaveText(EXPECTED.E1.value);
await page.evaluate(() => localStorage.removeItem('token'));
await page.reload();
await expect(page.locator('#status'), 'E2').toHaveText(EXPECTED.E2.value);`],
  // changes a fixture user's password (rejected as fixture-mutation, data restored), then uses a new user
  'TC-008': [
    `const res = await api.post('/api/password', { data: { email: fixtures.users.alice.email, password: 'changed-1' } });
expect(res.status(), 'E1').toBe(EXPECTED.E1.value);`,
    `const email = uniq('user') + '@example.test';
await api.post('/api/register', { data: { email, password: 'first-1' } });
const res = await api.post('/api/password', { data: { email, password: 'second-2' } });
expect(res.status(), 'E1').toBe(EXPECTED.E1.value);`,
  ],
  // compares the item's name with a status code (a script error: sent back once), then reads the status
  'TC-009': [
    `const res = await api.get('/api/items');
const body = await bodyOf(res);
expect(body.items[0].name, 'E1').toBe(EXPECTED.E1.value);`,
    `const res = await api.get('/api/items');
expect(res.status(), 'E1').toBe(EXPECTED.E1.value);`,
  ],
  // the same mistake, but the repair attempts do not even compile: the first script, which reached E1, is kept
  'TC-010': [
    `const res = await api.get('/api/items');
expect(res.status(), 'E1').toBe(EXPECTED.E1.value);`,
    `const n: number = await api.get('/api/items');`,
    `const n: number = await api.get('/api/items');`,
  ],
  // does not compile, then a literal credential, then fixed
  'TC-006': [
    `const res: number = await api.get('/api/me');`,
    `const { headers } = await loginViaApi({ email: 'alice@example.test', password: fixtures.users.alice.password });
const res = await api.get('/api/me', { headers });
expect(res.status(), 'E1').toBe(EXPECTED.E1.value);`,
    `const { headers } = await loginViaApi(fixtures.users.alice);
const res = await api.get('/api/me', { headers });
expect(res.status(), 'E1').toBe(EXPECTED.E1.value);`,
  ],
};

function fakeModel() {
  const tasks: Record<string, string> = {};
  const feedback: Record<string, ChatRequest> = {};
  const respond = (req: ChatRequest): ChatResponse => {
    const first = req.messages[0];
    const task = first?.role === 'user' && first.content[0]?.type === 'text' ? first.content[0].text : '';
    const id = /test for (TC-\d+)/.exec(task)?.[1] ?? '?';
    tasks[id] = task;
    feedback[id] = structuredClone(req); // the runtime appends the reply to the same list afterwards
    const attempt = req.messages.filter((m) => m.role === 'assistant').length;
    const bodies = BODIES[id]!;
    return FakeLLMClient.toolCall('submit_script', { body: bodies[Math.min(attempt, bodies.length - 1)] });
  };
  return { llm: new FakeLLMClient(Array.from({ length: 40 }, () => respond)), tasks, feedback };
}

describe('generateScripts with real Playwright', () => {
  it('runs the fix loop per case and records outcomes, categories and the summary', { timeout: 420_000 }, async () => {
    const runsDir = path.join(root, 'runs');
    const { runId, paths } = await createRun({
      target: 'fake', generationRef: 'golden', generationCommit: 'abc1234', llm: llmSettings(parseLLMConfig({ LLM_BASE_URL: 'http://m/v1' })), runsDir,
    });
    const prd = structuredClone(example('prd.json'));
    prd.target = 'fake';
    prd.requirements = [{ ...prd.requirements[0], id: 'REQ-001' }];
    await writeFile(paths.prd, JSON.stringify(prd));
    await writeFile(paths.testCases, JSON.stringify({ schemaVersion: '1.0', generatedAt: '2026-10-24T10:00:00Z', testCases: CASES, coverage: { requirementsTotal: 1, requirementsCovered: 1, uncovered: [] } }));
    const { llm, tasks, feedback } = fakeModel();
    let started = 0;
    let stopped = 0;

    const result = await generateScripts({
      runId, runsDir, targetsDir: path.join(root, 'targets'), projectRoot: root,
      llmConfig: parseLLMConfig({ LLM_BASE_URL: 'http://m/v1' }),
      createLlm: async () => llm,
      startApp: async () => {
        started++;
        return {
          stop: async () => void stopped++,
          restore: async () => {
            data = { ...SEEDED, others: new Map() };
            return { durationMs: 1 };
          },
        };
      },
    });

    const byId = Object.fromEntries(result.manifest.scripts.map((s) => [s.testCaseId, s]));
    expect(byId['TC-001']).toMatchObject({ status: 'validated', validationOutcome: 'passed', attempts: 1 });
    expect(byId['TC-002']).toMatchObject({ status: 'validated', validationOutcome: 'assertion_failed', attempts: 1 });
    expect(byId['TC-003']?.attemptLog.map((a) => a.stage)).toEqual(['lock-check', 'dry-run']);
    expect(byId['TC-003']).toMatchObject({ status: 'validated', validationOutcome: 'passed' });
    expect(byId['TC-004']?.attemptLog.map((a) => a.category ?? 'ok')).toEqual(['locator', 'ok']);
    expect(byId['TC-004']).toMatchObject({ status: 'validated', validationOutcome: 'passed' });
    // A ui test case gets 5 attempts (an api one 3), and each failed one sees the page as an accessibility tree.
    expect(byId['TC-005']).toMatchObject({ status: 'invalid', failureCategory: 'value-less-expect', attempts: 5 });
    expect(JSON.stringify(feedback['TC-005']?.messages.at(-1))).toContain('The page when the test stopped, as an accessibility tree');
    expect(byId['TC-006']?.attemptLog.map((a) => a.stage)).toEqual(['typecheck', 'lock-check', 'dry-run']);
    expect(byId['TC-006']).toMatchObject({ status: 'validated', validationOutcome: 'passed' });
    // A locked value read from the wrong thing is sent back (SPEC §6.2): the repair passes, or the held script stays.
    expect(byId['TC-009']).toMatchObject({ status: 'validated', validationOutcome: 'passed', attempts: 2, repairs: 1 });
    expect(byId['TC-009']?.unstable).toBeUndefined();
    expect(JSON.stringify(feedback['TC-009']?.messages)).toContain('is locked to the number 200, but the test compared it with the string \\"Hat\\"');
    expect(byId['TC-010']).toMatchObject({ status: 'validated', validationOutcome: 'assertion_failed', attempts: 3, repairs: 1, keptAttempt: 1 });
    expect(byId['TC-010']?.attemptLog.map((a) => a.stage)).toEqual(['dry-run', 'typecheck', 'typecheck']);
    expect(await readFile(path.join(paths.scriptsDir, 'TC-010.spec.ts'), 'utf8')).toContain("expect(res.status(), 'E1').toBe(EXPECTED.E1.value);");
    expect(byId['TC-007']).toMatchObject({ status: 'validated', validationOutcome: 'passed', attempts: 1 });
    expect(byId['TC-008']?.attemptLog.map((a) => a.category ?? 'ok')).toEqual(['fixture-mutation', 'ok']);
    expect(byId['TC-008']?.attemptLog[0]?.error).toMatch(/^This test changed fixture user users.alice: logging in as it failed afterwards/);
    expect(byId['TC-008']).toMatchObject({ status: 'validated', validationOutcome: 'passed' });

    expect(result.summary).toMatchObject({
      cases: 10,
      validated: { passed: 7, assertionFailed: 2 },
      invalid: 1,
      invalidByCategory: { 'value-less-expect': 1 },
      invalidCases: { 'value-less-expect': ['TC-005'] },
      failuresByStage: { typecheck: 3, 'lock-check': 2, 'dry-run': 7 },
      attemptsHistogram: { '1': 3, '2': 4, '3': 2, '4': 0, '5': 1 },
      repaired: { cases: 2, passed: 1 },
      unstable: 0,
      playwrightVersion: '1.64.0',
    });
    expect(result.summary.dryRunMs).toBeGreaterThan(0);
    // One restore after every dry run: 14 dry runs (TC-001..008: 1+1+1+2+5+1+1+2, TC-005 being a ui case with 5 attempts;
    // typecheck and lock-check failures run none).
    expect(result.summary.restores).toBe(17);
    // Dry runs that waited share a Playwright process (SPEC §6.2): fewer processes than dry runs, one restore each.
    expect(result.summary.dryRunBatches).toBeGreaterThan(0);
    expect(result.summary.dryRunBatches).toBeLessThan(result.summary.restores);
    expect(started).toBe(1);
    expect(stopped).toBe(1);

    // Files: the locked block is in every script; the manifest and run.json are valid.
    const script = await readFile(path.join(paths.scriptsDir, 'TC-002.spec.ts'), 'utf8');
    expect(script).toContain("  E1: { description: 'Status 404', value: 404 },");
    ScriptManifest.parse(JSON.parse(await readFile(paths.scriptsManifest, 'utf8')));
    expect((await readRunManifest(paths.runJson)).stages.scripts).toMatchObject({ status: 'done', scripts: result.summary });
    expect(tasks['TC-003']).toContain('## The file around your body');
    expect(await readdir(paths.transcriptsDir)).toContain('scripts-1.jsonl');
  });
});
