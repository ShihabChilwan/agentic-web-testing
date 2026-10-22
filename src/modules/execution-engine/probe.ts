import { chromium, type Request } from '@playwright/test';
import type { TargetConfig } from '../../shared/schemas.js';
import { checkFixtureLogins, type FixtureGuardResult } from './guard.js';
import { runSeedCheck } from './seed.js';

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
