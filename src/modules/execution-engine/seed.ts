import type { SeedResult, TargetConfig } from '../../shared/schemas.js';
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
