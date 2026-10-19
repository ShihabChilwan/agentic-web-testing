/**
 * How a failed provider request is treated:
 * - rate_limit (429), server (5xx), network: retried with backoff
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
  ) {
    super(message);
  }
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
