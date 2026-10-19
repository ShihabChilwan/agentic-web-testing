import { describe, expect, it } from 'vitest';
import { Limiter } from '../../src/llm/limiter.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe('Limiter', () => {
  it('never runs more than `size` tasks at once', async () => {
    const limiter = new Limiter(3);
    let active = 0;
    let peak = 0;
    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      await tick();
      active--;
    };
    await Promise.all(Array.from({ length: 12 }, () => limiter.run(task)));
    expect(peak).toBe(3);
  });

  it('starts waiting tasks in order and frees the slot when a task throws', async () => {
    const limiter = new Limiter(1);
    const order: number[] = [];
    const failing = limiter.run(async () => {
      order.push(1);
      throw new Error('boom');
    });
    const second = limiter.run(async () => order.push(2));
    const third = limiter.run(async () => order.push(3));
    await expect(failing).rejects.toThrow('boom');
    await Promise.all([second, third]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('rejects a size below 1', () => {
    expect(() => new Limiter(0)).toThrow();
  });
});
