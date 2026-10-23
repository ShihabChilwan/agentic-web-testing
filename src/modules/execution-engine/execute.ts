import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { copyFile, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { PROJECT_ROOT, RUNS_DIR, runPaths } from '../../shared/paths.js';
import { errorSummary, latestRunWith, readRunManifest, setExecution } from '../../shared/run-manifest.js';
import { ExecutionRequest, ExecutionResults, ScriptManifest, SCHEMA_VERSION, TestCases } from '../../shared/schemas.js';
import type { ConfigOverride, RunManifest, SkippedScript, TargetConfig, TestArtifacts, TestResult } from '../../shared/schemas.js';
import { loadTargetConfig } from '../../shared/target-config.js';
import { startControlServer } from './control-server.js';
import { childEnv } from './env.js';
import { TestIsolation, type TestRecord } from './isolation.js';
import { startTarget, type RunningTarget, type StartOptions } from './lifecycle.js';
import { readReport, sortResult, type PlaywrightReport, type ReportedTest } from './report.js';
import { buildSourceTree, resolveCommit, type SourceTree } from './source-tree.js';
import { buildSuite } from './suite.js';

const require = createRequire(import.meta.url);
const PLAYWRIGHT_CLI = require.resolve('@playwright/test/cli');

export interface ExecuteVersionOptions {
  /** The run folder: scripts, manifest and testcases.json are read; only executions/<execId>/ is written. */
  runDir: string;
  config: TargetConfig;
  /** The target repo: never changed; the version runs from a source tree built from it (SPEC §7.5). */
  repoDir: string;
  targetDir: string;
  request: ExecutionRequest;
  /** Resolves `request.patch` (default: the project root). */
  projectRoot?: string;
  /** A source tree the caller already built for this request (it then also removes it). */
  sourceTree?: SourceTree;
  /** The run's generation ref: a start there with no override is clean (a failed seed check is fatal). */
  generationRef: string;
  signal?: AbortSignal;
  log?: (message: string) => void;
  /** Replaces the app start (tests). */
  startApp?: (options: StartOptions) => Promise<RunningTarget>;
}

export interface ExecuteVersionResult {
  results: ExecutionResults;
  resultsFile: string;
  /** The commit that was executed. Recorded in run.json, never in the execution folder (SPEC §8.4). */
  commit: string;
}

/** Scripts to run (dry run passed) and scripts left out, with their outcome, in manifest order. */
export function selectScripts(manifest: ScriptManifest): { run: string[]; skipped: SkippedScript[] } {
  const run: string[] = [];
  const skipped: SkippedScript[] = [];
  for (const entry of manifest.scripts) {
    if (entry.status === 'validated' && entry.validationOutcome === 'passed') run.push(entry.testCaseId);
    else skipped.push({ testCaseId: entry.testCaseId, reason: entry.status === 'validated' ? 'assertion_failed' : 'invalid' });
  }
  return { run, skipped };
}

/** Per test case, the expectation ids with a locked value (they decide the classifier's label). */
async function lockedValueIds(file: string): Promise<Map<string, Set<string>>> {
  const raw = await readFile(file, 'utf8').catch(() => null);
  if (raw === null) return new Map(); // the one-prompt ablation has no test cases
  const { testCases } = TestCases.parse(JSON.parse(raw));
  return new Map(testCases.map((tc) => [tc.id, new Set(tc.expected.filter((e) => e.value !== undefined).map((e) => e.id))]));
}

/** Runs Playwright once on the suite; output goes to playwright.log. Throws "Interrupted" when aborted. */
async function runPlaywright(execDir: string, env: Record<string, string>, signal?: AbortSignal): Promise<void> {
  const fd = openSync(path.join(execDir, 'playwright.log'), 'a');
  try {
    const child = spawn(process.execPath, [PLAYWRIGHT_CLI, 'test', '--config', 'playwright.config.ts'], {
      cwd: execDir,
      env,
      stdio: ['ignore', fd, fd],
      ...(signal ? { signal } : {}),
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', (err) => reject(signal?.aborted ? new Error('Interrupted') : err));
      child.once('exit', () => (signal?.aborted ? reject(new Error('Interrupted')) : resolve())); // exit 1 = some test failed
    });
  } finally {
    closeSync(fd);
  }
}

/** The source tree for a request: `ref` plus the optional patch, with the services' node_modules linked. */
export async function sourceTreeFor(config: TargetConfig, repoDir: string, request: Pick<ExecutionRequest, 'ref' | 'patch'>, projectRoot = PROJECT_ROOT) {
  const commit = await resolveCommit(repoDir, request.ref);
  const tree = await buildSourceTree({
    repoDir,
    commit,
    ...(request.patch ? { patchFile: path.resolve(projectRoot, request.patch) } : {}),
    linkNodeModules: [...new Set([config.backend.cwd, config.frontend.cwd])],
  });
  return { commit, tree };
}

/** Bytes [start, end) of a file. */
async function readSlice(file: string, start: number, end: number): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.max(0, end - start));
    await handle.read(buffer, 0, buffer.length, start);
    return buffer;
  } finally {
    await handle.close();
  }
}

/** Moves a non-passed test's evidence into artifacts/<TC>/ and returns the paths relative to the execution folder. */
async function collectArtifacts(
  execDir: string,
  testId: string,
  reported: ReportedTest | undefined,
  record: TestRecord | undefined,
  backendLog: string,
): Promise<TestArtifacts> {
  const relDir = path.posix.join('artifacts', testId);
  const dest = path.join(execDir, relDir);
  await mkdir(dest, { recursive: true });
  const artifacts: TestArtifacts = {};
  const keep = async (from: string | undefined, name: string, key: keyof TestArtifacts) => {
    if (!from) return;
    const ok = await copyFile(from, path.join(dest, name)).then(() => true, () => false);
    if (ok) artifacts[key] = path.posix.join(relDir, name);
  };
  const attachment = (name: string) => reported?.attachments?.find((a) => a.name === name && a.path)?.path;
  await keep(attachment('screenshot'), 'screenshot.png', 'screenshot');
  await keep(attachment('trace'), 'trace.zip', 'trace');
  // Files the helpers write into the test's output folder (SPEC §6.1).
  const outputDir = record?.outputDir ?? (attachment('screenshot') ?? attachment('trace'))?.replace(/[/\\][^/\\]*$/, '');
  if (outputDir) {
    await keep(path.join(outputDir, 'dom.html'), 'dom.html', 'dom');
    await keep(path.join(outputDir, 'network.json'), 'network.json', 'network');
    await keep(path.join(outputDir, 'console.log'), 'console.log', 'console');
    await keep(path.join(outputDir, 'last-response.json'), 'last-response.json', 'lastResponse');
  }
  if (record) {
    const end = record.logEnd ?? (await readFile(backendLog).then((b) => b.length, () => 0));
    if (end > record.logStart) {
      await writeFile(path.join(dest, 'backend.log'), await readSlice(backendLog, record.logStart, end));
      artifacts.serverLog = path.posix.join(relDir, 'backend.log');
    }
  }
  return artifacts;
}

/**
 * Module 4 (SPEC §7): executes one version. Files in (the run's scripts, manifest and test cases, the
 * target config, the request), files out (executions/<execId>/ only). Builds the version's source tree
 * (ref plus optional patch; the target repo never changes), starts the app from it with the request's
 * own settings, runs every script that passed its dry run in one Playwright process with a data restore
 * before each test, sorts the results, keeps the evidence of failures, writes results.json, and always
 * stops the app and removes the tree.
 */
export async function executeVersion(options: ExecuteVersionOptions): Promise<ExecuteVersionResult> {
  const request = ExecutionRequest.parse(options.request);
  const paths = runPaths(path.basename(options.runDir), path.dirname(options.runDir));
  const scriptsDir = request.scriptsDir ? path.join(paths.dir, request.scriptsDir) : paths.scriptsDir;
  const manifest = ScriptManifest.parse(JSON.parse(await readFile(path.join(scriptsDir, 'manifest.json'), 'utf8')));
  const scripts = selectScripts(manifest);
  if (scripts.run.length === 0) throw new Error(`No script in ${scriptsDir}/manifest.json passed its dry run: nothing to execute`);
  const execDir = paths.executionDir(request.execId);
  await mkdir(path.dirname(execDir), { recursive: true });
  if (await stat(execDir).then(() => true, () => false)) throw new Error(`Execution folder ${execDir} already exists; use another --exec-id`);

  // Every version runs from a source tree, golden included: the repo never changes and logs look alike.
  const { commit, tree } = options.sourceTree
    ? { commit: await resolveCommit(options.repoDir, request.ref), tree: options.sourceTree }
    : await sourceTreeFor(options.config, options.repoDir, request, options.projectRoot);
  try {
    await mkdir(execDir);
    await buildSuite(execDir, scriptsDir, scripts.run, options.config);
    return await runSuite(options, request, { execDir, paths, scripts, tree, commit });
  } finally {
    await tree.remove();
  }
}

interface SuiteContext {
  execDir: string;
  paths: ReturnType<typeof runPaths>;
  scripts: ReturnType<typeof selectScripts>;
  tree: SourceTree;
  commit: string;
}

/** Starts the app from the tree, runs the suite with a restore before each test, and writes results.json. */
async function runSuite(options: ExecuteVersionOptions, request: ExecutionRequest, ctx: SuiteContext): Promise<ExecuteVersionResult> {
  const { config, signal } = options;
  const { execDir, paths, scripts } = ctx;
  const { run, skipped } = scripts;
  const log = options.log ?? (() => {});
  log(`${run.length} scripts to run, ${skipped.length} skipped (their dry run did not pass)`);
  const valueIds = await lockedValueIds(paths.testCases);

  const startedAt = new Date();
  const logsDir = paths.serverLogsDir(request.execId);
  const backendLog = path.join(logsDir, 'backend.log');
  const startOptions: StartOptions = {
    ref: request.ref,
    repoDir: ctx.tree.dir,
    prepared: { commit: ctx.commit, patched: request.patch !== undefined },
    targetDir: options.targetDir,
    logsDir,
    generationRef: options.generationRef,
    ...(request.configOverride ? { configOverride: request.configOverride } : {}),
    ...(request.skipSeed ? { skipSeed: true } : {}),
    ...(signal ? { signal } : {}),
    log,
  };
  const target = await (options.startApp ?? ((o: StartOptions) => startTarget(config, o)))(startOptions);
  const startupMs = Date.now() - startedAt.getTime();
  let control: Awaited<ReturnType<typeof startControlServer>> | undefined;
  try {
    const isolation = new TestIsolation(target, { backendLog, frontendHealthUrl: config.frontend.healthCheckUrl, log });
    let n = 0;
    control = await startControlServer({
      before: async (testId) => {
        log(`[${++n}/${run.length}] ${testId}`);
        await isolation.before(testId);
      },
      after: (testId, outputDir) => isolation.after(testId, outputDir),
    });
    const startupTimeoutMs = request.configOverride?.lifecycle?.startupTimeoutMs ?? config.lifecycle.startupTimeoutMs;
    const suiteStarted = Date.now();
    // Scripts are model-written code: they get PATH and HOME only, plus the control endpoint.
    await runPlaywright(
      execDir,
      childEnv({ FORCE_COLOR: '0', AWT_CONTROL_URL: control.url, AWT_RESTORE_TIMEOUT_MS: String(2 * startupTimeoutMs + 60_000) }),
      signal,
    );
    const suiteMs = Date.now() - suiteStarted;
    isolation.finish();
    if (isolation.givenUp) log('Warning: restores were given up; later results ran without a data restore (isolated: false)');

    const reportFile = path.join(execDir, 'report.json');
    const report = await readFile(reportFile, 'utf8').then((t) => JSON.parse(t) as PlaywrightReport, () => null);
    const { byFile, errors } = report ? readReport(report) : { byFile: new Map<string, ReportedTest>(), errors: ['Playwright wrote no report; see playwright.log'] };
    const results: TestResult[] = [];
    for (const id of run) {
      const reported = byFile.get(`${id}.spec.ts`);
      const record = isolation.records.get(id);
      const sorted = sortResult(reported, valueIds.get(id) ?? new Set(), errors);
      const artifacts = sorted.status === 'passed' ? {} : await collectArtifacts(execDir, id, reported, record, backendLog);
      results.push({ testCaseId: id, ...sorted, isolated: record?.isolated ?? false, artifacts });
    }
    await rm(path.join(execDir, 'test-results'), { recursive: true, force: true });

    const count = (status: TestResult['status']) => results.filter((r) => r.status === status).length;
    const output = ExecutionResults.parse({
      schemaVersion: SCHEMA_VERSION,
      execId: request.execId,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      environment: { healthChecks: target.healthChecks, seed: target.seed, ...(target.seedCheck ? { seedCheck: target.seedCheck } : {}) },
      summary: {
        total: results.length,
        passed: count('passed'),
        failed: count('failed'),
        errored: count('errored'),
        skipped: skipped.length,
        notIsolated: results.filter((r) => !r.isolated).length,
      },
      skipped,
      incidents: isolation.incidents,
      timing: { startupMs, suiteMs, restores: isolation.restores, restoreMs: isolation.restoreMs },
      results,
    });
    const resultsFile = paths.results(request.execId);
    await writeFile(resultsFile, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    return { results: output, resultsFile, commit: target.commit };
  } finally {
    await control?.close();
    await target.stop();
  }
}

/** The next opaque id: x-01, x-02, … not used in executions/ or run.json (SPEC §7). */
export async function nextExecId(runDir: string, manifest: RunManifest): Promise<string> {
  const used = [...(await readdir(path.join(runDir, 'executions')).catch(() => [] as string[])), ...manifest.executions.map((e) => e.execId)];
  const numbers = used.map((id) => /^x-(\d+)$/.exec(id)?.[1]).filter((n): n is string => n !== undefined).map(Number);
  return `x-${String(Math.max(0, ...numbers) + 1).padStart(2, '0')}`;
}

export interface ExecuteRunOptions {
  /** Default: the newest run with a scripts/manifest.json. */
  runId?: string;
  /** Default: the run's generation ref. */
  ref?: string;
  /** A unified diff applied on top of the ref for this execution only (any path; recorded relative to the project root). */
  patch?: string;
  skipSeed?: boolean;
  /** Values merged over the target config for this execution (environment variants, SPEC §11.3). */
  configOverride?: ConfigOverride;
  /** Default: the next x-NN. */
  execId?: string;
  runsDir?: string;
  targetsDir?: string;
  projectRoot?: string;
  signal?: AbortSignal;
  log?: (message: string) => void;
  startApp?: ExecuteVersionOptions['startApp'];
}

export interface ExecuteRunResult extends ExecuteVersionResult {
  runId: string;
  execId: string;
  /** True when the executed version is the run's generation ref with nothing changed, where every executed script passed its dry run. */
  atGenerationRef: boolean;
}

/**
 * `agent execute` (SPEC §10): builds the version's source tree first (a bad ref or a patch that does not
 * apply creates nothing), records the execution in run.json as running, runs executeVersion, then
 * records done or failed.
 */
export async function executeRun(options: ExecuteRunOptions = {}): Promise<ExecuteRunResult> {
  const runsDir = options.runsDir ?? RUNS_DIR;
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const runId = options.runId ?? (await latestRunWith(path.join('scripts', 'manifest.json'), runsDir));
  if (!runId) throw new Error(`No run with a scripts/manifest.json in ${runsDir}; run "agent scripts" first`);
  const paths = runPaths(runId, runsDir);
  const manifest = await readRunManifest(paths.runJson);
  const scriptsStatus = manifest.stages.scripts?.status;
  if (scriptsStatus !== 'done') throw new Error(`The scripts stage of ${runId} is ${scriptsStatus ?? 'missing'}, not done; finish "agent scripts" first`);
  const { config, repoDir, targetDir } = await loadTargetConfig(manifest.target, {
    ...(options.targetsDir ? { targetsDir: options.targetsDir } : {}),
    projectRoot,
  });
  const ref = options.ref ?? manifest.generationRef;
  const patch = options.patch ? path.relative(projectRoot, path.resolve(options.patch)) : undefined;
  if (patch !== undefined && (patch.startsWith('..') || path.isAbsolute(patch))) throw new Error(`The patch must be inside the project: ${options.patch}`);
  const execId = options.execId ?? (await nextExecId(paths.dir, manifest));
  if (manifest.executions.some((e) => e.execId === execId)) throw new Error(`Execution ${execId} is already in run.json; use another --exec-id`);
  const override = options.configOverride ? { configOverride: options.configOverride } : {};
  const request: ExecutionRequest = { execId, ref, ...(patch ? { patch } : {}), ...(options.skipSeed ? { skipSeed: true } : {}), ...override };

  const { commit, tree } = await sourceTreeFor(config, repoDir, request, projectRoot);
  const entry = { execId, ref, commit, ...(patch ? { patch } : {}), ...(options.skipSeed ? { skipSeed: true } : {}), ...override, analyzeStatus: 'pending' as const };
  try {
    await setExecution(paths.dir, { ...entry, executeStatus: 'running' });
  } catch (err) {
    await tree.remove();
    throw err;
  }
  try {
    const result = await executeVersion({
      runDir: paths.dir,
      config,
      repoDir,
      targetDir,
      request,
      projectRoot,
      sourceTree: tree,
      generationRef: manifest.generationRef,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.log ? { log: options.log } : {}),
      ...(options.startApp ? { startApp: options.startApp } : {}),
    });
    await setExecution(paths.dir, { ...entry, executeStatus: 'done' });
    const atGenerationRef = ref === manifest.generationRef && !patch && !options.skipSeed && !options.configOverride;
    return { ...result, runId, execId, atGenerationRef };
  } catch (err) {
    const error = options.signal?.aborted ? 'Interrupted' : errorSummary(err);
    await setExecution(paths.dir, { ...entry, executeStatus: 'failed', error });
    throw err;
  } finally {
    await tree.remove(); // executeVersion removes it too; removing twice is harmless
  }
}

/** Lines for the CLI: counts, timing and warnings (not isolated; not all passed at the generation ref). */
export function describeExecution(result: ExecuteRunResult): string[] {
  const { summary, timing, incidents } = result.results;
  const s = (ms: number) => `${Math.round(ms / 1000)} s`;
  const lines = [
    `${summary.total} executed: ${summary.passed} passed, ${summary.failed} failed, ${summary.errored} errored; ${summary.skipped} skipped (dry run did not pass)`,
  ];
  if (timing) lines.push(`Start-up ${s(timing.startupMs)}, suite ${s(timing.suiteMs)}, ${timing.restores} restores ${s(timing.restoreMs)}`);
  if (incidents.length > 0) lines.push(`Incidents: ${incidents.map((i) => `${i.kind}${i.beforeTestCaseId ? ` (before ${i.beforeTestCaseId})` : ''}`).join(', ')}`);
  if (summary.notIsolated > 0) {
    lines.push(`Warning: ${summary.notIsolated} results ran without a data restore (isolated: false); they may depend on earlier tests and are not isolated results`);
  }
  const notPassed = summary.failed + summary.errored;
  if (result.atGenerationRef && notPassed > 0) {
    const ids = result.results.results.filter((r) => r.status !== 'passed').map((r) => r.testCaseId);
    lines.push(`Warning: at the generation ref every executed script passed its dry run, but ${notPassed} did not pass now (${ids.join(', ')}): flakiness or an isolation problem`);
  }
  return lines;
}
