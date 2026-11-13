import { describe, expect, it } from 'vitest';
import { mapLimit } from './pool';

describe('mapLimit', () => {
  it('keeps order, caps concurrency and collects failures', async () => {
    let running = 0;
    let peak = 0;
    const r = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((res) => setTimeout(res, 10 + (n % 3) * 5));
      running--;
      if (n === 4) throw new Error('four');
      return n * 10;
    });
    expect(peak).toBe(3);
    expect(r.map((x) => (x.status === 'fulfilled' ? x.value : (x.reason as Error).message)))
      .toEqual([10, 20, 30, 'four', 50, 60, 70]);
  });

  it('handles an empty list', async () => {
    expect(await mapLimit([], 3, async () => 1)).toEqual([]);
  });
});
