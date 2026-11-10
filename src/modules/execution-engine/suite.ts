import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TargetConfig } from '../../shared/schemas.js';
import { uiBaseUrl } from '../../shared/target-ui.js';
import { targetFolder } from './login.js';

/** What the helpers read from `_target.json`: base URLs, fixtures, login settings and the target's folder, where a login command runs (SPEC §6.1). */
export function targetSettings(config: TargetConfig) {
  return { apiUrl: config.backend.baseUrl, uiUrl: uiBaseUrl(config), fixtures: config.fixtures, auth: config.auth, targetDir: targetFolder(config) };
}

/**
 * The suite's `_helpers.ts`: the run's own helpers (copied as `_helpers.base.ts`, so the run's scripts,
 * helpers and helpersHash stay untouched) plus an automatic fixture that asks the Execution Engine's
 * control endpoint to restore the data before every test (SPEC §7.2).
 */
const EXECUTION_HELPERS = `// Execution helpers: the run's helpers plus a data restore before every test, through the
// Execution Engine's control endpoint on 127.0.0.1. Generated for this execution.
import path from 'node:path';
import { test as base } from './_helpers.base.js';

export * from './_helpers.base.js';

const CONTROL_URL = process.env.AWT_CONTROL_URL;
const TIMEOUT_MS = Number(process.env.AWT_RESTORE_TIMEOUT_MS ?? '600000');

async function control(step: 'before' | 'after', body: Record<string, string>): Promise<void> {
  if (!CONTROL_URL) throw new Error('AWT_CONTROL_URL is not set: run this suite through the Execution Engine');
  const res = await fetch(\`\${CONTROL_URL}/\${step}\`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(\`Control endpoint /\${step} answered \${res.status}: \${await res.text()}\`);
}

const isolated = base.extend<{ _isolation: void }>({
  // Its own timeout: restore time counts neither against the test timeout nor in the test's duration.
  _isolation: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, testInfo) => {
      const testId = path.basename(testInfo.file).replace(/\\.spec\\.ts$/, '');
      await control('before', { testId });
      await use();
      await control('after', { testId, outputDir: testInfo.outputDir });
    },
    { auto: true, timeout: TIMEOUT_MS },
  ],
});
`;

/**
 * Response recording (SPEC §7.6), added to the execution helpers only when asked: every response a test
 * receives from the app through the api object, and every fetch/XHR response the browser page gets from
 * the backend, with its full body, written to the test's output folder as responses.json.
 */
const RECORDING_HELPERS = `
// Recording: every response the test receives from the app (responses.json) and the page's
// accessibility snapshot after each navigation and at the end of the test (pages.json).
import { readFileSync, writeFileSync } from 'node:fs';
import type { APIResponse, Frame, Page, Response } from '@playwright/test';

interface Recorded {
  seq: number;
  source: 'api' | 'page';
  method: string;
  url: string;
  status: number;
  contentType: string;
  body: string | null;
  binary?: boolean;
  error?: string;
}

interface PageShot {
  seq: number;
  kind: 'navigation' | 'end';
  url: string;
  snapshot: string | null;
  error?: string;
}

const settings = JSON.parse(readFileSync(new URL('./_target.json', import.meta.url), 'utf8')) as { apiUrl: string; uiUrl: string; apiPrefix?: string };
const BACKEND_ORIGIN = new URL(settings.apiUrl).origin;
const UI_ORIGIN = new URL(settings.uiUrl).origin;
const API_PREFIX = settings.apiPrefix ?? '/api';
const API_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'fetch']);
const BODY_WAIT_MS = 10_000;
const SNAPSHOT_WAIT_MS = 3_000;

const isText = (type: string) => type === '' || /json|text|xml|javascript|html|urlencoded/i.test(type);
const firstLine = (err: unknown) => String((err as Error)?.message ?? err).split('\\n')[0] ?? '';

function fill(entry: Recorded, body: Buffer): void {
  if (isText(entry.contentType)) entry.body = body.toString('utf8');
  else entry.binary = true;
}

function methodOf(prop: string, args: unknown[]): string {
  if (prop !== 'fetch') return prop.toUpperCase();
  const options = args[1] as { method?: string } | undefined;
  if (options?.method) return options.method.toUpperCase();
  const first = args[0] as { method?: () => string } | string;
  return typeof first === 'object' && first !== null && typeof first.method === 'function' ? first.method().toUpperCase() : 'GET';
}

async function snapshotOf(page: Page, entry: PageShot): Promise<void> {
  try {
    entry.snapshot = await page.locator('body').ariaSnapshot({ timeout: SNAPSHOT_WAIT_MS });
  } catch (err) {
    entry.error = firstLine(err);
  }
}

async function settle(tasks: Promise<unknown>[]): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([Promise.allSettled(tasks), new Promise((resolve) => { timer = setTimeout(resolve, BODY_WAIT_MS); })]);
  clearTimeout(timer);
}

/** A backend call of the page: fetch/XHR to the backend's origin, or to the page's own origin under the API prefix. */
function fromBackend(r: Response): boolean {
  const type = r.request().resourceType();
  if (type !== 'fetch' && type !== 'xhr') return false;
  try {
    const u = new URL(r.url());
    return u.origin === BACKEND_ORIGIN || (u.origin === UI_ORIGIN && u.pathname.startsWith(API_PREFIX));
  } catch {
    return false;
  }
}

export const test = isolated.extend<{ _responses: Recorded[] }>({
  // eslint-disable-next-line no-empty-pattern
  _responses: async ({}, use, testInfo) => {
    const list: Recorded[] = [];
    await use(list);
    if (RECORD_RESPONSES) writeFileSync(testInfo.outputPath('responses.json'), JSON.stringify(list));
  },
  api: async ({ api, _responses }, use) => {
    if (!RECORD_RESPONSES) return use(api);
    const wrapped = new Proxy(api, {
      get(obj, prop, receiver) {
        const value = Reflect.get(obj, prop, receiver) as unknown;
        if (typeof prop !== 'string' || !API_METHODS.has(prop) || typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          const res = (await (value as (...a: unknown[]) => Promise<APIResponse>).apply(obj, args)) as APIResponse;
          const entry: Recorded = {
            seq: _responses.length + 1, source: 'api', method: methodOf(prop, args), url: res.url(), status: res.status(),
            contentType: res.headers()['content-type'] ?? '', body: null,
          };
          _responses.push(entry);
          try {
            fill(entry, await res.body());
          } catch (err) {
            entry.error = firstLine(err);
          }
          return res;
        };
      },
    });
    await use(wrapped);
  },
  page: async ({ page, _responses }, use, testInfo) => {
    const pending: Promise<void>[] = [];
    const shots: PageShot[] = [];
    const shotTasks: Promise<void>[] = [];
    // After each main-frame navigation: wait for the page to load and the network to go quiet, then
    // take its accessibility snapshot (in the background; the test goes on meanwhile).
    const onNavigated = (frame: Frame) => {
      if (frame !== page.mainFrame() || frame.url().startsWith('about:')) return;
      const entry: PageShot = { seq: shots.length + 1, kind: 'navigation', url: frame.url(), snapshot: null };
      shots.push(entry);
      shotTasks.push(
        (async () => {
          await page.waitForLoadState('load', { timeout: SNAPSHOT_WAIT_MS }).catch(() => {});
          await page.waitForLoadState('networkidle', { timeout: SNAPSHOT_WAIT_MS }).catch(() => {});
          await snapshotOf(page, entry);
        })(),
      );
    };
    if (RECORD_PAGES) page.on('framenavigated', onNavigated);
    const onResponse = (r: Response) => {
      if (!RECORD_RESPONSES || !fromBackend(r)) return;
      const entry: Recorded = {
        seq: _responses.length + 1, source: 'page', method: r.request().method(), url: r.url(), status: r.status(),
        contentType: r.headers()['content-type'] ?? '', body: null,
      };
      _responses.push(entry);
      pending.push(r.body().then((b) => fill(entry, b), (err: unknown) => { entry.error = firstLine(err); }));
    };
    page.on('response', onResponse);
    await use(page);
    if (RECORD_PAGES) {
      page.off('framenavigated', onNavigated);
      await settle(shotTasks);
      const end: PageShot = { seq: shots.length + 1, kind: 'end', url: page.url(), snapshot: null };
      shots.push(end);
      await snapshotOf(page, end);
      writeFileSync(testInfo.outputPath('pages.json'), JSON.stringify(shots));
    }
    await settle(pending);
    page.off('response', onResponse);
  },
});
`;

/** The suite's `_helpers.ts` text: the restore before every test, plus response and page recording when asked. */
export function executionHelpers(record: { responses?: boolean; pages?: boolean } = {}): string {
  if (!record.responses && !record.pages) return `${EXECUTION_HELPERS}\nexport const test = isolated;\n`;
  const flags = `\nconst RECORD_RESPONSES = ${record.responses === true};\nconst RECORD_PAGES = ${record.pages === true};\n`;
  return `${EXECUTION_HELPERS}${RECORDING_HELPERS}${flags}`;
}

function playwrightConfig(uiUrl: string): string {
  return `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './suite',
  outputDir: './test-results',
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [['json', { outputFile: 'report.json' }], ['line']],
  use: { baseURL: ${JSON.stringify(uiUrl)}, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
`;
}

/**
 * Writes `<execDir>/suite/` (the scripts to run, the run's helpers as `_helpers.base.ts`, the execution
 * helpers and `_target.json` from the target config) and `<execDir>/playwright.config.ts`.
 */
export async function buildSuite(
  execDir: string,
  scriptsDir: string,
  testIds: readonly string[],
  config: TargetConfig,
  options: { recordResponses?: boolean; recordPages?: boolean } = {},
): Promise<string> {
  const suiteDir = path.join(execDir, 'suite');
  await mkdir(suiteDir, { recursive: true });
  for (const id of testIds) await copyFile(path.join(scriptsDir, `${id}.spec.ts`), path.join(suiteDir, `${id}.spec.ts`));
  await copyFile(path.join(scriptsDir, '_helpers.ts'), path.join(suiteDir, '_helpers.base.ts'));
  await writeFile(path.join(suiteDir, '_helpers.ts'), executionHelpers({ responses: options.recordResponses === true, pages: options.recordPages === true }), 'utf8');
  const recording = options.recordResponses || options.recordPages;
  const settings = { ...targetSettings(config), ...(recording ? { apiPrefix: config.backend.apiPrefix } : {}) };
  await writeFile(path.join(suiteDir, '_target.json'), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  await writeFile(path.join(execDir, 'playwright.config.ts'), playwrightConfig(uiBaseUrl(config)), 'utf8');
  return suiteDir;
}
