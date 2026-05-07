import { logger } from './logger';
import { systemMonitor } from './systemMonitor';

// 错误类型分类
export enum ErrorType {
  NETWORK = 'NETWORK',           // 网络错误（超时、DNS、连接失败）
  RATE_LIMIT = 'RATE_LIMIT',     // API限流（429）
  AUTH = 'AUTH',               // 认证错误（401、403）
  NOT_FOUND = 'NOT_FOUND',     // 资源不存在（404）
  SERVER_ERROR = 'SERVER_ERROR', // 服务器错误（5xx）
  TIMEOUT = 'TIMEOUT',           // 超时
  UNKNOWN = 'UNKNOWN',         // 未知错误
}

interface RetryStrategy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  shouldRetry: (error: any, attempt: number) => boolean;
  calculateDelay: (attempt: number, baseDelay: number, maxDelay: number) => number;
}

// 错误分类器
export function classifyError(error: any): ErrorType {
  const message = (error?.message || '').toLowerCase();
  const code = error?.code || error?.status || error?.statusCode;
  const status = error?.response?.status || code;

  // 网络相关
  if (
    message.includes('timeout') ||
    message.includes('etimedout') ||
    message.includes('socket hang up')
  ) {
    return ErrorType.TIMEOUT;
  }

  if (
    message.includes('econnrefused') ||
    message.includes('ehostunreach') ||
    message.includes('enetunreach') ||
    message.includes('fetch failed')
  ) {
    return ErrorType.NETWORK;
  }

  // HTTP状态码
  if (status === 429 || message.includes('too many requests')) {
    return ErrorType.RATE_LIMIT;
  }

  if (status === 401 || status === 403 || message.includes('unauthorized') || message.includes('forbidden')) {
    return ErrorType.AUTH;
  }

  if (status === 404 || message.includes('not found')) {
    return ErrorType.NOT_FOUND;
  }

  if (status >= 500 && status < 600) {
    return ErrorType.SERVER_ERROR;
  }

  return ErrorType.UNKNOWN;
}

// 不同错误类型的重试策略
const strategies: Record<ErrorType, RetryStrategy> = {
  [ErrorType.NETWORK]: {
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 10000,
    shouldRetry: () => true,
    calculateDelay: (attempt, base, max) => {
      // 网络错误：指数退避，但不要太长
      return Math.min(base * Math.pow(1.5, attempt - 1) + Math.random() * 500, max);
    },
  },

  [ErrorType.RATE_LIMIT]: {
    maxAttempts: 5,
    baseDelayMs: 60000, // 限流：从60秒开始
    maxDelayMs: 300000, // 最多5分钟
    shouldRetry: (error, attempt) => attempt <= 5,
    calculateDelay: (attempt, base, max) => {
      // 限流：指数退避 + 随机抖动
      const delay = base * Math.pow(2, attempt - 1);
      return Math.min(delay + Math.random() * 10000, max);
    },
  },

  [ErrorType.AUTH]: {
    maxAttempts: 1, // 认证错误不重试
    baseDelayMs: 0,
    maxDelayMs: 0,
    shouldRetry: () => false,
    calculateDelay: () => 0,
  },

  [ErrorType.NOT_FOUND]: {
    maxAttempts: 1, // 404不重试
    baseDelayMs: 0,
    maxDelayMs: 0,
    shouldRetry: () => false,
    calculateDelay: () => 0,
  },

  [ErrorType.SERVER_ERROR]: {
    maxAttempts: 3,
    baseDelayMs: 2000,
    maxDelayMs: 30000,
    shouldRetry: () => true,
    calculateDelay: (attempt, base, max) => {
      // 服务器错误：指数退避
      return Math.min(base * Math.pow(2, attempt - 1) + Math.random() * 1000, max);
    },
  },

  [ErrorType.TIMEOUT]: {
    maxAttempts: 3,
    baseDelayMs: 2000,
    maxDelayMs: 15000,
    shouldRetry: () => true,
    calculateDelay: (attempt, base, max) => {
      // 超时：稍微增加延迟
      return Math.min(base * attempt + Math.random() * 1000, max);
    },
  },

  [ErrorType.UNKNOWN]: {
    maxAttempts: 2,
    baseDelayMs: 1000,
    maxDelayMs: 10000,
    shouldRetry: (error, attempt) => attempt <= 2,
    calculateDelay: (attempt, base, max) => {
      return Math.min(base * Math.pow(1.5, attempt - 1), max);
    },
  },
};

// 断路器状态
interface CircuitBreakerState {
  failures: number;
  lastFailureTime: number;
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
}

const circuitBreakers: Map<string, CircuitBreakerState> = new Map();
const CIRCUIT_BREAKER_THRESHOLD = 5; // 连续失败5次后打开
const CIRCUIT_BREAKER_TIMEOUT = 60000; // 1分钟后尝试恢复

function getCircuitBreaker(key: string): CircuitBreakerState {
  if (!circuitBreakers.has(key)) {
    circuitBreakers.set(key, {
      failures: 0,
      lastFailureTime: 0,
      state: 'CLOSED',
    });
  }
  return circuitBreakers.get(key)!;
}

function checkCircuitBreaker(key: string): boolean {
  const breaker = getCircuitBreaker(key);
  const now = Date.now();

  if (breaker.state === 'OPEN') {
    if (now - breaker.lastFailureTime > CIRCUIT_BREAKER_TIMEOUT) {
      breaker.state = 'HALF_OPEN';
      logger.warn(`Circuit breaker for ${key} is now HALF_OPEN`);
      return false; // 允许尝试
    }
    return true; // 仍然打开，拒绝请求
  }

  return false; // 关闭或半开，允许请求
}

function recordSuccess(key: string): void {
  const breaker = getCircuitBreaker(key);
  breaker.failures = 0;
  breaker.state = 'CLOSED';
}

function recordFailure(key: string): void {
  const breaker = getCircuitBreaker(key);
  breaker.failures++;
  breaker.lastFailureTime = Date.now();

  if (breaker.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    breaker.state = 'OPEN';
    logger.error(`Circuit breaker for ${key} is now OPEN (${breaker.failures} failures)`);
  }
}

// 智能重试主函数
export async function smartRetry<T>(
  fn: () => Promise<T>,
  options?: {
    context?: string; // 用于断路器标识
    maxAttemptsOverride?: number;
    onRetry?: (error: any, attempt: number, delay: number) => void;
  }
): Promise<T> {
  const context = options?.context || 'default';
  const startTime = Date.now();

  // 检查断路器
  if (checkCircuitBreaker(context)) {
    const breaker = getCircuitBreaker(context);
    const retryAfter = Math.ceil((CIRCUIT_BREAKER_TIMEOUT - (Date.now() - breaker.lastFailureTime)) / 1000);
    throw new Error(`Circuit breaker is OPEN for ${context}. Retry after ${retryAfter}s`);
  }

  let lastError: any;

  for (let attempt = 1; attempt <= 10; attempt++) { // 最多10次
    try {
      const result = await fn();
      
      // 成功：记录并重置断路器
      recordSuccess(context);
      
      const duration = Date.now() - startTime;
      systemMonitor.recordOperation(`retry.${context}.success`, duration, true, {
        attempts: attempt,
        context,
      });

      return result;
    } catch (error: any) {
      lastError = error;

      // Caller marked this error as non-retryable (e.g. quota exhausted) — propagate immediately
      if (error?.__skipRetry) throw error;

      const errorType = classifyError(error);
      const strategy = strategies[errorType];
      const maxAttempts = options?.maxAttemptsOverride || strategy.maxAttempts;

      // 记录失败到断路器
      recordFailure(context);

      // 检查是否应该重试
      if (attempt >= maxAttempts || !strategy.shouldRetry(error, attempt)) {
        const duration = Date.now() - startTime;
        systemMonitor.recordOperation(`retry.${context}.failed`, duration, false, {
          attempts: attempt,
          errorType,
          context,
          finalError: error.message,
        });

        logger.error(`[Retry] ${context} failed after ${attempt} attempts (${errorType})`, error);
        throw error;
      }

      // 计算延迟
      const delay = strategy.calculateDelay(attempt, strategy.baseDelayMs, strategy.maxDelayMs);

      logger.warn(
        `[Retry] ${context} attempt ${attempt} failed (${errorType}). ` +
        `Retrying in ${Math.round(delay)}ms...`
      );

      // 调用重试回调
      if (options?.onRetry) {
        options.onRetry(error, attempt, delay);
      }

      // 等待
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

export async function retryOperation<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
): Promise<T> {
  return smartRetry(fn, {
    maxAttemptsOverride: maxAttempts,
    onRetry: (_error, attempt, delay) => {
      logger.warn(`[Retry] attempt ${attempt} failed, retrying in ${Math.round(delay)}ms`);
    },
  });
}

/** Resets all circuit breaker state — for test isolation only. */
export function _resetCircuitBreakers(): void {
  circuitBreakers.clear();
}

// 获取重试统计
export function getRetryStats(): {
  circuitBreakers: Array<{ context: string; state: string; failures: number }>;
  strategies: Record<string, { maxAttempts: number; baseDelayMs: number }>;
} {
  const breakers = Array.from(circuitBreakers.entries()).map(([key, state]) => ({
    context: key,
    state: state.state,
    failures: state.failures,
  }));

  const strategyInfo: Record<string, { maxAttempts: number; baseDelayMs: number }> = {};
  for (const [type, strategy] of Object.entries(strategies)) {
    strategyInfo[type] = {
      maxAttempts: strategy.maxAttempts,
      baseDelayMs: strategy.baseDelayMs,
    };
  }

  return { circuitBreakers: breakers, strategies: strategyInfo };
}
