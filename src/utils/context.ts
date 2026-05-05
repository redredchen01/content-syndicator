import { createNamespace } from 'cls-hooked';

/**
 * Context 管理：使用 cls-hooked 实现请求级别的上下文隔离
 * 允许在异步调用链中自动携带 contextId，无需显式传递
 */

const contextNamespace = createNamespace('syndicator-context');

export function createRequestContext(contextId: string): void {
  contextNamespace.set('contextId', contextId);
}

export function getContextId(): string | undefined {
  return contextNamespace.get('contextId');
}

export function runWithContext<T>(contextId: string, fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    contextNamespace.run(() => {
      createRequestContext(contextId);
      fn().then(resolve).catch(reject);
    });
  });
}
