/**
 * Waits for `task`, but rejects with "Interrupted" as soon as `signal` aborts. Work still in flight
 * (e.g. model calls) is abandoned, not cancelled; the caller cleans up and the CLI exits.
 */
export async function untilAborted<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task;
  if (signal.aborted) {
    task.catch(() => {});
    throw new Error('Interrupted');
  }
  let onAbort: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('Interrupted'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  // The abandoned task may still reject later; that must not become an unhandled rejection.
  task.catch(() => {});
  try {
    return await Promise.race([task, interrupted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
