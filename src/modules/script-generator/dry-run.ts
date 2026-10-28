import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import type { TargetConfig } from '../../shared/schemas.js';
import { startControlServer } from '../execution-engine/control-server.js';
import { childEnv } from '../execution-engine/env.js';
import { runPlaywright } from '../execution-engine/execute.js';
import { readReport, type PlaywrightReport } from '../execution-engine/report.js';
import { buildSuite } from '../execution-engine/suite.js';
import { stripAnsi } from './classify.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

/** Runs one task at a time, in the order they arrive (dry runs share one running app). */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** The installed @playwright/test version, recorded in run.json. */
export function playwrightVersion(): string {
  return (require('@playwright/test/package.json') as { version: string }).version;
}

const PLAYWRIGHT_CLI = require.resolve('@playwright/test/cli');

/** The run's playwright.config.ts: one worker, no retries, 30 s per test, Chromium (SPEC §7.1). */
export async function writePlaywrightConfig(runDir: string, uiUrl: string): Promise<string> {
  const file = path.join(runDir, 'playwright.config.ts');
  await writeFile(
    file,
    `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './scripts',
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: { baseURL: ${JSON.stringify(uiUrl)}, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
`,
    'utf8',
  );
  return file;
}

export interface DryRunResult {
  status: string;
  message: string;
  durationMs: number;
  /** Trimmed page HTML at the failure (ui tests). */
  dom?: string;
  /** The page at the failure as an accessibility tree, from Playwright's error-context.md (ui tests). */
  pageSnapshot?: string;
  /** The last API response before the failure. */
  lastResponse?: string;
}

/**
 * The page snapshot YAML of a Playwright error-context.md (written on every failure since 1.53), without element refs
 * and cursor marks, at most `max` characters; null when the file has none (most API tests). Playwright 1.64.0 writes
 * it in two forms, both recorded in tests/fixtures/playwright-errors/: under a "# Page snapshot" heading (with refs),
 * or as a bare yaml block after the error details (no refs). The test source that follows is never part of it.
 */
export function pageSnapshotOf(markdown: string, max = 8_000): string | null {
  const beforeSource = markdown.split(/^# Test source\s*$/m)[0] ?? markdown;
  const block =
    /^# Page snapshot\s*\n+```yaml\n([\s\S]*?)\n```/m.exec(beforeSource)?.[1] ?? /^```yaml\n([\s\S]*?)\n```/m.exec(beforeSource)?.[1];
  if (!block) return null;
  const clean = block.replace(/ \[ref=e\d+\]/g, '').replace(/ \[cursor=pointer\]/g, '').trimEnd();
  return clean.length > max ? `${clean.slice(0, max)}\n[… snapshot cut at ${max} characters]` : clean;
}

/** Page HTML without scripts, styles and SVG drawings, whitespace collapsed, at most `max` characters. */
export function trimDom(html: string, max = 8_000): string {
  const text = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, '<svg/>')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max)}… [trimmed]` : text;
}

async function findFile(dir: string, name: string): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return full;
    if (e.isDirectory()) {
      const found = await findFile(full, name);
      if (found) return found;
    }
  }
  return undefined;
}

interface ReportSuite {
  specs?: Array<{ tests: Array<{ results: Array<{ status: string; duration: number; error?: { message?: string } }> }> }>;
  suites?: ReportSuite[];
}

/** Runs one spec file with Playwright (JSON reporter) and returns its status, error and failure context. */
export async function runSpec(
  runDir: string,
  specFile: string,
  outputDir: string,
  signal?: AbortSignal,
  timeoutMs = 120_000,
): Promise<DryRunResult> {
  const started = Date.now();
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      process.execPath,
      [PLAYWRIGHT_CLI, 'test', path.relative(runDir, specFile), '--config', 'playwright.config.ts', '--reporter=json', `--output=${outputDir}`],
      // The signal stops Playwright (and its browser) when the stage is interrupted. Scripts are model-written code:
      // they get PATH and HOME only, never the pipeline's environment (which holds the LLM key).
      { cwd: runDir, timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024, env: childEnv({ FORCE_COLOR: '0' }), ...(signal ? { signal } : {}) },
    ));
  } catch (err) {
    // A failing test makes Playwright exit 1; the report is still on stdout.
    stdout = (err as { stdout?: string }).stdout ?? '';
    if (!stdout) {
      return { status: 'error', message: `Playwright did not run: ${err instanceof Error ? err.message : String(err)}`, durationMs: Date.now() - started };
    }
  }
  let report: { suites?: ReportSuite[]; errors?: Array<{ message?: string }> };
  try {
    report = JSON.parse(stdout) as typeof report;
  } catch {
    return { status: 'error', message: `Unreadable Playwright report: ${stdout.slice(0, 500)}`, durationMs: Date.now() - started };
  }
  const walk = (s: ReportSuite): NonNullable<ReportSuite['specs']> => [...(s.specs ?? []), ...(s.suites ?? []).flatMap(walk)];
  const result = (report.suites ?? []).flatMap(walk)[0]?.tests[0]?.results[0];
  if (!result) {
    // No test ran: typically a load error in the file, reported at the top level.
    const message = stripAnsi(report.errors?.map((e) => e.message ?? '').join('\n') ?? 'No test was found in the file');
    return { status: 'error', message, durationMs: Date.now() - started };
  }
  const out: DryRunResult = { status: result.status, message: stripAnsi(result.error?.message ?? ''), durationMs: result.duration };
  if (result.status !== 'passed') await addFailureContext(out, outputDir);
  return out;
}

/** The failure's page snapshot, trimmed DOM and last API response, from the files the test left in its output folder. */
async function addFailureContext(out: DryRunResult, outputDir: string): Promise<void> {
  const context = await findFile(outputDir, 'error-context.md');
  const snapshot = context ? pageSnapshotOf(await readFile(context, 'utf8')) : null;
  if (snapshot) out.pageSnapshot = snapshot;
  const dom = await findFile(outputDir, 'dom.html');
  if (dom) out.dom = trimDom(await readFile(dom, 'utf8'));
  const last = await findFile(outputDir, 'last-response.json');
  if (last) out.lastResponse = (await readFile(last, 'utf8')).slice(0, 4_000);
}

/** One dry run waiting to be run: the test case id, its spec file in scripts/ and the folder for its results. */
export interface DryRunItem {
  testId: string;
  file: string;
  outputDir: string;
}

/**
 * Runs dry runs and calls `afterEach` after each one (the fixture check and the data restore), in item order;
 * returns their results in the same order.
 */
export type DryRunBatch = (items: DryRunItem[], afterEach: (item: DryRunItem) => Promise<void>, signal?: AbortSignal) => Promise<DryRunResult[]>;

/**
 * Spec files Playwright could not load: a file that throws at import stops the whole run (no test runs) and is
 * named only in the location or stack of a top-level error (recorded: tests/fixtures/playwright-json-report/).
 */
export function filesThatFailedToLoad(report: { errors?: Array<{ location?: { file?: string }; stack?: string }> }): Set<string> {
  const files = new Set<string>();
  for (const e of report.errors ?? []) {
    const named = [e.location?.file, ...[...(e.stack ?? '').matchAll(/([^\s/()]+\.spec\.ts)/g)].map((m) => m[1])];
    for (const f of named) if (f) files.add(path.basename(f));
  }
  return files;
}

/** At most this many dry runs share one Playwright process. */
export const DRY_RUN_BATCH = 8;
/** Time a batch may take per dry run (a test is stopped after 30 s; the rest is the restore). */
const BATCH_MS_PER_TEST = 120_000;

/** A batch runner that runs each item on its own with `runOne` (tests use it with a fake). */
export function oneByOne(runDir: string, runOne: (runDir: string, file: string, outputDir: string, signal?: AbortSignal) => Promise<DryRunResult>): DryRunBatch {
  return async (items, afterEach, signal) => {
    const results: DryRunResult[] = [];
    for (const item of items) {
      results.push(await runOne(runDir, item.file, item.outputDir, signal));
      await afterEach(item);
    }
    return results;
  };
}

/**
 * Runs a batch of dry runs in one Playwright process (SPEC §6.2): Playwright's start-up (~10 s on the mounted project
 * folder) is paid once per batch instead of once per dry run. The scripts run from a suite built like an execution's
 * (copies of the scripts, the run's helpers plus a fixture that calls the control endpoint after every test), so
 * `afterEach` (fixture check and data restore) runs between tests and each test starts from the clean seeded data.
 * Each test's output folder is moved to its own `outputDir`. A script the batch did not run (a file that failed to
 * load stops the whole run, a batch that timed out) runs again on its own.
 */
export function playwrightBatch(options: {
  runDir: string;
  scriptsDir: string;
  config: TargetConfig;
  /** Called with the test ids of each Playwright run (batch); a script that runs on its own is not one. */
  onRun?: (testIds: string[]) => void;
}): DryRunBatch {
  let batches = 0;
  const batch: DryRunBatch = async (items, afterEach, signal) => {
    const batchDir = path.join(options.runDir, 'dry-runs', `.batch-${++batches}`);
    await rm(batchDir, { recursive: true, force: true });
    await buildSuite(batchDir, options.scriptsDir, items.map((i) => i.testId), options.config);
    options.onRun?.(items.map((i) => i.testId));
    const byId = new Map(items.map((i) => [i.testId, i]));
    const started = new Set<string>();
    const finished = new Map<string, string>();
    const control = await startControlServer({
      before: async (testId) => void started.add(testId),
      after: async (testId, outputDir) => {
        finished.set(testId, outputDir);
        const item = byId.get(testId);
        if (item) await afterEach(item);
      },
    });
    try {
      const timeout = AbortSignal.timeout(items.length * BATCH_MS_PER_TEST);
      try {
        await runPlaywright(
          batchDir,
          childEnv({ FORCE_COLOR: '0', AWT_CONTROL_URL: control.url, AWT_RESTORE_TIMEOUT_MS: String(BATCH_MS_PER_TEST) }),
          signal ? AbortSignal.any([signal, timeout]) : timeout,
        );
      } catch (err) {
        if (signal?.aborted) throw err; // interrupted: the stage stops
        // timed out: what finished is kept, the rest runs on its own below
      }
      const report = await readFile(path.join(batchDir, 'report.json'), 'utf8').then((t) => JSON.parse(t) as PlaywrightReport, () => ({}) as PlaywrightReport);
      const { byFile } = readReport(report);
      const failedToLoad = filesThatFailedToLoad(report);
      const results: Array<DryRunResult | null> = [];
      for (const item of items) {
        const reported = byFile.get(`${item.testId}.spec.ts`);
        const outputDir = finished.get(item.testId);
        if (!reported || !outputDir || reported.status === 'skipped' || reported.status === 'interrupted') {
          // Started but never reached its restore: put the data back before anything else runs.
          if (started.has(item.testId) && !outputDir) await afterEach(item);
          results.push(null);
          continue;
        }
        // Same layout as a single run: <attempt folder>/<Playwright's folder for the test>/.
        await rm(item.outputDir, { recursive: true, force: true });
        await mkdir(item.outputDir, { recursive: true });
        await rename(outputDir, path.join(item.outputDir, path.basename(outputDir))).catch(() => undefined);
        const message = stripAnsi(reported.error?.message ?? reported.errors?.map((e) => e.message ?? '').join('\n') ?? '');
        const out: DryRunResult = { status: reported.status, message, durationMs: reported.duration };
        if (reported.status !== 'passed') await addFailureContext(out, item.outputDir);
        results.push(out);
      }
      // Scripts the batch did not run. A file that fails to load stops the whole run, and Playwright names it in its
      // top-level errors: those run on their own (which reports the load error as their result); the others run again
      // as a smaller batch, or on their own when nothing was learned.
      const missing = items.filter((_, i) => results[i] === null);
      const broken = missing.filter((i) => failedToLoad.has(`${i.testId}.spec.ts`));
      const rest = missing.filter((i) => !broken.includes(i));
      const again = rest.length > 0 && rest.length < items.length ? await batch(rest, afterEach, signal) : [];
      for (const [i, item] of items.entries()) {
        if (results[i] !== null) continue;
        const k = rest.indexOf(item);
        if (k >= 0 && again[k]) {
          results[i] = again[k]!;
          continue;
        }
        results[i] = await runSpec(options.runDir, item.file, item.outputDir, signal);
        await afterEach(item);
      }
      return results as DryRunResult[];
    } finally {
      await control.close();
      await rm(batchDir, { recursive: true, force: true });
    }
  };
  return batch;
}

/**
 * The dry-run queue (SPEC §6.2): dry runs share one running app, so they run one batch at a time, through the
 * stage's mutex (page snapshots use it too). Whatever is waiting when the previous batch ends forms the next batch,
 * up to DRY_RUN_BATCH; nothing waits for a batch to fill. Resolves each dry run with its result and the time it
 * waited for its batch to start.
 */
export class DryRunQueue {
  private waiting: Array<{ item: DryRunItem; queued: number; resolve: (r: { result: DryRunResult; waitedMs: number }) => void; reject: (e: unknown) => void }> = [];
  private busy = false;
  /** Sizes of the batches run so far. */
  readonly batches: number[] = [];

  constructor(
    private readonly mutex: Mutex,
    private readonly runBatch: (items: DryRunItem[]) => Promise<DryRunResult[]>,
    private readonly maxBatch = DRY_RUN_BATCH,
  ) {}

  run(item: DryRunItem): Promise<{ result: DryRunResult; waitedMs: number }> {
    return new Promise((resolve, reject) => {
      this.waiting.push({ item, queued: Date.now(), resolve, reject });
      this.next();
    });
  }

  private next(): void {
    if (this.busy || this.waiting.length === 0) return;
    this.busy = true;
    void this.mutex
      .run(async () => {
        const batch = this.waiting.splice(0, this.maxBatch);
        if (batch.length === 0) return;
        this.batches.push(batch.length);
        const start = Date.now();
        try {
          const results = await this.runBatch(batch.map((b) => b.item));
          batch.forEach((b, i) => b.resolve({ result: results[i]!, waitedMs: start - b.queued }));
        } catch (err) {
          for (const b of batch) b.reject(err);
        }
      })
      .finally(() => {
        this.busy = false;
        this.next();
      });
  }
}
