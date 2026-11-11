import { LLMRequestError } from './errors.js';

export interface RetryOptions {
  /** Total attempts, including the first. */
  maxAttempts: number;
  /** How many times a timeout may be retried. */
  maxTimeoutRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Total attempts while the provider answers 429 (default: maxAttempts). Rate limits often last longer than a server hiccup. */
  maxRateLimitAttempts?: number;
  /** Backoff for 429 (defaults: baseDelayMs and maxDelayMs); a Retry-After from the provider is used instead, capped at the maximum. */
  rateLimitBaseDelayMs?: number;
  rateLimitMaxDelayMs?: number;
  sleep: (ms: number) => Promise<void>;
  /** Told about every wait (e.g. to record it in the call log). */
  onWait?: (ms: number, err: LLMRequestError) => void;
}

export const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 4,
  maxTimeoutRetries: 1,
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
  // 429: up to 5 retries, 5, 10, 20, 40 and 60 s (about 2 min), or what the provider asks for.
  maxRateLimitAttempts: 6,
  rateLimitBaseDelayMs: 5_000,
  rateLimitMaxDelayMs: 60_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Runs `attempt` until it succeeds or fails with an error that may not be retried.
 * Retries server and network errors with exponential backoff (at most `maxAttempts` in total); rate
 * limits (429) with their own, longer backoff or the provider's Retry-After (at most
 * `maxRateLimitAttempts`); a timeout at most `maxTimeoutRetries` times. Anything else is thrown at once.
 */
export async function withRetry<T>(attempt: (n: number) => Promise<T>, options: RetryOptions = DEFAULT_RETRY): Promise<T> {
  let timeouts = 0;
  let rateLimits = 0;
  let others = 0;
  for (let n = 1; ; n++) {
    try {
      return await attempt(n);
    } catch (err) {
      if (!(err instanceof LLMRequestError) || err.kind === 'client') throw err;
      const rateLimited = err.kind === 'rate_limit';
      if (n >= (rateLimited ? (options.maxRateLimitAttempts ?? options.maxAttempts) : options.maxAttempts)) throw err;
      if (err.kind === 'timeout' && ++timeouts > options.maxTimeoutRetries) throw err;
      let wait: number;
      if (rateLimited) {
        const max = options.rateLimitMaxDelayMs ?? options.maxDelayMs;
        wait = Math.min(err.retryAfterMs ?? (options.rateLimitBaseDelayMs ?? options.baseDelayMs) * 2 ** rateLimits, max);
        rateLimits += 1;
      } else {
        wait = Math.min(options.baseDelayMs * 2 ** others, options.maxDelayMs);
        others += 1;
      }
      options.onWait?.(wait, err);
      await options.sleep(wait);
    }
  }
}
