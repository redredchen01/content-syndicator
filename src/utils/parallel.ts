import { logger } from './logger';

export type ParallelResult<R> =
  | { ok: true; value: R }
  | { ok: false; error: Error };

/**
 * Run tasks concurrently up to `concurrency` at a time.
 * Each result is captured individually — a single task failure never
 * aborts the remaining workers (no fail-fast behavior).
 */
export async function runParallel<T, R>(
  items: T[],
  task: (item: T) => Promise<R>,
  concurrency: number = 3,
): Promise<ParallelResult<R>[]> {
  const results: ParallelResult<R>[] = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index++;
      try {
        results[currentIndex] = { ok: true, value: await task(items[currentIndex]) };
      } catch (e: any) {
        logger.error(`Parallel task failed at index ${currentIndex}`, e);
        results[currentIndex] = { ok: false, error: e instanceof Error ? e : new Error(String(e)) };
      }
    }
  }

  const workers = Array(Math.min(concurrency, items.length)).fill(0).map(worker);
  await Promise.all(workers);
  return results;
}
