import { chromium, type Request } from '@playwright/test';
import type { TargetConfig } from '../../shared/schemas.js';
import { checkFixtureLogins, type FixtureGuardResult } from './guard.js';
import { fillPlaceholders } from './placeholders.js';
import { runSeedCheck, valueAtPath } from './seed.js';

const PAGE_TIMEOUT_MS = 20_000;

export interface PageObservation {
  /** HTTP status of the page document, or the navigation error (e.g. "net::ERR_CONNECTION_REFUSED"). */
  document: number | string;
  /**
   * Every XHR/fetch request the page made: "GET http://host:port/path -> 200", "-> failed <error>", or
   * "-> pending" when it had no answer by the end of the page load; sorted, no duplicates.
   */
  requests: string[];
  consoleErrors: number;
}

export interface AppObservation {
  /** Status of the target's seed check request (null: no response; absent: the target has no seed check). */
  seedCheck?: { ok: boolean; status: number | null };
  logins: FixtureGuardResult;
  page: PageObservation;
}

/** Loads `url` in a fresh headless Chromium and records the document status and the page's API requests. */
export async function observePage(url: string): Promise<PageObservation> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const requests = new Set<string>();
    const pending: Promise<unknown>[] = [];
    const open = new Set<Request>();
    let consoleErrors = 0;
    const name = (r: { method(): string; url(): string }) => {
      const u = new URL(r.url());
      return `${r.method()} ${u.origin}${u.pathname}`;
    };
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors++;
    });
    const isApi = (r: Request) => r.resourceType() === 'xhr' || r.resourceType() === 'fetch';
    page.on('request', (r) => {
      if (isApi(r)) open.add(r);
    });
    page.on('requestfinished', (r) => {
      open.delete(r);
      if (!isApi(r)) return;
      pending.push(r.response().then((res) => requests.add(`${name(r)} -> ${res?.status() ?? 'no response'}`)));
    });
    page.on('requestfailed', (r) => {
      open.delete(r);
      if (isApi(r)) requests.add(`${name(r)} -> failed ${r.failure()?.errorText ?? ''}`.trim());
    });
    let document: number | string;
    try {
      const res = await page.goto(url, { timeout: PAGE_TIMEOUT_MS });
      document = res?.status() ?? 'no response';
      await page.waitForLoadState('networkidle', { timeout: PAGE_TIMEOUT_MS }).catch(() => {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      document = /net::\w+/.exec(message)?.[0] ?? message.split('\n')[0]!;
    }
    await Promise.allSettled(pending);
    for (const r of open) requests.add(`${name(r)} -> pending`);
    await page.close();
    return { document, requests: [...requests].sort(), consoleErrors };
  } finally {
    await browser.close();
  }
}

/** What a running app does for a user: seed check, fixture logins and a page load of the frontend (SPEC §11.3). */
export async function observeApp(config: TargetConfig): Promise<AppObservation> {
  const seedCheck = config.seedCheck ? await runSeedCheck(config.backend.baseUrl, config.seedCheck, config.fixtures) : undefined;
  return {
    ...(seedCheck && { seedCheck: { ok: seedCheck.ok, status: seedCheck.status } }),
    logins: await checkFixtureLogins(config),
    page: await observePage(config.frontend.baseUrl),
  };
}

/** A page's accessibility tree, capped like the failure snapshots of the fix loop. */
const SNAPSHOT_CHARS = 6_000;

/** The token a fixture user gets from the target's login request, or null when the login fails. */
async function fixtureToken(config: TargetConfig, user: unknown): Promise<string | null> {
  const auth = config.auth;
  if (!auth) return null;
  try {
    const res = await fetch(new URL(auth.login.path, config.backend.baseUrl), {
      method: auth.login.method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fillPlaceholders(auth.login.body, { user })),
      signal: AbortSignal.timeout(10_000),
    });
    const token = valueAtPath(await res.json().catch(() => null), auth.tokenAt);
    return res.ok && typeof token === 'string' && token !== '' ? token : null;
  } catch {
    return null;
  }
}

export interface PageSnapshot {
  /** The path the browser ended on (a redirect, e.g. to a login page, shows here). */
  finalPath: string;
  /** Playwright's ariaSnapshot of the body: roles, names, labels and texts, at most SNAPSHOT_CHARS characters. */
  aria: string;
}

/** What a model is shown of a snapshot: without link URLs, where ids and generated slugs live (unstable between resets). */
export function snapshotForModel(aria: string): string {
  return aria
    .split('\n')
    .filter((line) => !/^\s*- \/url:/.test(line))
    .join('\n');
}

/**
 * Opens pages of the running app in one headless Chromium and returns each page's accessibility tree (SPEC §5, §6.2),
 * null for a page that could not be opened. Each page gets a fresh browser context; with a fixture user (a dot path
 * such as "users.alice") it starts logged in the way the scripts' loggedInPage helper does it: the login request's
 * token put into the configured browser storage before the first load. Read-only: it changes no data.
 */
export async function pageSnapshots(config: TargetConfig, requests: ReadonlyArray<{ path: string; user?: string }>): Promise<Array<PageSnapshot | null>> {
  if (requests.length === 0) return [];
  const storage = config.auth?.storage;
  const tokens = new Map<string, string | null>();
  const browser = await chromium.launch();
  try {
    const out: Array<PageSnapshot | null> = [];
    for (const req of requests) {
      let token: string | null = null;
      if (req.user && storage) {
        if (!tokens.has(req.user)) tokens.set(req.user, await fixtureToken(config, valueAtPath(config.fixtures, req.user)));
        token = tokens.get(req.user) ?? null;
      }
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        if (token && storage) {
          const origin = new URL(config.frontend.baseUrl).origin;
          await page.addInitScript(
            ({ kind, key, value, at }) => {
              const g = globalThis as unknown as Record<string, { setItem(k: string, v: string): void }> & { location: { origin: string } };
              try {
                if (g.location.origin === at) g[kind]!.setItem(key, value);
              } catch {
                // Storage is not available on some documents (e.g. about:blank).
              }
            },
            { kind: storage.kind, key: storage.key, value: token, at: origin },
          );
        }
        const res = await page.goto(new URL(req.path, config.frontend.baseUrl).toString(), { timeout: PAGE_TIMEOUT_MS }).catch(() => null);
        if (!res) {
          out.push(null);
          continue;
        }
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
        const aria = await page.locator('body').ariaSnapshot({ timeout: 10_000 }).catch(() => null);
        out.push(
          aria === null
            ? null
            : {
                finalPath: new URL(page.url()).pathname,
                aria: aria.length > SNAPSHOT_CHARS ? `${aria.slice(0, SNAPSHOT_CHARS)}\n[… snapshot cut at ${SNAPSHOT_CHARS} characters]` : aria,
              },
        );
      } finally {
        await context.close();
      }
    }
    return out;
  } finally {
    await browser.close();
  }
}

/** One page's accessibility tree (see pageSnapshots). */
export async function pageSnapshot(config: TargetConfig, pagePath: string, userPath?: string): Promise<PageSnapshot | null> {
  return (await pageSnapshots(config, [{ path: pagePath, ...(userPath ? { user: userPath } : {}) }]))[0] ?? null;
}
