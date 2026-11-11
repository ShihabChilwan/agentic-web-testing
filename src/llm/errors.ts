/**
 * How a failed provider request is treated:
 * - rate_limit (429): retried with a longer backoff, or after the provider's Retry-After
 * - server (5xx), network: retried with backoff
 * - timeout: retried at most once
 * - client (other 4xx, malformed responses): not retried
 */
export type LLMErrorKind = 'rate_limit' | 'server' | 'network' | 'timeout' | 'client';

export class LLMRequestError extends Error {
  override name = 'LLMRequestError';
  /** Provider requests made for this call before giving up (set by the client). */
  attempts = 1;

  constructor(
    message: string,
    readonly kind: LLMErrorKind,
    readonly status?: number,
    /** How long the provider asked us to wait (its Retry-After header), when it said. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** A Retry-After header value (seconds, or an HTTP date) in milliseconds; undefined when absent or unreadable. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** Thrown before a call starts when the run has reached its token or cost cap. */
export class LLMBudgetExceededError extends Error {
  override name = 'LLMBudgetExceededError';
}

export function errorKindForStatus(status: number): LLMErrorKind {
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return 'client';
}

/** Replaces every occurrence of a secret (API key, header value) with [redacted]. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join('[redacted]');
  }
  return out;
}
