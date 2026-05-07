import { AsyncLocalStorage } from 'async_hooks';

/**
 * Request-scoped context using Node.js built-in AsyncLocalStorage.
 * No external dependencies — replaces the original cls-hooked implementation.
 */

const storage = new AsyncLocalStorage<string>();

export function getContextId(): string | undefined {
  return storage.getStore();
}

export function runWithContext<T>(contextId: string, fn: () => Promise<T>): Promise<T> {
  return storage.run(contextId, fn);
}
