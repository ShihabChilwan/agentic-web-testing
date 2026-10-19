import { setTimeout as sleep } from 'node:timers/promises';
import type { HealthCheckResult } from '../../shared/schemas.js';

export interface HealthCheckOptions {
  timeoutMs: number;
  intervalMs?: number;
  /** Limit for one request; a server that accepts the connection but never answers counts as not ready. */
  requestTimeoutMs?: number;
  /** Polling stops early (not ok) when this resolves, e.g. when the service process exits. */
  giveUp?: Promise<unknown>;
  signal?: AbortSignal;
}

/** One request: true for a 2xx or 3xx answer. Redirects are not followed. */
async function isReady(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel();
    return res.status >= 200 && res.status < 400;
  } catch {
    return false; // connection refused, reset or timed out
  }
}

/** Polls `url` until it answers 2xx/3xx or the timeout passes. Never throws: the result says what happened. */
export async function waitForHealthy(
  name: string,
  url: string,
  { timeoutMs, intervalMs = 1000, requestTimeoutMs = 5000, giveUp, signal }: HealthCheckOptions,
): Promise<HealthCheckResult> {
  const started = Date.now();
  let stopped = false;
  void giveUp?.then(
    () => (stopped = true),
    () => (stopped = true),
  );
  const result = (ok: boolean): HealthCheckResult => ({ name, url, ok, elapsedMs: Date.now() - started });

  while (!stopped && !signal?.aborted) {
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) break;
    if (await isReady(url, Math.min(requestTimeoutMs, remaining))) return result(true);
    const wait = Math.min(intervalMs, timeoutMs - (Date.now() - started));
    if (wait > 0) await sleep(wait);
  }
  return result(false);
}
