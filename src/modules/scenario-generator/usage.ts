import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { templateMatches } from '../../shared/route-paths.js';
import type { CoverageReport, Prd, RecordedResponse, TargetConfig } from '../../shared/schemas.js';
import { matchEndpoint } from '../test-case-generator/checks.js';
import type { ReadLines } from '../test-case-generator/context.js';

/** The role of a request sent without a login. */
export const VISITOR = 'visitor';
/** The role of a request sent as a user the test created itself (its role is not known). */
export const CREATED_USER = 'created user';

/** What the existing suite does with one PRD endpoint. */
export interface EndpointUsage {
  /** Roles the endpoint was called as (fixture roles, "visitor", "created user"). */
  roles: Set<string>;
  /** Query parameter names with the values sent. */
  query: Map<string, Set<string>>;
  /** Status codes recorded on the correct version. */
  statuses: Set<number>;
  tests: Set<string>;
}

/** What the existing suite does, worked out by code from its scripts and its recorded responses (no model). */
export interface SuiteUsage {
  /** By endpoint key "METHOD /path" (the PRD's path). */
  endpoints: Map<string, EndpointUsage>;
  /** By PRD page route: the roles it was opened as. */
  pages: Map<string, Set<string>>;
  /** Recorded executions read (their responses.jsonl). */
  recordings: number;
  scripts: number;
}

export const endpointKey = (e: Pick<Prd['apiEndpoints'][number], 'method' | 'path'>): string => `${e.method} ${e.path}`;

/** A fixture user's role from its path ("users.<name>" → its role); undefined when it is not a fixture user with a role. */
export function fixtureRole(fixtures: unknown, userPath: string): string | undefined {
  const value = userPath.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), fixtures);
  if (!value || typeof value !== 'object') return undefined;
  const role = (value as Record<string, unknown>).role;
  return typeof role === 'string' && role ? role : undefined;
}

/** One request a script sends, as read from its syntax tree. */
export interface ScriptCall {
  kind: 'api' | 'page';
  method: string;
  /** The path as written; `${…}` parts become ":x". May carry a query. */
  path: string;
  /** The roles it is sent as. */
  roles: string[];
}

const LOGIN_CALLS = new Set(['loginViaApi', 'loggedInPage', 'loginViaUi']);
const API_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'fetch']);

/** The text of a string or template literal, with each `${…}` as ":x"; null for anything else. */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => `:x${s.literal.text}`).join('');
  return null;
}

/**
 * The requests one script sends and as whom: `api.<method>(path, options)` and `page.goto(path)`. The roles come from
 * the script's logins (`loginViaApi`, `loggedInPage`, `loginViaUi` with `fixtures.users.<name>`, or a user it created):
 * an api call whose options carry `headers` is sent as the users the script logged in over the API, one without as a
 * visitor; a page is opened as the users logged in in the browser, else as a visitor. An approximation: a script that logs
 * in as two users has each of its calls counted for both.
 */
export function scriptCalls(source: string, fixtures: unknown): ScriptCall[] {
  const file = ts.createSourceFile('script.ts', source, ts.ScriptTarget.ES2022, true);
  const apiRoles = new Set<string>();
  const pageRoles = new Set<string>();
  const found: Array<{ kind: 'api' | 'page'; method: string; path: string; withHeaders: boolean }> = [];
  const roleOf = (arg: ts.Expression | undefined): string => {
    const text = arg?.getText(file) ?? '';
    const m = /^fixtures\.(users\.\w+)$/.exec(text.replace(/\s+/g, ''));
    return (m && fixtureRole(fixtures, m[1]!)) ?? CREATED_USER;
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && LOGIN_CALLS.has(callee.text)) {
        if (callee.text === 'loginViaApi') apiRoles.add(roleOf(node.arguments[0]));
        else pageRoles.add(roleOf(node.arguments[1]));
      }
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        const owner = callee.expression.text;
        const name = callee.name.text;
        const pathArg = node.arguments[0] ? literalText(node.arguments[0]) : null;
        if (owner === 'api' && API_METHODS.has(name) && pathArg !== null) {
          const options = node.arguments[1]?.getText(file) ?? '';
          const method = name === 'fetch' ? (/method\s*:\s*['"`](\w+)['"`]/.exec(options)?.[1] ?? 'GET').toUpperCase() : name.toUpperCase();
          found.push({ kind: 'api', method, path: pathArg, withHeaders: /\bheaders\b/.test(options) });
        }
        if (owner === 'page' && name === 'goto' && pathArg !== null) found.push({ kind: 'page', method: 'GET', path: pathArg, withHeaders: false });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found.map((c) => {
    if (c.kind === 'page') return { kind: c.kind, method: c.method, path: c.path, roles: pageRoles.size > 0 ? [...pageRoles] : [VISITOR] };
    return { kind: c.kind, method: c.method, path: c.path, roles: c.withHeaders && apiRoles.size > 0 ? [...apiRoles] : [VISITOR] };
  });
}

/** Query parameters of a path ("/x?a=1&b=2"), decoded. */
export function queryOf(p: string): Array<[string, string]> {
  const q = p.indexOf('?');
  if (q < 0) return [];
  return [...new URLSearchParams(p.slice(q + 1)).entries()];
}

function usageFor(usage: SuiteUsage, key: string): EndpointUsage {
  let u = usage.endpoints.get(key);
  if (!u) {
    u = { roles: new Set(), query: new Map(), statuses: new Set(), tests: new Set() };
    usage.endpoints.set(key, u);
  }
  return u;
}

function addQuery(u: EndpointUsage, p: string): void {
  for (const [name, value] of queryOf(p)) {
    if (!u.query.has(name)) u.query.set(name, new Set());
    u.query.get(name)!.add(value);
  }
}

export interface SuiteUsageInput {
  prd: Prd;
  config: Pick<TargetConfig, 'fixtures'>;
  /** The suite's scripts by test id. */
  scripts: Map<string, string>;
  /** Recorded responses of executions of the correct version (generation ref, nothing changed), one list per execution. */
  recordings: RecordedResponse[][];
}

/** What the suite does (SPEC §6.5): the scripts' requests and logins, and the query values and statuses recorded. */
export function suiteUsage(input: SuiteUsageInput): SuiteUsage {
  const usage: SuiteUsage = { endpoints: new Map(), pages: new Map(), recordings: input.recordings.length, scripts: input.scripts.size };
  const pageRoutes = input.prd.uiRoutes.map((r) => r.path);
  const rolesByTest = new Map<string, { api: Set<string>; page: Set<string> }>();
  for (const [testId, source] of input.scripts) {
    const roles = { api: new Set<string>(), page: new Set<string>() };
    rolesByTest.set(testId, roles);
    for (const call of scriptCalls(source, input.config.fixtures)) {
      const bare = call.path.split('?')[0]!;
      if (call.kind === 'page') {
        call.roles.forEach((r) => roles.page.add(r));
        for (const route of pageRoutes.filter((r) => templateMatches(r, bare))) {
          if (!usage.pages.has(route)) usage.pages.set(route, new Set());
          call.roles.forEach((r) => usage.pages.get(route)!.add(r));
        }
        continue;
      }
      call.roles.forEach((r) => roles.api.add(r));
      const endpoint = matchEndpoint(call.method, bare, input.prd.apiEndpoints);
      if (!endpoint) continue;
      const u = usageFor(usage, endpointKey(endpoint));
      call.roles.forEach((r) => u.roles.add(r));
      u.tests.add(testId);
      addQuery(u, call.path);
    }
  }
  // Recorded responses add what the scripts' text cannot show: computed query values, the page's own calls, statuses.
  for (const list of input.recordings) {
    for (const r of list) {
      const endpoint = matchEndpoint(r.method, r.path.split('?')[0]!, input.prd.apiEndpoints);
      if (!endpoint) continue;
      const u = usageFor(usage, endpointKey(endpoint));
      u.tests.add(r.testCaseId);
      u.statuses.add(r.status);
      addQuery(u, r.path);
      // The page's own calls carry the browser's login; the api object's calls got their roles from the script text.
      if (r.source === 'page') {
        const browser = rolesByTest.get(r.testCaseId)?.page;
        (browser && browser.size > 0 ? [...browser] : [VISITOR]).forEach((x) => u.roles.add(x));
      }
    }
  }
  return usage;
}

/** The scripts of a suite folder by test id (`<id>.spec.ts` files). */
export async function readScripts(scriptsDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const name of (await readdir(scriptsDir)).filter((n) => /^[A-Z]{2}-\d{3,}\.spec\.ts$/.test(n)).sort()) {
    out.set(name.replace(/\.spec\.ts$/, ''), await readFile(path.join(scriptsDir, name), 'utf8'));
  }
  return out;
}

/** A line that holds code worth running (not blank, not only brackets, not a comment). */
const isCodeLine = (line: string): boolean => {
  const t = line.trim();
  return t !== '' && !/^[{}()[\];,]+$/.test(t) && !/^(\/\/|\/\*|\*|\*\/)/.test(t);
};

/**
 * Lines in `range` of `file` that hold code and did not run in the suite's coverage measurement (§5.1). Only files the
 * measurement saw run at all count: a file with no line run (frontend code, a file never loaded) says nothing.
 */
export async function unrunLines(file: string, range: readonly [number, number], coverage: CoverageReport | null, read: ReadLines): Promise<number[]> {
  const ran = coverage?.files[file]?.lines;
  if (!ran) return [];
  const lines = await read(file);
  if (!lines) return [];
  const set = new Set(ran);
  const out: number[] = [];
  for (let n = range[0]; n <= Math.min(range[1], lines.length); n++) if (isCodeLine(lines[n - 1]!) && !set.has(n)) out.push(n);
  return out;
}

/** Consecutive numbers as ranges: [3,4,5,9] → "3-5, 9". */
export function asRanges(numbers: readonly number[]): string {
  const out: string[] = [];
  let start: number | undefined;
  let prev: number | undefined;
  for (const n of [...numbers].sort((a, b) => a - b)) {
    if (start !== undefined && prev !== undefined && n === prev + 1) {
      prev = n;
      continue;
    }
    if (start !== undefined) out.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = n;
    prev = n;
  }
  if (start !== undefined) out.push(start === prev ? `${start}` : `${start}-${prev}`);
  return out.join(', ');
}
