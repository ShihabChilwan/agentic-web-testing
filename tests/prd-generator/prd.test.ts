import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentSubmitError } from '../../src/agent/types.js';
import { LLMBudgetExceededError } from '../../src/llm/errors.js';
import { FakeLLMClient } from '../../src/llm/fake.js';
import type { FakeStep } from '../../src/llm/fake.js';
import { buildSystemPrompt, buildTask, describeCompleteness, generatePrd } from '../../src/modules/prd-generator/index.js';
import { draftCounts, PrdDraft, uncitedAdditions, unnamedPages } from '../../src/modules/prd-generator/draft.js';
import { buildCompletenessSystemPrompt } from '../../src/modules/prd-generator/prompt.js';
import { parseLLMConfig } from '../../src/shared/config.js';
import { Prd, RunManifest, TargetConfig } from '../../src/shared/schemas.js';
import { example } from '../shared/schemas/helpers.js';

// A tiny target in a temporary project: targets/fake/target.config.json and a git repo in targets/fake/repo.
let root: string;
let repoDir: string;
let goldenCommit: string;

const numbered = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1}`).join('\n') + '\n';

const targetConfig = () => {
  const c = structuredClone(example('target.config.json'));
  c.name = 'fake';
  c.repoPath = 'targets/fake/repo';
  c.forbiddenPaths = ['**/*.pe.*'];
  delete c.seedCheck;
  return c;
};

const llmConfig = parseLLMConfig({ LLM_BASE_URL: 'http://model.test/v1' });

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'prd-gen-'));
  repoDir = path.join(root, 'targets', 'fake', 'repo');
  await mkdir(path.join(repoDir, 'server', 'routes'), { recursive: true });
  await mkdir(path.join(repoDir, 'client', 'app'), { recursive: true });
  await mkdir(path.join(repoDir, 'node_modules', 'lib'), { recursive: true });
  await writeFile(path.join(repoDir, 'README.md'), numbered(5, 'readme'));
  await writeFile(path.join(repoDir, 'server', 'routes', 'auth.js'), numbered(30, 'auth'));
  await writeFile(path.join(repoDir, 'client', 'app', 'routes.js'), numbered(10, 'routes'));
  await writeFile(path.join(repoDir, 'client', 'app', 'Login.js'), numbered(150, 'login page'));
  await writeFile(path.join(repoDir, 'client', 'webpack.config.js'), numbered(20, 'webpack'));
  await writeFile(path.join(repoDir, 'server', 'billing.pe.js'), numbered(5, 'pro'));
  await writeFile(path.join(repoDir, 'node_modules', 'lib', 'index.js'), numbered(5, 'dep'));
  await writeFile(path.join(root, 'targets', 'fake', 'target.config.json'), JSON.stringify(targetConfig()));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repoDir, '-c', 'user.name=t', '-c', 'user.email=t@x.test', ...args], { encoding: 'utf8' });
  git('init', '--quiet');
  git('add', 'README.md', 'server', 'client');
  git('commit', '--quiet', '-m', 'fake app');
  git('branch', 'golden');
  goldenCommit = git('rev-parse', 'golden').trim();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

// Loose types on purpose: tests also send invalid items.
/* eslint-disable @typescript-eslint/no-explicit-any */
const feature = (id = 'F-01'): any => ({ id, name: 'Authentication', description: 'Users can log in.' });
const endpoint = (over: Record<string, unknown> = {}): any => ({
  method: 'POST',
  path: '/api/auth/login',
  authRequired: false,
  summary: 'Logs in.',
  responses: [{ status: 200, description: 'token' }],
  evidence: [{ file: 'server/routes/auth.js', lines: [1, 10] }],
  ...over,
});
const route = (over: Record<string, unknown> = {}): any => ({
  path: '/login',
  summary: 'Login form',
  authRequired: false,
  evidence: [{ file: 'client/app/routes.js', lines: [1, 5] }],
  ...over,
});
/** One criterion with the given evidence (default: a server range); `over` may replace any field. */
const requirement = ({ evidence, ...over }: Record<string, unknown> = {}): any => ({
  id: 'REQ-001',
  featureId: 'F-01',
  layer: 'api',
  statement: 'Logging in on /login with a wrong password is rejected.',
  acceptanceCriteria: [{ text: 'The response is 400', evidence: evidence ?? [{ file: 'server/routes/auth.js', lines: [12, 20] }] }],
  priority: 'high',
  ...over,
});

const call = (name: string, input: unknown) => FakeLLMClient.toolCall(name, input);
const happySteps = (): FakeStep[] => [
  call('list_files', { path: '.' }),
  call('read_file', { path: 'server/routes/auth.js' }),
  call('search_code', { pattern: 'auth' }),
  call('add_features', { features: [feature()] }),
  call('add_api_endpoints', { endpoints: [endpoint()] }),
  call('add_ui_routes', { routes: [route()] }),
  call('add_requirements', { requirements: [requirement()] }),
  call('submit_prd', { assumptions: ['Password reset email is untestable'], openQuestions: [] }),
  // The completeness round (§4) finds nothing more.
  call('finish_completeness', { notes: 'Every route file and page was already listed' }),
];

/* eslint-enable @typescript-eslint/no-explicit-any */

/** Each run gets its own runs folder: run ids are per second, so runs in the same second would collide. */
async function run(steps: FakeStep[], extra: { ref?: string; maxExploreCalls?: number } = {}) {
  const llm = new FakeLLMClient(steps);
  const runsDir = await mkdtemp(path.join(root, 'runs-'));
  let runDir: string | undefined;
  const promise = generatePrd({
    target: 'fake',
    targetsDir: path.join(root, 'targets'),
    projectRoot: root,
    runsDir,
    llmConfig,
    createLlm: async () => llm,
    onRunCreated: (dir) => (runDir = dir),
    ...extra,
  });
  return { llm, promise, runDir: () => runDir, runsDir };
}

const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const exists = (file: string) => access(file).then(() => true, () => false);

describe('generatePrd', () => {
  it('explores, records the document in batches, and writes prd.json and run.json', async () => {
    const { promise } = await run(happySteps());
    const result = await promise;
    const prd = Prd.parse(await readJson(result.prdFile));
    expect(prd).toMatchObject({ target: 'fake', sourceRef: 'golden', assumptions: ['Password reset email is untestable'] });
    expect([prd.features.length, prd.apiEndpoints.length, prd.uiRoutes.length, prd.requirements.length]).toEqual([1, 1, 1, 1]);
    expect(result.agent).toMatchObject({ toolCalls: 3, uncountedToolCalls: 4, turns: 8, budgetExhausted: false });
    expect(result.summary).toEqual({
      turns: 8,
      toolCalls: 3,
      toolCallCeiling: 200,
      explorationCeilingHit: false,
      toolCallsByTool: { list_files: 1, read_file: 1, search_code: 1, add_features: 1, add_api_endpoints: 1, add_ui_routes: 1, add_requirements: 1 },
      rejected: { invalidInput: 0, checkFailed: 0 },
    });

    const manifest = RunManifest.parse(await readJson(path.join(result.runDir, 'run.json')));
    expect(manifest).toMatchObject({ target: 'fake', generationRef: 'golden', generationCommit: goldenCommit });
    expect(manifest.stages.prd).toMatchObject({ status: 'done', startedAt: expect.any(String), finishedAt: expect.any(String) });
    expect(manifest.stages.prd?.agent).toEqual(result.summary);
    expect(manifest.llm.reasoningEffort.prd).toBe('medium');
    expect(await readdir(path.join(result.runDir, 'transcripts'))).toEqual(['prd-1.jsonl', 'prd-2.jsonl']);
    expect(manifest.stages.prd?.completeness).toMatchObject({ turns: 1, toolCalls: 0, toolCallCeiling: 60, added: { features: 0, apiEndpoints: 0, uiRoutes: 0, requirements: 0 } });
    expect(manifest.stages.prd?.completeness?.error).toBeUndefined();
  });

  it('returns a rejected batch to the model, stores nothing from it, and accepts the corrected batch', async () => {
    const steps = happySteps();
    steps.splice(
      4,
      0,
      call('add_api_endpoints', { endpoints: [endpoint({ path: '/auth/login' })] }),
      call('add_api_endpoints', { endpoints: Array.from({ length: 26 }, () => endpoint()) }),
    );
    const { llm, promise } = await run(steps);
    const result = await promise;
    const rejection = llm.requests[5]?.messages.at(-1);
    const text = rejection?.role === 'user' ? rejection.content.find((b) => b.type === 'tool_result') : undefined;
    expect(text).toMatchObject({ isError: true, content: expect.stringContaining('Batch rejected') });
    expect(text?.content).toContain('apiEndpoints[0].path: /auth/login does not start with /api');
    // One batch failed the code checks, one failed the tool's input schema (more than 25 items): counted separately.
    expect(result.summary.rejected).toEqual({ invalidInput: 1, checkFailed: 1 });
    expect(result.summary.toolCallsByTool.add_api_endpoints).toBe(3);
    expect(result.prd.apiEndpoints.map((e) => e.path)).toEqual(['/api/auth/login']);
  });

  it('marks the stage failed after three rejected submits, without writing prd.json', async () => {
    const empty = call('submit_prd', { assumptions: [], openQuestions: [] });
    const { promise, runDir } = await run([empty, empty, empty]);
    await expect(promise).rejects.toBeInstanceOf(AgentSubmitError);
    const manifest = await readJson(path.join(runDir()!, 'run.json'));
    expect(manifest.stages.prd).toMatchObject({ status: 'failed', error: expect.stringMatching(/^AgentSubmitError: /) });
    expect(await exists(path.join(runDir()!, 'prd.json'))).toBe(false);
  });

  it('records an LLM budget stop as the failure reason', async () => {
    const { promise, runDir } = await run([new LLMBudgetExceededError('token cap reached: 20000000 of 20000000')]);
    await expect(promise).rejects.toBeInstanceOf(LLMBudgetExceededError);
    const manifest = await readJson(path.join(runDir()!, 'run.json'));
    expect(manifest.stages.prd.error).toBe('LLMBudgetExceededError: token cap reached: 20000000 of 20000000');
  });

  it('stops exploring at the ceiling, still lets the model record and submit, and records the hit', async () => {
    const steps = happySteps();
    const { promise } = await run(steps, { maxExploreCalls: 2 });
    const result = await promise;
    expect(result.summary).toMatchObject({ toolCalls: 2, toolCallCeiling: 2, explorationCeilingHit: true });
    expect(result.prd.requirements).toHaveLength(1); // the search_code call was refused; recording still worked
    const manifest = await readJson(path.join(result.runDir, 'run.json'));
    expect(manifest.stages.prd.agent.explorationCeilingHit).toBe(true);
  });

  it('records the session summary in run.json when the stage fails', async () => {
    const empty = call('submit_prd', { assumptions: [], openQuestions: [] });
    const { promise, runDir } = await run([call('read_file', { path: 'README.md' }), empty, empty, empty]);
    await expect(promise).rejects.toBeInstanceOf(AgentSubmitError);
    const manifest = await readJson(path.join(runDir()!, 'run.json'));
    expect(manifest.stages.prd.agent).toMatchObject({ toolCalls: 1, toolCallsByTool: { read_file: 1 }, explorationCeilingHit: false });
  });

  it('creates no run folder when the ref does not exist', async () => {
    const { promise, runDir, runsDir } = await run(happySteps(), { ref: 'no-such-ref' });
    await expect(promise).rejects.toThrow(/git checkout/);
    expect(runDir()).toBeUndefined();
    expect(await readdir(runsDir)).toEqual([]);
  });
});

describe('PrdDraft batch checks', () => {
  const draft = () =>
    new PrdDraft({ scope: { root: repoDir, forbiddenPaths: ['**/*.pe.*'] }, apiPrefix: '/api', frontendRoots: ['client/app'] });
  const problemsOf = async (fn: () => Promise<string>) => {
    try {
      await fn();
    } catch (err) {
      return (err as Error).message.split('\n').slice(1).map((l) => l.replace(/^- /, ''));
    }
    throw new Error('expected the batch to be rejected');
  };
  const at = (file: string, lines: [number, number]) => [{ file, lines }];

  it('checks evidence files and line ranges with the repo tool rules', async () => {
    const d = draft();
    await d.addFeatures([feature()]);
    const problems = await problemsOf(() =>
      d.addRequirements([
        requirement({ evidence: at('server/routes/missing.js', [1, 2]) }),
        requirement({ id: 'REQ-002', evidence: at('server/routes/auth.js', [25, 31]) }),
        requirement({ id: 'REQ-003', evidence: at('server/routes', [1, 2]) }),
        requirement({ id: 'REQ-004', evidence: at('server/billing.pe.js', [1, 2]) }),
        requirement({ id: 'REQ-005', evidence: at('node_modules/lib/index.js', [1, 2]) }),
      ]),
    );
    expect(problems).toEqual([
      'requirements[0].acceptanceCriteria[0].evidence[0]: server/routes/missing.js does not exist',
      'requirements[1].acceptanceCriteria[0].evidence[0]: range [25, 31] ends past the last line of server/routes/auth.js (30)',
      'requirements[2].acceptanceCriteria[0].evidence[0]: server/routes is a directory, not a file',
      'requirements[3].acceptanceCriteria[0].evidence[0]: server/billing.pe.js does not exist',
      'requirements[4].acceptanceCriteria[0].evidence[0]: node_modules/lib/index.js does not exist',
    ]);
    expect(d.requirements).toEqual([]);
    expect(await d.addRequirements([requirement({ evidence: at('server/routes/auth.js', [25, 30]) })])).toContain(
      'Next requirement id: REQ-002',
    );
  });

  it('requires ids to continue the sequence across batches', async () => {
    const d = draft();
    expect(await d.addFeatures([feature('F-01'), feature('F-02')])).toBe(
      'Stored 2 feature(s): F-01 to F-02. Next feature id: F-03.',
    );
    expect(await problemsOf(() => d.addFeatures([feature('F-04')]))).toEqual(['features[0].id: expected F-03, got F-04']);
    await d.addRequirements([requirement()]);
    expect(await problemsOf(() => d.addRequirements([requirement({ id: 'REQ-003' })]))).toEqual([
      'requirements[0].id: expected REQ-002, got REQ-003',
    ]);
  });

  it('requires the feature of a requirement to exist', async () => {
    const d = draft();
    await d.addFeatures([feature()]);
    expect(await problemsOf(() => d.addRequirements([requirement({ featureId: 'F-09' })]))).toEqual([
      'requirements[0].featureId: F-09 is not a feature; add it with add_features first',
    ]);
  });

  it('requires endpoint paths under the API prefix and no duplicate endpoints or routes', async () => {
    const d = draft();
    expect(await problemsOf(() => d.addApiEndpoints([endpoint({ path: '/apix/login' })]))).toEqual([
      'apiEndpoints[0].path: /apix/login does not start with /api',
    ]);
    expect(await problemsOf(() => d.addApiEndpoints([endpoint(), endpoint()]))).toEqual([
      'apiEndpoints[1]: POST /api/auth/login is listed twice',
    ]);
    await d.addApiEndpoints([endpoint()]);
    expect(await problemsOf(() => d.addApiEndpoints([endpoint()]))).toEqual(['apiEndpoints[0]: POST /api/auth/login is listed twice']);
    expect(await d.addApiEndpoints([endpoint({ method: 'GET' })])).toBe('Stored 1 API endpoint(s); 2 in total.');
    await d.addUiRoutes([route()]);
    expect(await problemsOf(() => d.addUiRoutes([route()]))).toEqual(['uiRoutes[0]: /login is listed twice']);
  });

  it('accepts any endpoint path when the target has no API prefix', async () => {
    const d = new PrdDraft({ scope: { root: repoDir, forbiddenPaths: [] }, apiPrefix: '', frontendRoots: ['client/app'] });
    expect(await d.addApiEndpoints([endpoint({ path: '/login' })])).toContain('Stored 1');
  });

  it('lists at most 40 problems', async () => {
    const d = draft();
    const many = Array.from({ length: 25 }, (_, i) =>
      requirement({ id: `REQ-${String(i + 2).padStart(3, '0')}`, featureId: 'F-09' }),
    );
    const problems = await problemsOf(() => d.addRequirements(many));
    expect(problems).toHaveLength(41);
    expect(problems.at(-1)).toBe('... and 10 more');
  });

  it('limits criterion evidence to 100 lines', async () => {
    const d = draft();
    await d.addFeatures([feature()]);
    expect(await problemsOf(() => d.addRequirements([requirement({ evidence: at('client/app/Login.js', [1, 101]) })]))).toEqual([
      'requirements[0].acceptanceCriteria[0].evidence[0]: range [1, 101] spans 101 lines (at most 100); narrow it to the handler or component that shows the behaviour',
    ]);
    expect(await d.addRequirements([requirement({ evidence: at('client/app/Login.js', [1, 100]) })])).toContain('Stored 1');
  });

  it('does not limit endpoint and UI route evidence to 100 lines', async () => {
    const d = draft();
    expect(await d.addUiRoutes([route({ evidence: at('client/app/Login.js', [1, 150]) })])).toContain('Stored 1');
  });

  it('requires a ui or e2e requirement to cite frontend source in at least one criterion', async () => {
    const d = draft();
    await d.addFeatures([feature()]);
    const serverOnly = requirement({ layer: 'ui' });
    const buildConfig = requirement({ layer: 'e2e', evidence: at('client/webpack.config.js', [1, 10]) });
    const problems = await problemsOf(() => d.addRequirements([serverOnly, { ...buildConfig, id: 'REQ-002' }]));
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^requirements\[0\]: a ui requirement needs at least one criterion whose evidence is in the frontend source \(client\/app\)/);
    expect(problems[1]).toMatch(/^requirements\[1\]: an e2e requirement/);
    const mixed = requirement({ layer: 'e2e' });
    mixed.acceptanceCriteria.push({ text: 'An error message is visible', evidence: at('client/app/Login.js', [40, 60]) });
    expect(await d.addRequirements([mixed])).toContain('Stored 1');
    expect(await d.addRequirements([requirement({ id: 'REQ-002' })])).toContain('Stored 1'); // api needs no frontend evidence
  });

  it('cannot be finished without features and requirements', () => {
    expect(draft().completeness()).toEqual([
      'No features recorded yet; use add_features.',
      'No requirements recorded yet; use add_requirements.',
    ]);
  });
});

describe('PRD prompts', () => {
  it('uses the same system prompt for every target, with nothing about the app', () => {
    const a = TargetConfig.parse(example('target.config.json'));
    expect(buildSystemPrompt()).not.toMatch(new RegExp(a.name, 'i'));
    expect(buildSystemPrompt()).not.toMatch(/ecommerce|product|cart|mongo|mailgun|client\/app/i);
  });

  it('never tells the model its tool budget', () => {
    expect(buildSystemPrompt()).not.toMatch(/\d+ (tool )?calls|budget/i);
  });

  it('puts only config facts in the task: API prefix, frontend roots, disabled services, source hints', () => {
    const config = TargetConfig.parse(example('target.config.json'));
    const task = buildTask(config);
    expect(task).toContain('The API path prefix is "/api"');
    expect(task).toContain("The frontend's page and component source is under: client/app.");
    expect(task).toContain('MAILGUN_KEY, MAILGUN_DOMAIN');
    expect(task).toContain('README.md, server/**, client/app/**');
    expect(task).not.toContain(config.name);
  });

  it('for a one-process app (no frontend) says the backend serves the pages and where their source is', () => {
    const { frontend: _f, ...rest } = TargetConfig.parse(example('target.config.json'));
    const task = buildTask({ ...rest, backend: { ...rest.backend, sourceRoots: ['server/views', 'static/scripts'] } });
    expect(task).toContain('There is no separate frontend: the backend serves the pages. Their templates and page scripts are under: server/views, static/scripts.');
    expect(task).not.toContain("The frontend's page and component source");
  });

  it('falls back to frontend.cwd and generic service names when the config has neither', () => {
    const config = TargetConfig.parse(example('target.config.json'));
    const { sourceRoots: _r, ...frontend } = config.frontend!;
    const task = buildTask({ ...config, frontend, backend: { ...config.backend, disabledServices: {} } });
    expect(task).toContain('source is under: client.');
    expect(task).toContain('(email, payments, OAuth, external storage) are disabled');
  });
});

describe('completeness round', () => {
  const mainSteps = () => happySteps().slice(0, -1); // up to submit_prd
  const nested = route({ path: '/settings/profile', summary: 'Profile tab of the settings page', authRequired: true, evidence: [{ file: 'client/app/routes.js', lines: [6, 9] }] });
  const nestedRequirement = requirement({
    id: 'REQ-002',
    layer: 'ui',
    statement: 'A logged-in user sees their email on the profile tab.',
    acceptanceCriteria: [{ text: 'The /settings/profile page shows the email field', evidence: [{ file: 'client/app/Login.js', lines: [1, 20] }] }],
  });

  it('adds what the first pass missed, each page or endpoint named by a requirement, and records the counts', async () => {
    const { llm, promise } = await run([
      ...mainSteps(),
      call('search_code', { pattern: 'path' }),
      call('add_ui_routes', { routes: [nested] }),
      call('add_requirements', { requirements: [nestedRequirement] }),
      call('finish_completeness', {}),
    ]);
    const result = await promise;
    expect(result.prd.uiRoutes.map((r) => r.path)).toEqual(['/login', '/settings/profile']);
    expect(result.prd.requirements.map((r) => r.id)).toEqual(['REQ-001', 'REQ-002']);
    expect(result.completeness).toMatchObject({ toolCalls: 1, added: { features: 0, apiEndpoints: 0, uiRoutes: 1, requirements: 1 } });
    expect(result.summary.toolCallsByTool.add_ui_routes).toBe(1); // the first session's summary stays its own
    // The round's task lists what is recorded and the next ids; its system prompt is the round's own.
    const roundStart = llm.requests[mainSteps().length]!;
    const task = roundStart.messages[0]!;
    const text = task.role === 'user' ? task.content.map((b) => (b.type === 'text' ? b.text : '')).join('') : '';
    expect(text).toContain('- POST /api/auth/login');
    expect(text).toContain('- /login');
    expect(text).toContain('Next requirement id: REQ-002.');
    expect(roundStart.system).toBe(buildCompletenessSystemPrompt());
    const manifest = RunManifest.parse(await readJson(path.join(result.runDir, 'run.json')));
    expect(manifest.stages.prd?.completeness?.added).toEqual({ features: 0, apiEndpoints: 0, uiRoutes: 1, requirements: 1 });
  });

  it('refuses to finish while an added page has no requirement naming it', async () => {
    const { llm, promise } = await run([
      ...mainSteps(),
      call('add_ui_routes', { routes: [nested] }),
      call('finish_completeness', {}),
      call('add_requirements', { requirements: [nestedRequirement] }),
      call('finish_completeness', {}),
    ]);
    const result = await promise;
    const rejected = JSON.stringify(llm.requests[mainSteps().length + 2]!.messages.at(-1));
    expect(rejected).toContain('No requirement names the page /settings/profile; add a requirement for what it shows whose statement or a criterion contains /settings/profile');
    expect(result.completeness.added.requirements).toBe(1);
  });

  it('never fails the stage: an unfinished round keeps what it stored and records why', async () => {
    const finish = call('finish_completeness', {});
    const { promise } = await run([...mainSteps(), call('add_ui_routes', { routes: [nested] }), finish, finish, finish]);
    const result = await promise;
    expect(result.prd.uiRoutes).toHaveLength(2);
    expect(result.completeness.error).toMatch(/^AgentSubmitError: /);
    const manifest = RunManifest.parse(await readJson(path.join(result.runDir, 'run.json')));
    expect(manifest.stages.prd).toMatchObject({ status: 'done', completeness: { error: expect.stringMatching(/^AgentSubmitError/) } });
    expect(describeCompleteness(result.completeness)).toEqual([
      'completeness round: added 0 API endpoint(s), 1 page(s), 0 requirement(s), 0 feature(s); 0 exploring calls',
      `Warning: the completeness round ended early (${result.completeness.error}); what it recorded is kept.`,
    ]);
  });

  it('asks for a requirement naming each added endpoint and every page, a catch-all excepted; paths match by template', () => {
    const draft = new PrdDraft({ scope: { root: repoDir, forbiddenPaths: [] }, apiPrefix: '/api', frontendRoots: ['client/app'] });
    draft.uiRoutes.push(route({ path: '/about' }), route({ path: '/*' })); // recorded by the first pass
    const before = draftCounts(draft);
    draft.apiEndpoints.push(endpoint({ method: 'GET', path: '/api/items/:id' }));
    draft.uiRoutes.push(route({ path: '/product/:slug' }));
    expect(unnamedPages(draft)).toEqual(['/about', '/product/:slug']);
    expect(uncitedAdditions(draft, before)).toEqual([
      'GET /api/items/:id was added but no requirement names it; add a requirement whose statement or a criterion contains /api/items/:id',
      'No requirement names the page /about; add a requirement for what it shows whose statement or a criterion contains /about',
      'No requirement names the page /product/:slug; add a requirement for what it shows whose statement or a criterion contains /product/:slug',
    ]);
    draft.requirements.push(
      requirement({ statement: 'GET /api/items/<id> returns the item.', acceptanceCriteria: [{ text: 'Opening /product/blue-shirt, shows its price', evidence: [] }] }),
      requirement({ id: 'REQ-002', statement: 'The page at http://localhost:8080/about shows the team.' }),
    );
    expect(uncitedAdditions(draft, before)).toEqual([]);
  });

  it("lists the first pass's unnamed pages in the round's task", async () => {
    const unnamedRoute = route({ path: '/about', evidence: [{ file: 'client/app/routes.js', lines: [1, 5] }] });
    const steps = happySteps();
    steps.splice(5, 1, call('add_ui_routes', { routes: [route(), unnamedRoute] }));
    const aboutRequirement = requirement({ id: 'REQ-002', layer: 'ui', statement: 'The /about page shows the team.', acceptanceCriteria: [{ text: 'The team list is shown', evidence: [{ file: 'client/app/Login.js', lines: [1, 10] }] }] });
    steps.splice(-1, 1, call('add_requirements', { requirements: [aboutRequirement] }), call('finish_completeness', {}));
    const { llm, promise } = await run(steps);
    const result = await promise;
    const task = JSON.stringify(llm.requests[mainSteps().length]!.messages[0]);
    expect(task).toContain('Pages that no requirement names by its path yet (1): /about.');
    expect(result.completeness.added.requirements).toBe(1);
  });
});
