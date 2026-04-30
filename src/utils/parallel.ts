import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';
import { logger } from './logger';

const execPromise = util.promisify(exec);

// 并行处理执行器
export async function runParallel<T, R>(
  items: T[], 
  task: (item: T) => Promise<R>, 
  concurrency: number = 3
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index++;
      try {
        results[currentIndex] = await task(items[currentIndex]);
      } catch (e: any) {
        logger.error(`Parallel task failed at index ${currentIndex}`, e);
        throw e;
      }
    }
  }

  const workers = Array(Math.min(concurrency, items.length)).fill(0).map(worker);
  await Promise.all(workers);
  return results;
}
