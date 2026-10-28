import type { SeedCheck, SeedCheckResult, SeedResult, TargetConfig } from '../../shared/schemas.js';
import { fillPlaceholders } from './placeholders.js';

type SeedRequest = TargetConfig['seed'][number];

/** Sends the seed requests one after another and records each status. Never throws for HTTP failures. */
export async function sendSeedRequests(
  baseUrl: string,
  requests: SeedRequest[],
  fixtures: TargetConfig['fixtures'],
  { requestTimeoutMs = 10_000 } = {},
): Promise<SeedResult[]> {
  const results: SeedResult[] = [];
  for (const request of requests) {
    // Placeholder errors are config mistakes, so they are thrown rather than recorded.
    const body = request.body === undefined ? undefined : JSON.stringify(fillPlaceholders(request.body, { fixtures }));
    const label = `${request.method} ${request.path}`;
    try {
      const res = await fetch(new URL(request.path, baseUrl), {
        method: request.method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      await res.body?.cancel();
      results.push({ request: label, status: res.status, ok: res.ok });
    } catch {
      results.push({ request: label, status: null, ok: false });
    }
  }
  return results;
}

/** The value at a dot path such as `items` or `data.items`; undefined when any step is missing. */
export function valueAtPath(value: unknown, dotPath: string): unknown {
  let current = value;
  for (const key of dotPath.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Sends the seed check request and says whether the seeded data is there. Never throws for HTTP failures. */
export async function runSeedCheck(
  baseUrl: string,
  check: SeedCheck,
  fixtures: TargetConfig['fixtures'],
  { requestTimeoutMs = 10_000 } = {},
): Promise<SeedCheckResult> {
  const body = check.body === undefined ? undefined : JSON.stringify(fillPlaceholders(check.body, { fixtures }));
  let res: Response;
  try {
    res = await fetch(new URL(check.path, baseUrl), {
      method: check.method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (err) {
    const why = err instanceof Error ? ((err.cause as Error | undefined)?.message ?? err.message) : String(err);
    return { ok: false, status: null, detail: `no response (${why})` };
  }
  const text = await res.text();
  const fail = (detail: string): SeedCheckResult => ({ ok: false, status: res.status, detail });
  if (res.status !== check.expect.status) {
    return fail(`expected status ${check.expect.status}, got ${res.status}: ${text.slice(0, 200)}`);
  }
  const { nonEmptyArrayAt } = check.expect;
  if (nonEmptyArrayAt !== undefined) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return fail(`expected a JSON response, got: ${text.slice(0, 200)}`);
    }
    const found = valueAtPath(json, nonEmptyArrayAt);
    if (!Array.isArray(found)) {
      return fail(`expected an array at "${nonEmptyArrayAt}", got ${found === undefined ? 'nothing' : typeof found}`);
    }
    if (found.length === 0) return fail(`expected a non-empty array at "${nonEmptyArrayAt}", got an empty one`);
  }
  return { ok: true, status: res.status, detail: 'ok' };
}
