import { describe, expect, it } from 'vitest';
import { LLMRequestError } from '../../src/llm/errors.js';
import type { LLMErrorKind } from '../../src/llm/errors.js';
import { withRetry } from '../../src/llm/retry.js';
import type { RetryOptions } from '../../src/llm/retry.js';

function options(delays: number[]): RetryOptions {
  return { maxAttempts: 4, maxTimeoutRetries: 1, baseDelayMs: 100, maxDelayMs: 250, sleep: async (ms) => void delays.push(ms) };
}

/** An attempt function that fails with the given kinds, then succeeds. */
function failing(kinds: LLMErrorKind[]) {
  let calls = 0;
  const fn = async () => {
    const kind = kinds[calls++];
    if (kind) throw new LLMRequestError(kind, kind);
    return 'ok';
  };
  return { fn, calls: () => calls };
}

describe('withRetry', () => {
  it.each(['rate_limit', 'server', 'network'] as const)('retries %s errors with exponential backoff, capped', async (kind) => {
    const delays: number[] = [];
    const attempt = failing([kind, kind, kind]);
    await expect(withRetry(attempt.fn, options(delays))).resolves.toBe('ok');
    expect(attempt.calls()).toBe(4);
    expect(delays).toEqual([100, 200, 250]);
  });

  it('gives up after 4 attempts in total', async () => {
    const attempt = failing(['server', 'server', 'server', 'server', 'server']);
    await expect(withRetry(attempt.fn, options([]))).rejects.toThrow('server');
    expect(attempt.calls()).toBe(4);
  });

  it('does not retry client errors', async () => {
    const attempt = failing(['client']);
    await expect(withRetry(attempt.fn, options([]))).rejects.toThrow('client');
    expect(attempt.calls()).toBe(1);
  });

  it('retries a timeout at most once', async () => {
    const twice = failing(['timeout', 'timeout']);
    await expect(withRetry(twice.fn, options([]))).rejects.toThrow('timeout');
    expect(twice.calls()).toBe(2);

    const once = failing(['timeout', 'server']);
    await expect(withRetry(once.fn, options([]))).resolves.toBe('ok');
    expect(once.calls()).toBe(3);
  });

  it('does not retry errors that are not request errors', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw new TypeError('bug');
    };
    await expect(withRetry(fn, options([]))).rejects.toThrow('bug');
    expect(calls).toBe(1);
  });
});
