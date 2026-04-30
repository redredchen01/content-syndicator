import { RETRY_CONFIG } from '../constants';
import { smartRetry } from './smartRetry';

/**
 * 通用重试工具函数（向后兼容）
 * @param fn 要重试的函数
 * @param maxAttempts 最大尝试次数
 * @param baseDelay 基础延迟（毫秒）
 * @param maxDelay 最大延迟（毫秒）
 * @returns 函数执行结果
 */
export async function retryOperation<T>(
  fn: () => Promise<T>,
  maxAttempts: number = RETRY_CONFIG.MAX_ATTEMPTS,
  baseDelay: number = RETRY_CONFIG.BASE_DELAY_MS,
  maxDelay: number = RETRY_CONFIG.MAX_DELAY_MS
): Promise<T> {
  // 使用智能重试，但参数保持兼容
  return smartRetry(fn, {
    maxAttemptsOverride: maxAttempts,
    onRetry: (error, attempt, delay) => {
      console.warn(`Attempt ${attempt} failed. Retrying in ${Math.round(delay)}ms...`);
    },
  });
}