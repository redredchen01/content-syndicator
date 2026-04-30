import { RETRY_CONFIG } from '../constants';

/**
 * 计算指数退避延迟
 * @param attempt 当前尝试次数（从0开始）
 * @param baseDelay 基础延迟（毫秒）
 * @param maxDelay 最大延迟（毫秒）
 * @returns 延迟时间（毫秒）
 */
export function calculateExponentialBackoff(
  attempt: number, 
  baseDelay: number = RETRY_CONFIG.BASE_DELAY_MS, 
  maxDelay: number = RETRY_CONFIG.MAX_DELAY_MS
): number {
  // 指数退避: baseDelay * BackoffFactor^attempt
  const delay = baseDelay * Math.pow(RETRY_CONFIG.BACKOFF_FACTOR, attempt);
  // 添加抖动以防止雷鸣群问题
  const jitter = Math.random() * 0.2 * delay; // 增加抖动比例至20%
  return Math.min(delay + jitter, maxDelay);
}