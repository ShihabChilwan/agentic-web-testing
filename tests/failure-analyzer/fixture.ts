import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRun, llmSettings, setExecution } from '../../src/shared/run-manifest.js';
import { parseLLMConfig } from '../../src/shared/config.js';
import type { ExecutionResults, TestResult } from '../../src/shared/schemas.js';
import { example } from '../shared/schemas/helpers.js';

// A run with one finished execution of a patched version, for the analyzer tests: a fake target repo,
// a dev-bug patch, prd.json, testcases.json, scripts, results.json with artifacts and server logs, a
// second execution and eval/ablation folders the analyzer must never reach.

export const llmConfig = parseLLMConfig({ LLM_BASE_URL: 'http://model.test/v1' });

export const AUTH_JS = `const router = require('express').Router();

router.post('/login', async (req, res) => {
  const user = await findUser(req.body.email);
  const isMatch = await compare(req.body.password, user.password);
  if (!isMatch) {
    return res.status(400).json({ error: 'Password Incorrect' });
  }
  res.json({ token: sign(user) });
});

module.exports = router;
`;

/** The planted fault: the password check never fires. */
export const PATCH = `--- a/server/routes/auth.js
+++ b/server/routes/auth.js
@@ -3,7 +3,7 @@
 router.post('/login', async (req, res) => {
   const user = await findUser(req.body.email);
   const isMatch = await compare(req.body.password, user.password);
-  if (!isMatch) {
+  if (isMatch === null) {
     return res.status(400).json({ error: 'Password Incorrect' });
   }
   res.json({ token: sign(user) });
`;

export const PATCH_NAME = 'dev-001-login-accepts-any-password.patch';

const failure = (id: string, message: string, extra: Partial<TestResult> = {}): TestResult => ({
  testCaseId: id,
  status: 'failed',
  isolated: true,
  durationMs: 120,
  error: { message, expectationId: 'E1', category: 'assertion_failed' },
  artifacts: {
    network: `artifacts/${id}/network.json`,
    lastResponse: `artifacts/${id}/last-response.json`,
    serverLog: `artifacts/${id}/backend.log`,
  },
  ...extra,
});

export const WRONG_PASSWORD = (port: number) =>
  `Error: E1\n\nexpect(received).toBe(expected) // Object.is equality\n\nExpected: 400\nReceived: 200\n\n  at http://127.0.0.1:${port}/api/auth/login`;

export async function makeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'awt-analyzer-'));
  const repo = path.join(root, 'targets', 'fake', 'repo');
  await mkdir(path.join(repo, 'server', 'routes'), { recursive: true });
  await mkdir(path.join(repo, 'client'), { recursive: true });
  await writeFile(path.join(repo, 'server', 'routes', 'auth.js'), AUTH_JS);
  await writeFile(path.join(repo, 'client', 'Login.js'), 'export const Login = () => null;\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@x.test', ...args], { encoding: 'utf8' });
  git('init', '--quiet');
  git('add', '.');
  git('commit', '--quiet', '-m', 'golden version');
  git('branch', 'golden');
  const commit = git('rev-parse', 'HEAD').trim();
  const config = structuredClone(example('target.config.json'));
  config.name = 'fake';
  config.repoPath = 'targets/fake/repo';
  delete config.facts;
  await writeFile(path.join(root, 'targets', 'fake', 'target.config.json'), JSON.stringify(config));
  await mkdir(path.join(root, 'targets', 'fake', 'dev-bugs'), { recursive: true });
  await writeFile(path.join(root, 'targets', 'fake', 'dev-bugs', PATCH_NAME), PATCH);
  await writeFile(path.join(root, 'targets', 'fake', 'variants.json'), '{"secret":"bug-001 is the answer"}');

  const runsDir = path.join(root, 'runs');
  const { runId, paths } = await createRun({ target: 'fake', generationRef: 'golden', generationCommit: commit, llm: llmSettings(llmConfig), runsDir });
  await writeFile(paths.prd, JSON.stringify(example('prd.json')));
  const base = example('testcases.json');
  const titles: Record<string, string> = {
    'TC-001': 'Login with a wrong password is rejected',
    'TC-002': 'Login with another wrong password is rejected',
    'TC-003': 'Profile page shows the user name',
  };
  base.testCases = Object.entries(titles).map(([id, title]) => ({ ...base.testCases[0], id, title }));
  await writeFile(paths.testCases, JSON.stringify(base));
  await mkdir(paths.scriptsDir, { recursive: true });
  for (const id of Object.keys(titles)) await writeFile(path.join(paths.scriptsDir, `${id}.spec.ts`), `// ${id}: ${titles[id]}\ntest('${id}', async () => {});\n`);

  const execId = 'x-04';
  const execDir = paths.executionDir(execId);
  const results: ExecutionResults = {
    schemaVersion: '1.0',
    execId,
    startedAt: '2026-10-28T09:00:00.000Z',
    finishedAt: '2026-10-28T09:04:00.000Z',
    environment: {
      healthChecks: [{ name: 'backend', url: 'http://localhost:3000/api/health', ok: true, elapsedMs: 900 }],
      seed: [{ request: 'POST /api/auth/register', status: 200, ok: true }],
    },
    summary: { total: 4, passed: 1, failed: 2, errored: 1, skipped: 0, notIsolated: 0 },
    skipped: [],
    incidents: [],
    results: [
      failure('TC-001', WRONG_PASSWORD(40001)),
      failure('TC-002', WRONG_PASSWORD(40002)), // same error, another port: same group
      failure('TC-003', 'Error: page.goto: net::ERR_CONNECTION_REFUSED at /profile', {
        status: 'errored',
        error: { message: 'Error: page.goto: net::ERR_CONNECTION_REFUSED at /profile', expectationId: null, category: 'runtime-error' },
        artifacts: { console: 'artifacts/TC-003/console.log' },
      }),
      { testCaseId: 'TC-004', status: 'passed', isolated: true, durationMs: 50, artifacts: {} },
    ],
  };
  await mkdir(path.join(execDir, 'server'), { recursive: true });
  await writeFile(paths.results(execId), JSON.stringify(results));
  await writeFile(path.join(execDir, 'server', 'backend.log'), 'listening on 3000\nPOST /api/auth/login 200\nPOST /api/auth/login 200\n');
  await writeFile(path.join(execDir, 'server', 'frontend.log'), 'webpack compiled\n');
  await writeFile(path.join(execDir, 'server', 'setup.log'), `$ git checkout golden ${PATCH_NAME}\n`);
  for (const id of ['TC-001', 'TC-002']) {
    await mkdir(path.join(execDir, 'artifacts', id), { recursive: true });
    await writeFile(path.join(execDir, 'artifacts', id, 'network.json'), '[{"method":"POST","url":"/api/auth/login","status":200}]');
    await writeFile(path.join(execDir, 'artifacts', id, 'last-response.json'), '{"status":200,"body":"{\\"token\\":\\"t\\"}"}');
    await writeFile(path.join(execDir, 'artifacts', id, 'backend.log'), 'POST /api/auth/login 200\n');
  }
  await mkdir(path.join(execDir, 'artifacts', 'TC-003'), { recursive: true });
  await writeFile(path.join(execDir, 'artifacts', 'TC-003', 'console.log'), '[error] Failed to load resource');
  // Things the analyzer must never reach.
  await mkdir(path.join(execDir, 'suite'), { recursive: true });
  await writeFile(path.join(execDir, 'suite', '_target.json'), '{"note":"golden suite"}');
  await mkdir(path.join(paths.dir, 'executions', 'x-03', 'artifacts', 'TC-001'), { recursive: true });
  await writeFile(path.join(paths.dir, 'executions', 'x-03', 'artifacts', 'TC-001', 'network.json'), '"other execution: golden"');
  await mkdir(paths.evalDir, { recursive: true });
  await writeFile(path.join(paths.evalDir, 'scores.json'), '{"answer":"golden"}');
  await mkdir(path.join(paths.dir, 'ablation'), { recursive: true });

  await setExecution(paths.dir, {
    execId,
    ref: 'golden',
    commit,
    patch: path.posix.join('targets', 'fake', 'dev-bugs', PATCH_NAME),
    executeStatus: 'done',
    analyzeStatus: 'pending',
  });
  return { root, repo, commit, runsDir, runId, paths, execId, execDir, results };
}
