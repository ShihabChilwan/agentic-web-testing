import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RUNS_DIR, makeRunId, targetPaths } from '../../shared/paths.js';
import { SCHEMA_VERSION, TargetFacts } from '../../shared/schemas.js';
import type { FactRequest, TargetConfig } from '../../shared/schemas.js';
import { loadTargetConfig } from '../../shared/target-config.js';
import { startTarget } from './lifecycle.js';
import { fillPlaceholders } from './placeholders.js';
import { valueAtPath } from './seed.js';

const MAX_STRING_CHARS = 300;
const MAX_BODY_CHARS = 3_000;
const REQUEST_TIMEOUT_MS = 15_000;
const REDACTED = '[redacted]';

type Fact = TargetFacts['facts'][number];

/** The parts of a value named by dot paths; `name[]` maps over an array (e.g. "products[].name"). */
export function project(value: unknown, keep: string[]): unknown {
  const pick = (v: unknown, segments: string[]): unknown => {
    if (segments.length === 0) return v;
    const [head, ...rest] = segments as [string, ...string[]];
    const isArray = head.endsWith('[]');
    const key = isArray ? head.slice(0, -2) : head;
    if (v === null || typeof v !== 'object') return undefined;
    const child = key === '' ? v : (v as Record<string, unknown>)[key];
    if (child === undefined) return undefined;
    const inner = isArray ? (Array.isArray(child) ? child.map((c) => pick(c, rest)) : undefined) : pick(child, rest);
    if (inner === undefined) return undefined;
    return key === '' ? inner : { [key]: inner };
  };
  const merge = (a: unknown, b: unknown): unknown => {
    if (Array.isArray(a) && Array.isArray(b)) return a.map((x, i) => merge(x, b[i]));
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
      for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k], v) : v;
      return out;
    }
    return b ?? a;
  };
  return keep.map((p) => pick(value, p.split('.'))).reduce<unknown>((acc, part) => (part === undefined ? acc : merge(acc, part)), undefined);
}

/** Arrays cut to `maxItems`, strings to 300 characters, and the whole body to about 3,000 characters. */
export function trimBody(value: unknown, maxItems: number): { body: unknown; truncated: boolean } {
  let truncated = false;
  const trim = (v: unknown, limit: number): unknown => {
    if (typeof v === 'string') {
      if (v.length <= MAX_STRING_CHARS) return v;
      truncated = true;
      return `${v.slice(0, MAX_STRING_CHARS)}…`;
    }
    if (Array.isArray(v)) {
      if (v.length > limit) truncated = true;
      return v.slice(0, limit).map((x) => trim(x, limit));
    }
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trim(x, limit)]));
    return v;
  };
  for (let limit = maxItems; limit >= 1; limit--) {
    const body = trim(value, limit);
    if (JSON.stringify(body ?? null).length <= MAX_BODY_CHARS) return { body, truncated: truncated || limit < maxItems };
  }
  truncated = true;
  return { body: `${JSON.stringify(trim(value, 1)).slice(0, MAX_BODY_CHARS)}…`, truncated };
}

/** Replaces every occurrence of a secret (token, header value) anywhere in a value. */
export function redactValue(value: unknown, secrets: string[]): unknown {
  const active = secrets.filter((s) => s.length >= 8);
  const clean = (v: unknown): unknown => {
    if (typeof v === 'string') return active.reduce((t, s) => t.split(s).join(REDACTED), v);
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]));
    return v;
  };
  return clean(value);
}

async function send(
  baseUrl: string,
  method: string,
  urlPath: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(new URL(urlPath, baseUrl), {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) as unknown };
  } catch {
    return { status: res.status, body: text };
  }
}

/**
 * Runs the target's fact requests against a running app, in order. Logs in once per fixture user
 * (the login response is never stored), fills `{{facts.<name>.body.<path>}}` from earlier full
 * responses and `{{fixtures.<path>}}` from the fixtures, and returns trimmed facts with every token
 * redacted. Request headers are never kept.
 */
export async function observeFacts(config: TargetConfig, requests: FactRequest[] = config.facts ?? []): Promise<Fact[]> {
  const baseUrl = config.backend.baseUrl;
  const tokens = new Map<string, string>();
  const secrets: string[] = [];

  const headersFor = async (as: string | null): Promise<Record<string, string>> => {
    if (as === null) return {};
    const auth = config.auth;
    if (!auth) throw new Error(`Fact request logs in as ${as}, but the target config has no "auth" section`);
    let token = tokens.get(as);
    if (token === undefined) {
      const user = valueAtPath(config.fixtures, as);
      if (!user || typeof user !== 'object') throw new Error(`Fixture user ${as} does not exist`);
      let res: { status: number; body: unknown };
      try {
        res = await send(baseUrl, auth.login.method, auth.login.path, {}, fillPlaceholders(auth.login.body, { user }));
      } catch (err) {
        throw new Error(`Login as ${as}: no response (${err instanceof Error ? err.message : String(err)})`, { cause: err });
      }
      const found = valueAtPath(res.body, auth.tokenAt);
      if (res.status >= 400 || typeof found !== 'string' || found === '') {
        throw new Error(`Login as ${as} failed: status ${res.status}, no token at "${auth.tokenAt}"`);
      }
      token = found;
      tokens.set(as, token);
      secrets.push(token, `${auth.prefix}${token}`);
    }
    return { [auth.header]: `${auth.prefix}${token}` };
  };

  const seen: Record<string, { status: number; body: unknown }> = {};
  const facts: Fact[] = [];
  for (const request of requests) {
    const context = { facts: seen, fixtures: config.fixtures };
    const urlPath = fillPlaceholders(request.path, context, { encode: encodeURIComponent });
    const body = request.body === undefined ? undefined : fillPlaceholders(request.body, context);
    const headers = await headersFor(request.as);
    let res: { status: number; body: unknown };
    try {
      res = await send(baseUrl, request.method, urlPath, headers, body);
    } catch (err) {
      throw new Error(`Fact ${request.name}: no response (${err instanceof Error ? err.message : String(err)})`, { cause: err });
    }
    seen[request.name] = res;
    const kept = request.keep && res.body !== null && typeof res.body === 'object' ? project(res.body, request.keep) : res.body;
    const trimmed = trimBody(kept, request.maxItems);
    facts.push({
      name: request.name,
      request: { method: request.method, path: urlPath, as: request.as },
      status: res.status,
      body: redactValue(trimmed.body, secrets),
      truncated: trimmed.truncated,
    });
  }
  return facts;
}

/**
 * `npm run target:facts`: a clean start at the golden ref (reset, seed, fatal seed check), the fact
 * requests, then targets/<name>/facts.json. The app is always stopped afterwards.
 */
export async function recordFacts(
  name: string,
  { targetsDir, runsDir = RUNS_DIR, log = () => {} }: { targetsDir?: string; runsDir?: string; log?: (m: string) => void } = {},
): Promise<{ file: string; facts: TargetFacts }> {
  const { config, repoDir, targetDir } = await loadTargetConfig(name, targetsDir ? { targetsDir } : {});
  if (!config.facts || config.facts.length === 0) throw new Error(`${name}/target.config.json has no "facts" requests`);
  const logsDir = path.join(runsDir, `facts-${makeRunId(name)}`, 'server');
  const target = await startTarget(config, { ref: config.goldenRef, repoDir, targetDir, logsDir, log });
  try {
    const backend = target.healthChecks.find((c) => c.name === 'backend');
    if (!backend?.ok) throw new Error(`The backend did not become healthy; see ${logsDir}`);
    log(`Observing ${config.facts.length} requests`);
    const file = path.join(targetDir, 'facts.json');
    const facts = await writeFactsFile(file, config.name, target.commit, await observeFacts(config));
    return { file, facts };
  } finally {
    await target.stop();
  }
}

/** Validates and writes facts.json. Its content comes only from observeFacts, which never keeps tokens or headers. */
export async function writeFactsFile(file: string, target: string, goldenCommit: string, facts: Fact[]): Promise<TargetFacts> {
  const valid = TargetFacts.parse({
    schemaVersion: SCHEMA_VERSION,
    target,
    goldenCommit,
    observedAt: new Date().toISOString(),
    facts,
  });
  await writeFile(file, `${JSON.stringify(valid, null, 2)}\n`, 'utf8');
  return valid;
}

/** Reads targets/<name>/facts.json; null when there is none. */
export async function readFacts(name: string, targetsDir?: string): Promise<TargetFacts | null> {
  const file = path.join(targetPaths(name, targetsDir).dir, 'facts.json');
  try {
    return TargetFacts.parse(JSON.parse(await readFile(file, 'utf8')));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Invalid ${file}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}
