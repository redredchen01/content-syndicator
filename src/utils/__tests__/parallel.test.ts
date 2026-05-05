import { describe, it, expect, vi } from 'vitest';
import { runParallel } from '../parallel';

vi.mock('../logger', () => ({ logger: { error: vi.fn() } }));

describe('runParallel', () => {
  it('returns ok:true for all successful tasks', async () => {
    const results = await runParallel([1, 2, 3], async (n) => n * 2);
    expect(results).toHaveLength(3);
    expect(results.every(r => r.ok)).toBe(true);
    const values = results.map(r => (r.ok ? r.value : null));
    expect(values).toEqual([2, 4, 6]);
  });

  it('does not fail-fast — one task throwing leaves others intact', async () => {
    const results = await runParallel(
      [1, 2, 3],
      async (n) => {
        if (n === 2) throw new Error('task 2 failed');
        return n * 10;
      },
      3,
    );

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ ok: true, value: 10 });
    expect(results[1]).toMatchObject({ ok: false, error: expect.any(Error) });
    expect(results[2]).toEqual({ ok: true, value: 30 });
  });

  it('returns all ok:false when every task throws', async () => {
    const results = await runParallel([1, 2, 3], async () => {
      throw new Error('always fails');
    });

    expect(results).toHaveLength(3);
    expect(results.every(r => !r.ok)).toBe(true);
  });

  it('runs correctly with concurrency=1 (serial)', async () => {
    const order: number[] = [];
    const results = await runParallel(
      [1, 2, 3],
      async (n) => { order.push(n); return n; },
      1,
    );

    expect(order).toEqual([1, 2, 3]);
    expect(results.map(r => (r.ok ? r.value : null))).toEqual([1, 2, 3]);
  });

  it('handles 7-item fan-out with 1 failure — 6 ok + 1 failed', async () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    const results = await runParallel(items, async (n) => {
      if (n === 4) throw new Error('timeout');
      return n;
    }, 3);

    expect(results).toHaveLength(7);
    expect(results.filter(r => r.ok)).toHaveLength(6);
    expect(results.filter(r => !r.ok)).toHaveLength(1);
  });
});
