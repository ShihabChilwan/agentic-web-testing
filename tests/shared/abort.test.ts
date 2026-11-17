import { describe, expect, it } from 'vitest';
import { untilAborted } from '../../src/shared/abort.js';

describe('untilAborted', () => {
  it('returns the task result when no signal aborts', async () => {
    expect(await untilAborted(Promise.resolve(3))).toBe(3);
    expect(await untilAborted(Promise.resolve(4), new AbortController().signal)).toBe(4);
  });

  it('rejects with Interrupted as soon as the signal aborts, while the task is still running', async () => {
    const controller = new AbortController();
    const pending = untilAborted(new Promise<never>(() => {}), controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('Interrupted');
  });

  it('rejects at once for a signal that has already aborted, and leaves no unhandled rejection', async () => {
    const controller = new AbortController();
    controller.abort();
    const late = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('late')), 5));
    await expect(untilAborted(late, controller.signal)).rejects.toThrow('Interrupted');
    await new Promise((r) => setTimeout(r, 20));
  });
});
