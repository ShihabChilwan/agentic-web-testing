import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCloudContext, FALLBACK_STATUS_SCRIPT, findSecrets, renderEntrypoint, replaceDeep } from '../../src/eval/cloud/context.js';
import { importRepeat } from '../../src/eval/cloud/import.js';
import { findLeaks } from '../../src/eval/cloud/leaks.js';
import { suiteHash } from '../../src/eval/cloud/suite.js';
import { runCloudTask } from '../../src/eval/cloud/task.js';
import { execIdsFor, taskVersion, versionsFrom } from '../../src/eval/cloud/versions.js';
import type { executeRun } from '../../src/modules/execution-engine/index.js';
import { runPaths } from '../../src/shared/paths.js';
import { readRunManifest, setExecution } from '../../src/shared/run-manifest.js';
import { CloudBuild, CloudTaskStatus, EvalMapping, RunManifest, Variants } from '../../src/shared/schemas.js';
import { example } from '../shared/schemas/helpers.js';

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const COMMIT = '7f73dfbd68a27b6945fe7fbf654067004816d09e';
const SOURCE_RUN = 'fake-20261020-204011';
const variants = Variants.parse(example('variants.json'));
const versions = versionsFrom(variants, 'targets/fake');

function manifest(): RunManifest {
  const m = structuredClone(example('run.json'));
  m.runId = SOURCE_RUN;
  m.target = 'fake';
  m.generationCommit = COMMIT;
  m.stages.scripts = { status: 'done', startedAt: '2026-10-24T10:12:00Z', finishedAt: '2026-10-24T11:00:00Z' };
  m.executions = [];
  return RunManifest.parse(m);
}

/** A source run folder with a tiny suite. */
async function sourceRun(runsDir: string): Promise<string> {
  const dir = runPaths(SOURCE_RUN, runsDir).dir;
  await mkdir(path.join(dir, 'scripts'), { recursive: true });
  await writeFile(path.join(dir, 'run.json'), JSON.stringify(manifest()));
  await writeFile(path.join(dir, 'prd.json'), '{}');
  await writeFile(path.join(dir, 'testcases.json'), '{"testCases":[]}');
  await writeFile(path.join(dir, 'scripts', 'TC-001.spec.ts'), "test('TC-001', async () => {});\n");
  await writeFile(path.join(dir, 'scripts', 'manifest.json'), '{}');
  return dir;
}

async function build(runDir: string): Promise<CloudBuild> {
  return CloudBuild.parse({
    schemaVersion: '1.0',
    target: 'fake',
    sourceRunId: SOURCE_RUN,
    generationRef: 'golden',
    goldenCommit: COMMIT,
    frameworkCommit: COMMIT,
    suiteHash: await suiteHash(runDir),
    imageTag: '7f73dfb-12345678',
    createdAt: '2026-10-24T12:00:00Z',
    replace: { 'mongo:': '127.0.0.1:' },
    versions,
  });
}

/** An image folder (build.json + the suite's run folder), a results folder and an empty runs folder for the task. */
async function imageSetup(logLines: string[] = []) {
  const root = await tempDir('cloud-task-');
  const sourceRuns = path.join(root, 'source-runs');
  const runDir = await sourceRun(sourceRuns);
  const imageDir = path.join(root, 'image');
  await mkdir(imageDir);
  await writeFile(path.join(imageDir, 'build.json'), JSON.stringify(await build(runDir)));
  await cp(runDir, path.join(imageDir, 'run'), { recursive: true });
  const cgroupDir = path.join(root, 'cgroup');
  await mkdir(cgroupDir);
  await writeFile(path.join(cgroupDir, 'memory.peak'), '2147483648\n');
  await writeFile(path.join(cgroupDir, 'memory.max'), '4294967296\n');
  await writeFile(path.join(cgroupDir, 'memory.events'), 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n');
  const serviceLog = path.join(root, 'mongod.log');
  await writeFile(serviceLog, '{"msg":"Waiting for connections"}\n');
  return { root, sourceRuns, imageDir, cgroupDir, serviceLog, resultsDir: path.join(root, 'results'), runsDir: path.join(root, 'runs'), logLines, log: (m: string) => logLines.push(m) };
}

/** Stands in for executeRun: writes an execution folder and its run.json entry like the real one. */
function fakeExecute(backendLog = 'GET /api/product/list 200\n', fail = false): typeof executeRun {
  return (async (options: Parameters<typeof executeRun>[0]) => {
    const paths = runPaths(options!.runId!, options!.runsDir);
    const execDir = paths.executionDir(options!.execId!);
    await mkdir(path.join(execDir, 'server'), { recursive: true });
    await writeFile(path.join(execDir, 'server', 'backend.log'), backendLog);
    await writeFile(path.join(execDir, 'results.json'), JSON.stringify({ ...example('results.json'), execId: options!.execId }));
    await writeFile(path.join(execDir, 'trace.zip'), 'bug-001 inside a binary the analyzer cannot read');
    await setExecution(paths.dir, {
      execId: options!.execId!,
      ref: options!.ref!,
      commit: COMMIT,
      executeStatus: fail ? 'failed' : 'done',
      analyzeStatus: 'pending',
    });
    if (fail) throw new Error('Health check failed: backend did not start');
  }) as unknown as typeof executeRun;
}

describe('version list and opaque ids', () => {
  it('puts golden first, then the variants with their patch or override', () => {
    expect(versions).toEqual([
      { version: 'golden', skipSeed: false },
      { version: 'bug-001', patch: 'targets/fake/variants/bug-001.patch', skipSeed: false },
      { version: 'env-01', configOverride: { backend: { env: { MONGO_URI: 'mongodb://mongo:27999/mern_ecommerce_test' } } }, skipSeed: false },
    ]);
  });

  it('gives every repeat its own shuffle of x-01..x-NN, the same in every task', () => {
    const names = Array.from({ length: 18 }, (_, i) => `v${i}`);
    const a = execIdsFor(names, 'eval-9b-abcde');
    expect(execIdsFor(names, 'eval-9b-abcde')).toEqual(a);
    expect([...a.values()].sort()).toEqual(Array.from({ length: 18 }, (_, i) => `x-${String(i + 1).padStart(2, '0')}`));
    expect([...execIdsFor(names, 'eval-9b-fghij').values()]).not.toEqual([...a.values()]);
    expect([...a.values()]).not.toEqual([...a.values()].sort()); // not in version order
  });

  it('looks the task up from Cloud Run variables and rejects missing or bad ones', async () => {
    const b = await build(await sourceRun(await tempDir('cloud-build-')));
    const env = (index?: string, repeat?: string) => ({ ...(index !== undefined && { CLOUD_RUN_TASK_INDEX: index }), ...(repeat !== undefined && { CLOUD_RUN_EXECUTION: repeat }) });
    expect(taskVersion(b, env('0', 'local-1'))).toMatchObject({ index: 0, repeatId: 'local-1', version: { version: 'golden' } });
    expect(taskVersion(b, env('2', 'local-1')).execId).toBe(execIdsFor(['golden', 'bug-001', 'env-01'], 'local-1').get('env-01'));
    expect(() => taskVersion(b, env(undefined, 'local-1'))).toThrow(/CLOUD_RUN_TASK_INDEX must be a number/);
    expect(() => taskVersion(b, env('3', 'local-1'))).toThrow(/outside the image's 3 versions/);
    expect(() => taskVersion(b, env('-1', 'local-1'))).toThrow(/must be a number/);
    expect(() => taskVersion(b, env('0'))).toThrow(/CLOUD_RUN_EXECUTION/);
    expect(() => taskVersion(b, env('0', '../x'))).toThrow(/CLOUD_RUN_EXECUTION/);
  });
});

describe('cloud task', () => {
  it('runs its version under the opaque id and writes <repeat>/<version>/ with the execution, service log and status', async () => {
    const s = await imageSetup();
    let seen: Parameters<typeof executeRun>[0];
    const execute = fakeExecute();
    const code = await runCloudTask({
      resultsDir: s.resultsDir,
      imageDir: s.imageDir,
      runsDir: s.runsDir,
      projectRoot: s.root,
      env: { CLOUD_RUN_TASK_INDEX: '1', CLOUD_RUN_EXECUTION: 'eval-9b-abcde' },
      cgroupDir: s.cgroupDir,
      serviceLogs: [s.serviceLog],
      execute: (async (o) => {
        seen = o;
        return execute(o);
      }) as typeof executeRun,
      log: s.log,
    });
    expect(code).toBe(0);
    const execId = execIdsFor(['golden', 'bug-001', 'env-01'], 'eval-9b-abcde').get('bug-001')!;
    expect(seen!).toMatchObject({ runId: SOURCE_RUN, ref: 'golden', execId, patch: path.join(s.root, 'targets/fake/variants/bug-001.patch') });
    const out = path.join(s.resultsDir, 'eval-9b-abcde', 'bug-001');
    expect((await readdir(out)).sort()).toEqual(['execution.tar.gz', 'mongod.log', 'status.json']);
    const status = CloudTaskStatus.parse(JSON.parse(await readFile(path.join(out, 'status.json'), 'utf8')));
    expect(status).toMatchObject({
      version: 'bug-001',
      execId,
      outcome: 'done',
      execution: { ref: 'golden', commit: COMMIT, patch: 'targets/fake/variants/bug-001.patch' },
      memory: { peakBytes: 2147483648, limitBytes: 4294967296, oomKills: 0 },
    });
    const summary = example('results.json').summary;
    expect(status.summary).toEqual({ total: summary.total, passed: summary.passed, failed: summary.failed, errored: summary.errored, skipped: summary.skipped ?? 0 });
    expect(s.logLines.at(-1)).toMatch(new RegExp(`^done in \\d+ s; ${summary.passed} passed, ${summary.failed} failed, ${summary.errored} errored, ${summary.skipped ?? 0} skipped; peak memory 2048 MiB of 4096 MiB, OOM kills 0`));
    expect(execFileSync('tar', ['-tzf', path.join(out, 'execution.tar.gz')], { encoding: 'utf8' })).toContain(`${execId}/server/backend.log`);
  });

  it('exits 1 but still saves status and results when the execution itself fails, and never runs a version twice', async () => {
    const s = await imageSetup();
    const options = {
      resultsDir: s.resultsDir,
      imageDir: s.imageDir,
      runsDir: s.runsDir,
      projectRoot: s.root,
      env: { CLOUD_RUN_TASK_INDEX: '0', CLOUD_RUN_EXECUTION: 'local-1' },
      cgroupDir: path.join(s.root, 'no-cgroup'),
      execute: fakeExecute('', true),
      log: s.log,
    };
    expect(await runCloudTask(options)).toBe(1);
    const status = CloudTaskStatus.parse(JSON.parse(await readFile(path.join(s.resultsDir, 'local-1', 'golden', 'status.json'), 'utf8')));
    expect(status).toMatchObject({ outcome: 'failed', error: expect.stringContaining('Health check failed'), memory: { peakBytes: null, limitBytes: null, oomKills: null } });
    expect(status.summary).toMatchObject({ total: 40, passed: 36 }); // the fake still wrote results.json
    await expect(runCloudTask(options)).rejects.toThrow(/already ran in repeat local-1/);
  });
});

describe('entrypoint', () => {
  /** An app folder like /app in the image: build.json, the fallback script and a stand-in for tsx that runs `task`. */
  async function app(task: string, startServices = 'true') {
    const s = await imageSetup();
    const appDir = path.join(s.root, 'app');
    await mkdir(path.join(appDir, 'image'), { recursive: true });
    await mkdir(path.join(appDir, 'node_modules', '.bin'), { recursive: true });
    await cp(path.join(s.imageDir, 'build.json'), path.join(appDir, 'image', 'build.json'));
    await cp(FALLBACK_STATUS_SCRIPT, path.join(appDir, 'image', 'fallback-status.cjs'));
    await writeFile(path.join(appDir, 'node_modules', '.bin', 'tsx'), `#!/bin/sh\n${task}\n`, { mode: 0o755 });
    await writeFile(path.join(appDir, 'entrypoint.sh'), await renderEntrypoint({ startServices, serviceLogs: [s.serviceLog] }), { mode: 0o755 });
    const run = () =>
      spawnSync('sh', [path.join(appDir, 'entrypoint.sh')], {
        env: { PATH: process.env.PATH, APP_DIR: appDir, RESULTS_DIR: s.resultsDir, CGROUP_DIR: s.cgroupDir, CLOUD_RUN_TASK_INDEX: '1', CLOUD_RUN_EXECUTION: 'local-1' },
        encoding: 'utf8',
      });
    const status = async () => CloudTaskStatus.parse(JSON.parse(await readFile(path.join(s.resultsDir, 'local-1', 'bug-001', 'status.json'), 'utf8')));
    return { s, run, status };
  }

  it('writes a failed status.json when the task crashes before writing its own (e.g. a missing module)', async () => {
    const { s, run, status } = await app("echo \"Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'typescript'\" >&2; exit 3");
    const result = run();
    expect(result.status).toBe(3);
    expect(await status()).toMatchObject({
      version: 'bug-001',
      execId: null,
      outcome: 'failed',
      error: 'eval cloud-task stopped before writing status.json; see the task log (exit code 3)',
      execution: { ref: 'golden', patch: 'targets/fake/variants/bug-001.patch' },
      memory: { peakBytes: 2147483648, limitBytes: 4294967296, oomKills: 0 },
      summary: null,
    });
    expect(await readdir(path.join(s.resultsDir, 'local-1', 'bug-001'))).toContain('mongod.log');
  });

  it('writes a failed status.json when the services do not start, without running the task', async () => {
    const { run, status } = await app('echo ran > "$RESULTS_DIR/ran"; exit 0', 'false');
    expect(run().status).toBe(1);
    expect((await status()).error).toBe("The target's services did not start; see the task log (exit code 1)");
  });

  it("keeps the task's own status.json and exit code", async () => {
    const own = JSON.stringify({ own: true });
    const { s, run } = await app(`mkdir -p "$RESULTS_DIR/local-1/bug-001" && echo '${own}' > "$RESULTS_DIR/local-1/bug-001/status.json"; exit 1`);
    expect(run().status).toBe(1);
    expect(JSON.parse(await readFile(path.join(s.resultsDir, 'local-1', 'bug-001', 'status.json'), 'utf8'))).toEqual({ own: true });
    const ok = await app('exit 0');
    expect(ok.run().status).toBe(0);
    expect(await stat(path.join(ok.s.resultsDir, 'local-1')).then(() => true, () => false)).toBe(false);
  });

  it('an import lists a task that never ran without an execution', async () => {
    const { s, run } = await app('exit 3');
    run();
    for (const index of [0, 2]) {
      await runCloudTask({ resultsDir: s.resultsDir, imageDir: s.imageDir, runsDir: s.runsDir, projectRoot: s.root, env: { CLOUD_RUN_TASK_INDEX: String(index), CLOUD_RUN_EXECUTION: 'local-1' }, cgroupDir: s.cgroupDir, execute: fakeExecute(), log: s.log });
    }
    const { runId, mapping } = await importRepeat({ from: path.join(s.resultsDir, 'local-1'), runsDir: s.sourceRuns });
    expect(mapping.versions.find((v) => v.version === 'bug-001')).toMatchObject({ execId: null, outcome: 'failed' });
    expect((await readRunManifest(runPaths(runId, s.sourceRuns).runJson)).executions).toHaveLength(2);
  });
});

describe('import', () => {
  async function runRepeat(s: Awaited<ReturnType<typeof imageSetup>>, repeat: string, logFor: (index: number) => string = () => 'ok\n') {
    for (const index of [0, 1, 2]) {
      await runCloudTask({
        resultsDir: s.resultsDir,
        imageDir: s.imageDir,
        runsDir: s.runsDir,
        projectRoot: s.root,
        env: { CLOUD_RUN_TASK_INDEX: String(index), CLOUD_RUN_EXECUTION: repeat },
        cgroupDir: s.cgroupDir,
        execute: fakeExecute(logFor(index)),
        log: s.log,
      });
    }
    return path.join(s.resultsDir, repeat);
  }

  it('creates a new run per repeat with opaque executions, run.json entries and a mapping', async () => {
    const s = await imageSetup();
    const from = await runRepeat(s, 'eval-9b-abcde');
    const { runId, mapping } = await importRepeat({ from, runsDir: s.sourceRuns, now: () => new Date('2026-10-25T09:00:00Z') });
    expect(runId).toBe('fake-20261025-090000');
    const paths = runPaths(runId, s.sourceRuns);
    const ids = execIdsFor(['golden', 'bug-001', 'env-01'], 'eval-9b-abcde');
    const m = await readRunManifest(paths.runJson);
    expect(m.executions.map((e) => [e.execId, e.patch ?? null, e.configOverride ?? null, e.executeStatus, e.analyzeStatus]).sort()).toEqual(
      [
        [ids.get('golden'), null, null, 'done', 'pending'],
        [ids.get('bug-001'), 'targets/fake/variants/bug-001.patch', null, 'done', 'pending'],
        [ids.get('env-01'), null, { backend: { env: { MONGO_URI: 'mongodb://mongo:27999/mern_ecommerce_test' } } }, 'done', 'pending'],
      ].sort(),
    );
    for (const id of ids.values()) expect(await stat(path.join(paths.executionDir(id), 'server', 'backend.log'))).toBeTruthy();
    expect(await readFile(path.join(paths.dir, 'scripts', 'TC-001.spec.ts'), 'utf8')).toContain('TC-001');
    const saved = EvalMapping.parse(JSON.parse(await readFile(path.join(paths.evalDir, 'mapping.json'), 'utf8')));
    expect(saved).toEqual(mapping);
    expect(saved.versions.map((v) => [v.version, v.execId])).toEqual([...ids.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  });

  it('refuses an execution whose readable files name a version, and leaves no run behind', async () => {
    const s = await imageSetup();
    const from = await runRepeat(s, 'local-1', (i) => (i === 1 ? 'applied bug-001 to the tree\n' : 'ok\n'));
    await expect(importRepeat({ from, runsDir: s.sourceRuns })).rejects.toThrow(/would show the analyzer what it ran: server\/backend.log:1 "bug-001"/);
    expect((await readdir(s.sourceRuns)).sort()).toEqual([SOURCE_RUN]);
  });

  it('refuses results whose suite differs from the source run', async () => {
    const s = await imageSetup();
    const from = await runRepeat(s, 'local-1');
    await writeFile(path.join(s.sourceRuns, SOURCE_RUN, 'scripts', 'TC-001.spec.ts'), '// changed\n');
    await expect(importRepeat({ from, runsDir: s.sourceRuns })).rejects.toThrow(/changed since the image was built/);
  });
});

describe('leak scan', () => {
  it('finds version names, patch paths and fault ids in readable files and file names, and skips binaries', async () => {
    const dir = await tempDir('leaks-');
    await mkdir(path.join(dir, 'server'));
    const lines: Array<[string, string]> = [
      ['a.log', 'checked out golden\n'],
      ['b.log', 'ok\nbug-012 here\n'],
      ['c.json', '{"fault":"env-05"}'],
      ['d.txt', 'targets/x/variants/'],
      ['e.txt', 'git apply x.patch'],
      ['f.txt', 'Golden Retriever, goldenrod, debug-0011, environment-01, a.patcher'],
      ['shot.png', 'bug-001'],
      ['env-03.log', 'fine'],
    ];
    for (const [name, text] of lines) await writeFile(path.join(dir, 'server', name), text);
    expect((await findLeaks(dir)).map((l) => `${l.file}:${l.line}:${l.match}`)).toEqual([
      'server/a.log:1:golden',
      'server/b.log:2:bug-012',
      'server/c.json:1:env-05',
      'server/d.txt:1:variants',
      'server/e.txt:1:.patch',
      'server/env-03.log:0:env-03',
    ]);
  });
});

describe('build folder', () => {
  it('rewrites strings deeply and finds secrets and .env files', async () => {
    expect(replaceDeep({ a: ['mongodb://mongo:27017/x'], b: { c: 'mongo:1' }, d: 3 }, { 'mongo:': '127.0.0.1:' })).toEqual({
      a: ['mongodb://127.0.0.1:27017/x'],
      b: { c: '127.0.0.1:1' },
      d: 3,
    });
    const dir = await tempDir('secrets-');
    await writeFile(path.join(dir, 'config.ts'), 'const key = env.LLM_API_KEY;\nconst re = /LLM_API_KEY\\s*=/;\n');
    await writeFile(path.join(dir, '.env'), 'X=1\n');
    await writeFile(path.join(dir, 'leak.ts'), 'LLM_API_KEY=abcdefghij123\n');
    await writeFile(path.join(dir, 'token.txt'), 'sk-or-v1-0123456789abcdef0123456789\n');
    expect((await findSecrets(dir)).sort()).toEqual(['.env', 'leak.ts', 'token.txt']);
  });

  it('writes the committed framework without tests, dev bugs or answers, the bundle, the suite and the Dockerfile', async () => {
    const root = await tempDir('cloud-context-');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@x.test', ...args], { encoding: 'utf8' }).trim();
    const write = async (rel: string, text: string) => {
      await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await writeFile(path.join(root, rel), text);
    };
    // The target repo with a golden branch.
    const repo = path.join(root, 'targets', 'fake', 'repo');
    await mkdir(path.join(repo, 'server'), { recursive: true });
    await writeFile(path.join(repo, 'server', 'index.js'), 'console.log(1);\n');
    git(repo, 'init', '--quiet');
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', 'golden');
    git(repo, 'branch', 'golden');
    const golden = git(repo, 'rev-parse', 'golden');
    // The project, committed.
    const config = structuredClone(example('target.config.json'));
    config.name = 'fake';
    config.repoPath = 'targets/fake/repo';
    const evaluation = { ...example('evaluation.json'), cloud: { replace: { 'mongo:': '127.0.0.1:' }, imageSetup: 'apt-get install -y db', startServices: 'db --fork', serviceLogs: ['/tmp/db.log'] } };
    await write('.gitignore', 'targets/*/repo/\nruns/\nbuild/\n');
    await write('package.json', '{"name":"p"}\n');
    await write('src/cli.ts', '// cli\n');
    await write('src/eval/cloud/template/x.txt', 'template\n');
    await write('tests/a.test.ts', '// test\n');
    await write('cloud/setup.ps1', '# host script\n');
    await write('.env.example', 'LLM_API_KEY=\n');
    await write('targets/fake/target.config.json', JSON.stringify(config));
    await write('targets/fake/evaluation.json', JSON.stringify(evaluation));
    await write('targets/fake/variants.json', JSON.stringify({ ...example('variants.json'), target: 'fake', goldenCommit: golden }));
    await write('targets/fake/variants/bug-001.patch', '--- a/x\n+++ b/x\n');
    await write('targets/fake/dev-bugs/dev-001.patch', '--- a/x\n+++ b/x\n');
    git(root, 'init', '--quiet');
    git(root, 'add', '.');
    git(root, 'commit', '--quiet', '-m', 'framework');
    const runsDir = path.join(root, 'runs');
    const runDir = await sourceRun(runsDir);
    await writeFile(path.join(runDir, 'run.json'), JSON.stringify({ ...manifest(), generationCommit: golden, executions: [{ execId: 'x-01', ref: 'golden', commit: golden, executeStatus: 'done', analyzeStatus: 'pending' }] }));

    const outDir = path.join(root, 'build', 'cloud');
    const options = { target: 'fake', runId: SOURCE_RUN, outDir, projectRoot: root, runsDir, targetsDir: path.join(root, 'targets'), checkInstall: false };
    const { build: b } = await createCloudContext(options);

    const app = execFileSync('find', ['.', '-type', 'f'], { cwd: path.join(outDir, 'app'), encoding: 'utf8' }).split('\n').filter(Boolean).sort();
    expect(app).toEqual(['./.gitignore', './package.json', './src/cli.ts', './src/eval/cloud/template/x.txt', './targets/fake/target.config.json', './targets/fake/variants/bug-001.patch']);
    const appConfig = JSON.parse(await readFile(path.join(outDir, 'app', 'targets', 'fake', 'target.config.json'), 'utf8'));
    expect(appConfig.backend.env.MONGO_URI).toBe('mongodb://127.0.0.1:27017/mern_ecommerce_test');
    expect(b).toMatchObject({ goldenCommit: golden, suiteHash: await suiteHash(runDir), sourceRunId: SOURCE_RUN });
    expect(b.versions.map((v) => v.version)).toEqual(['golden', 'bug-001', 'env-01']);
    expect(b.versions[2]!.configOverride).toEqual({ backend: { env: { MONGO_URI: 'mongodb://127.0.0.1:27999/mern_ecommerce_test' } } });
    expect(JSON.parse(await readFile(path.join(outDir, 'image', 'run', 'run.json'), 'utf8')).executions).toEqual([]);
    expect(await readdir(path.join(outDir, 'image', 'run'))).toEqual(expect.arrayContaining(['run.json', 'testcases.json', 'scripts']));
    const dockerfile = await readFile(path.join(outDir, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain(`FROM node:${process.versions.node}-bookworm-slim`);
    expect(dockerfile).toContain('RUN apt-get install -y db');
    expect(dockerfile).toContain('git clone --quiet --branch golden /tmp/target.bundle targets/fake/repo');
    expect(dockerfile).toContain("(cd targets/fake/repo/server && npm ci && sha256sum package-lock.json | cut -d' ' -f1 > node_modules/.lockfile-hash)");
    expect(dockerfile).toContain('git config --system --add safe.directory /app/targets/fake/repo');
    const smoke = dockerfile.slice(dockerfile.indexOf('USER node'));
    expect(smoke).toContain('git -C targets/fake/repo rev-parse --verify --quiet "golden^{commit}"');
    expect(smoke).toContain('node_modules/.bin/tsx src/cli.ts eval cloud-task --help');
    expect(smoke.indexOf('RUN git -C')).toBeLessThan(smoke.indexOf('ENTRYPOINT'));
    const entrypoint = await readFile(path.join(outDir, 'image', 'entrypoint.sh'), 'utf8');
    expect(entrypoint).toContain('if ! ( db --fork ); then');
    expect(entrypoint).toContain('node_modules/.bin/tsx src/cli.ts eval cloud-task --results "$RESULTS_DIR" --service-log /tmp/db.log &');
    expect(await stat(path.join(outDir, 'image', 'fallback-status.cjs'))).toBeTruthy();
    expect(execFileSync('git', ['bundle', 'list-heads', path.join(outDir, 'target.bundle')], { encoding: 'utf8' })).toContain(`${golden} refs/heads/golden`);

    // A development draw under dev-bugs/: only its patches are copied into the image, not the rest of dev-bugs/.
    await write('targets/fake/dev-bugs/trial-1/variants.json', JSON.stringify({ ...example('variants.json'), target: 'fake', goldenCommit: golden, variants: [{ ...example('variants.json').variants[0], patch: 'dev-bugs/trial-1/variants/bug-001.patch' }] }));
    await write('targets/fake/dev-bugs/trial-1/variants/bug-001.patch', '--- a/y\n+++ b/y\n');
    git(root, 'add', '.');
    git(root, 'commit', '--quiet', '-m', 'trial draw');
    const trial = await createCloudContext({ ...options, variantsFile: 'dev-bugs/trial-1/variants.json' });
    expect(trial.build.versions.map((v) => [v.version, v.patch ?? null])).toEqual([
      ['golden', null],
      ['bug-001', 'targets/fake/dev-bugs/trial-1/variants/bug-001.patch'],
    ]);
    const trialApp = execFileSync('find', ['.', '-path', '*dev-bugs*', '-type', 'f'], { cwd: path.join(outDir, 'app'), encoding: 'utf8' }).split('\n').filter(Boolean);
    expect(trialApp).toEqual(['./targets/fake/dev-bugs/trial-1/variants/bug-001.patch']);

    // Refused: uncommitted changes, and anything that looks like a key.
    await write('src/cli.ts', '// changed\n');
    await expect(createCloudContext(options)).rejects.toThrow(/Commit first/);
    await write('src/key.ts', "export const k = 'sk-or-v1-0123456789abcdef0123456789';\n");
    git(root, 'add', '.');
    git(root, 'commit', '--quiet', '-m', 'oops');
    await expect(createCloudContext(options)).rejects.toThrow(/would contain secrets; nothing was written. Files: app\/src\/key.ts/);
    expect(await stat(outDir).then(() => true, () => false)).toBe(false);
  });
});
