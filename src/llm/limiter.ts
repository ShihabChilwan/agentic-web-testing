/** A counting semaphore: at most `size` tasks run at once; the rest wait in FIFO order. */
export class Limiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(readonly size: number) {
    if (!Number.isInteger(size) || size < 1) throw new Error(`Limiter size must be a positive integer, got ${size}`);
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.size) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      // Hand the slot straight to the next waiter, so `active` never drops and rises again.
      if (next) next();
      else this.active--;
    }
  }
}
