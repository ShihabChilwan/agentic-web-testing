import { execFile, spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { copyFile, mkdir, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { RUNS_DIR, runPaths } from '../../shared/paths.js';
import { errorSummary, latestRunWith, readRunManifest, setExecution } from '../../shared/run-manifest.js';
import { ExecutionRequest, ExecutionResults, ScriptManifest, SCHEMA_VERSION, TestCases } from '../../shared/schemas.js';
import type { RunManifest, SkippedScript, TargetConfig, TestArtifacts, TestResult } from '../../shared/schemas.js';
import { loadTargetConfig } from '../../shared/target-config.js';
import { startControlServer } from './control-server.js';
import { childEnv } from './env.js';
import { TestIsolation, type TestRecord } from './isolation.js';
import { startTarget, type RunningTarget, type StartOptions } from './lifecycle.js';
import { readReport, sortResult, type PlaywrightReport, type ReportedTest } from './report.js';
import { buildSuite } from './suite.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const PLAYWRIGHT_CLI = require.resolve('@playwright/test/cli');

export interface ExecuteVersionOptions {
  /** The run folder: scripts, manifest and testcases.json are read; only executions/<execId>/ is written. */
  runDir: string;
  config: TargetConfig;
  repoDir: string;
  targetDir: string;
  request: ExecutionRequest;
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
 * target config, the request), files out (executions/<execId>/ only). Starts the app at the request's
 * ref with its own settings, runs every script that passed its dry run in one Playwright process with a
 * data restore before each test, sorts the results, keeps the evidence of failures, writes results.json
 * and always stops the app.
 */
export async function executeVersion(options: ExecuteVersionOptions): Promise<ExecuteVersionResult> {
  const request = ExecutionRequest.parse(options.request);
  const { config, signal } = options;
  const log = options.log ?? (() => {});
  const paths = runPaths(path.basename(options.runDir), path.dirname(options.runDir));
  const execDir = paths.executionDir(request.execId);
  const scriptsDir = request.scriptsDir ? path.join(paths.dir, request.scriptsDir) : paths.scriptsDir;
  const manifest = ScriptManifest.parse(JSON.parse(await readFile(path.join(scriptsDir, 'manifest.json'), 'utf8')));
  const { run, skipped } = selectScripts(manifest);
  if (run.length === 0) throw new Error(`No script in ${scriptsDir}/manifest.json passed its dry run: nothing to execute`);
  const valueIds = await lockedValueIds(paths.testCases);

  await mkdir(path.dirname(execDir), { recursive: true });
  await mkdir(execDir).catch((err: NodeJS.ErrnoException) => {
    throw err.code === 'EEXIST' ? new Error(`Execution folder ${execDir} already exists; use another --exec-id`, { cause: err }) : err;
  });
  await buildSuite(execDir, scriptsDir, run, config);
  log(`${run.length} scripts to run, ${skipped.length} skipped (their dry run did not pass)`);

  const startedAt = new Date();
  const logsDir = paths.serverLogsDir(request.execId);
  const backendLog = path.join(logsDir, 'backend.log');
  const startOptions: StartOptions = {
    ref: request.ref,
    repoDir: options.repoDir,
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
  /** True when the executed ref is the run's generation ref, where every executed script passed its dry run. */
  atGenerationRef: boolean;
}

/**
 * `agent execute` (SPEC §10): resolves the ref to a commit (a bad ref creates nothing), records the
 * execution in run.json as running, runs executeVersion, then records done or failed.
 */
export async function executeRun(options: ExecuteRunOptions = {}): Promise<ExecuteRunResult> {
  const runsDir = options.runsDir ?? RUNS_DIR;
  const runId = options.runId ?? (await latestRunWith(path.join('scripts', 'manifest.json'), runsDir));
  if (!runId) throw new Error(`No run with a scripts/manifest.json in ${runsDir}; run "agent scripts" first`);
  const paths = runPaths(runId, runsDir);
  const manifest = await readRunManifest(paths.runJson);
  const scriptsStatus = manifest.stages.scripts?.status;
  if (scriptsStatus !== 'done') throw new Error(`The scripts stage of ${runId} is ${scriptsStatus ?? 'missing'}, not done; finish "agent scripts" first`);
  const { config, repoDir, targetDir } = await loadTargetConfig(manifest.target, {
    ...(options.targetsDir ? { targetsDir: options.targetsDir } : {}),
    ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
  });
  const ref = options.ref ?? manifest.generationRef;
  let commit: string;
  try {
    commit = (await execFileAsync('git', ['-C', repoDir, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).stdout.trim();
  } catch {
    throw new Error(`Unknown ref "${ref}" in ${repoDir}`);
  }
  const execId = options.execId ?? (await nextExecId(paths.dir, manifest));
  if (manifest.executions.some((e) => e.execId === execId)) throw new Error(`Execution ${execId} is already in run.json; use another --exec-id`);

  await setExecution(paths.dir, { execId, ref, commit, executeStatus: 'running', analyzeStatus: 'pending' });
  try {
    const result = await executeVersion({
      runDir: paths.dir,
      config,
      repoDir,
      targetDir,
      request: { execId, ref },
      generationRef: manifest.generationRef,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.log ? { log: options.log } : {}),
      ...(options.startApp ? { startApp: options.startApp } : {}),
    });
    await setExecution(paths.dir, { execId, ref, commit: result.commit, executeStatus: 'done', analyzeStatus: 'pending' });
    return { ...result, runId, execId, atGenerationRef: ref === manifest.generationRef };
  } catch (err) {
    const error = options.signal?.aborted ? 'Interrupted' : errorSummary(err);
    await setExecution(paths.dir, { execId, ref, commit, executeStatus: 'failed', analyzeStatus: 'pending', error });
    throw err;
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
