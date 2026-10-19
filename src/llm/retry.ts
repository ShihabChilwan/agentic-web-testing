import { LLMRequestError } from './errors.js';

export interface RetryOptions {
  /** Total attempts, including the first. */
  maxAttempts: number;
  /** How many times a timeout may be retried. */
  maxTimeoutRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 4,
  maxTimeoutRetries: 1,
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Runs `attempt` until it succeeds or fails with an error that may not be retried.
 * Retries rate limits, server errors and network errors with exponential backoff;
 * a timeout is retried at most `maxTimeoutRetries` times. Anything else is thrown at once.
 */
export async function withRetry<T>(attempt: (n: number) => Promise<T>, options: RetryOptions = DEFAULT_RETRY): Promise<T> {
  let timeouts = 0;
  for (let n = 1; ; n++) {
    try {
      return await attempt(n);
    } catch (err) {
      if (!(err instanceof LLMRequestError) || n >= options.maxAttempts) throw err;
      if (err.kind === 'client') throw err;
      if (err.kind === 'timeout' && ++timeouts > options.maxTimeoutRetries) throw err;
      await options.sleep(Math.min(options.baseDelayMs * 2 ** (n - 1), options.maxDelayMs));
    }
  }
}
