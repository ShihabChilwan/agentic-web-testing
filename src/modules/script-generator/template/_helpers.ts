// Test helpers for the generated scripts. Copied into each run's scripts/ folder next to _target.json,
// which holds the target's base URLs, fixtures and login settings for that run.
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test as base } from '@playwright/test';
import type { APIRequestContext, APIResponse, Locator as PwLocator, Page } from '@playwright/test';

interface LocatorSpec {
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  text?: string;
  testId?: string;
}

interface TargetFile {
  apiUrl: string;
  uiUrl: string;
  fixtures: Record<string, unknown>;
  auth?: {
    login: { method: string; path: string; body: unknown };
    tokenAt: string;
    header: string;
    prefix: string;
    storage?: { kind: 'localStorage' | 'sessionStorage'; key: string };
    uiLogin?: {
      path: string;
      fields: Record<string, LocatorSpec>;
      submit: LocatorSpec;
      waitFor?: { urlNot: string };
    };
  };
}

const target = JSON.parse(readFileSync(new URL('./_target.json', import.meta.url), 'utf8')) as TargetFile;

/** A fixture user: at least the fields the login uses (e.g. email and password). */
export type User = Record<string, unknown>;

/** The target's fixture data, e.g. `fixtures.users.alice.email`. Never write credentials as literals. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const fixtures = target.fixtures as Record<string, any>;

/** A unique value for data a test creates, e.g. `uniq('item')` → "item-lq3x8w-4fz1ab". */
export function uniq(prefix = 'test'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function fill(value: unknown, user: User): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*user\.([\w.]+)\s*\}\}/g, (_m, key: string) => String(user[key] ?? ''));
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, user));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, user)]));
  return value;
}

function atPath(value: unknown, dotPath: string): unknown {
  return dotPath.split('.').reduce<unknown>((v, key) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined), value);
}

function auth(): NonNullable<TargetFile['auth']> {
  if (!target.auth) throw new Error('This target has no login settings (target.config.json "auth")');
  return target.auth;
}

async function loginToken(user: User): Promise<string> {
  const a = auth();
  const res = await fetch(new URL(a.login.path, target.apiUrl), {
    method: a.login.method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(fill(a.login.body, user)),
  });
  const body: unknown = await res.json().catch(() => null);
  const token = atPath(body, a.tokenAt);
  if (!res.ok || typeof token !== 'string') throw new Error(`loginViaApi failed with status ${res.status}`);
  return token;
}

/**
 * Logs in over the API. Returns the finished headers to pass on api calls: `api.get(path, { headers })`.
 * The raw token is not handed out on purpose: building the header by hand gets the scheme wrong
 * (e.g. "Bearer Bearer …" when the app's token already includes it).
 */
export async function loginViaApi(user: User): Promise<{ headers: Record<string, string> }> {
  const a = auth();
  return { headers: { [a.header]: `${a.prefix}${await loginToken(user)}` } };
}

/** A locator from a LocatorSpec (role and name, label, placeholder, text or test id). */
export function locate(page: Page, spec: LocatorSpec): PwLocator {
  if (spec.role) return page.getByRole(spec.role as Parameters<Page['getByRole']>[0], spec.name ? { name: spec.name } : {});
  if (spec.label) return page.getByLabel(spec.label);
  if (spec.placeholder) return page.getByPlaceholder(spec.placeholder);
  if (spec.text) return page.getByText(spec.text);
  if (spec.testId) return page.getByTestId(spec.testId);
  throw new Error('Empty locator');
}

/** Logs in through the app's own login form. */
export async function loginViaUi(page: Page, user: User): Promise<void> {
  const form = auth().uiLogin;
  if (!form) throw new Error('This target has no login form settings (target.config.json "auth.uiLogin")');
  await page.goto(form.path);
  for (const [field, spec] of Object.entries(form.fields)) await locate(page, spec).fill(String(user[field] ?? ''));
  await locate(page, form.submit).click();
  if (form.waitFor) {
    const urlNot = form.waitFor.urlNot;
    await page.waitForURL((url) => !url.pathname.includes(urlNot));
  }
}

/**
 * Starts the page already logged in: logs in over the API and puts the token where the app keeps it,
 * before the first page load. Use it when the login itself is not what the test checks.
 * The token is set once per tab: an init script runs before every page load, so without the marker a
 * test that logs out and then reloads would be logged back in.
 */
export async function loggedInPage(page: Page, user: User): Promise<Page> {
  const storage = auth().storage;
  if (!storage) throw new Error('This target has no token storage settings (target.config.json "auth.storage")');
  const token = await loginToken(user);
  await page.addInitScript(
    // Runs in the browser before any page script, on every page load.
    ({ kind, key, value, origin, marker }) => {
      type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
      const g = globalThis as unknown as Record<string, Store> & { location: { origin: string } };
      try {
        if (g.location.origin !== origin || g.sessionStorage!.getItem(marker)) return;
        g[kind]!.setItem(key, value);
        g.sessionStorage!.setItem(marker, '1');
      } catch {
        // Storage is not available on some documents (e.g. about:blank).
      }
    },
    { kind: storage.kind, key: storage.key, value: token, origin: new URL(target.uiUrl).origin, marker: '__awt_logged_in' },
  );
  return page;
}

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'fetch']);

export const test = base.extend<{ api: APIRequestContext }>({
  // The backend API, with the last response kept so a failure can show it.
  api: async ({ playwright }, use, testInfo) => {
    const ctx = await playwright.request.newContext({ baseURL: target.apiUrl });
    let last: { method: string; url: string; status: number; body: string } | undefined;
    const recorded = new Proxy(ctx, {
      get(obj, prop, receiver) {
        const value = Reflect.get(obj, prop, receiver) as unknown;
        if (typeof prop !== 'string' || !METHODS.has(prop) || typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          const res = (await (value as (...a: unknown[]) => Promise<APIResponse>).apply(obj, args)) as APIResponse;
          const body = await res.text().catch(() => '');
          last = { method: prop.toUpperCase(), url: res.url(), status: res.status(), body: body.slice(0, 4000) };
          return res;
        };
      },
    });
    await use(recorded);
    if (testInfo.status !== testInfo.expectedStatus && last) {
      writeFileSync(testInfo.outputPath('last-response.json'), JSON.stringify(last, null, 2));
    }
    await ctx.dispose();
  },
  // The browser page, with console messages and network requests recorded, and the DOM saved on failure.
  page: async ({ page }, use, testInfo) => {
    const consoleLines: string[] = [];
    const network: Array<{ method: string; url: string; status?: number }> = [];
    page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
    page.on('response', (r) => network.push({ method: r.request().method(), url: r.url(), status: r.status() }));
    page.on('requestfailed', (r) => network.push({ method: r.method(), url: r.url() }));
    await use(page);
    writeFileSync(testInfo.outputPath('console.log'), consoleLines.join('\n'));
    writeFileSync(testInfo.outputPath('network.json'), JSON.stringify(network, null, 2));
    if (testInfo.status !== testInfo.expectedStatus) {
      writeFileSync(testInfo.outputPath('dom.html'), await page.content().catch(() => ''));
    }
  },
});

export { expect };
