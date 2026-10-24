import { execFile } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
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
      // The signal stops Playwright (and its browser) when the stage is interrupted.
      { cwd: runDir, timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024, env: { ...process.env, FORCE_COLOR: '0' }, ...(signal ? { signal } : {}) },
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
  if (result.status !== 'passed') {
    const context = await findFile(outputDir, 'error-context.md');
    const snapshot = context ? pageSnapshotOf(await readFile(context, 'utf8')) : null;
    if (snapshot) out.pageSnapshot = snapshot;
    const dom = await findFile(outputDir, 'dom.html');
    if (dom) out.dom = trimDom(await readFile(dom, 'utf8'));
    const last = await findFile(outputDir, 'last-response.json');
    if (last) out.lastResponse = (await readFile(last, 'utf8')).slice(0, 4_000);
  }
  return out;
}
