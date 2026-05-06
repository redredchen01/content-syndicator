import { randomUUID } from 'crypto';
import { getContextId, runWithContext } from './context';

/**
 * Tracer - 跨模块追踪系统
 * 支持 span 级别的调用链追踪，记录耗时、错误、上下文信息
 */

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  duration: number;
  status: 'ok' | 'error';
  errorMessage?: string;
  meta: Record<string, any>;
}

// 全局追踪状态
let currentSpanId: string | null = null;
let currentTraceId: string | null = null;

export function getCurrentSpanId(): string | null {
  return currentSpanId;
}

export function getCurrentTraceId(): string | null {
  return currentTraceId;
}

function generateTraceId(): string {
  return `trace-${randomUUID()}`;
}

function generateSpanId(): string {
  return `span-${randomUUID()}`;
}

/**
 * 创建或继续一个追踪
 */
export async function span<T>(
  name: string,
  fn: () => Promise<T>,
  meta?: Record<string, any>,
): Promise<T> {
  // 获取或创建 traceId
  const traceId = currentTraceId || generateTraceId();
  const spanId = generateSpanId();
  const parentSpanId = currentSpanId;
  const startTime = Date.now();

  // Run inside AsyncLocalStorage context keyed by spanId
  return await runWithContext(spanId, async () => {
    const prevSpanId = currentSpanId;
    const prevTraceId = currentTraceId;

    currentSpanId = spanId;
    currentTraceId = traceId;

    try {
      const result = await fn();

      recordSpan({
        traceId,
        spanId,
        parentSpanId: parentSpanId ?? undefined,
        name,
        startTime,
        duration: Date.now() - startTime,
        status: 'ok',
        meta: meta || {},
      });

      return result;
    } catch (error) {
      recordSpan({
        traceId,
        spanId,
        parentSpanId: parentSpanId ?? undefined,
        name,
        startTime,
        duration: Date.now() - startTime,
        status: 'error',
        errorMessage: error instanceof Error ? error.message : String(error),
        meta: meta || {},
      });

      throw error;
    } finally {
      currentSpanId = prevSpanId;
      currentTraceId = prevTraceId;
    }
  });
}

/**
 * 记录 span 到收集器
 */
function recordSpan(s: Span): void {
  TraceCollector.getInstance().record(s);
}

/**
 * Trace 收集器 - 管理所有 span 的存储和查询
 */
export class TraceCollector {
  private static instance: TraceCollector;
  private spans: Span[] = [];
  private maxSpans: number = 100000;

  private constructor() {}

  static getInstance(): TraceCollector {
    if (!TraceCollector.instance) {
      TraceCollector.instance = new TraceCollector();
    }
    return TraceCollector.instance;
  }

  /**
   * 记录一个 span
   */
  record(span: Span): void {
    // 超过上限时，移除最早的 span
    if (this.spans.length >= this.maxSpans) {
      this.spans.shift();
    }

    this.spans.push(span);
  }

  /**
   * 获取最近的 span（按时间戳）
   */
  getRecent(sinceMs: number = 5000): Span[] {
    const now = Date.now();
    return this.spans.filter(s => now - s.startTime <= sinceMs);
  }

  /**
   * 按 traceId 查询 span
   */
  getByTraceId(traceId: string): Span[] {
    return this.spans.filter(s => s.traceId === traceId);
  }

  /**
   * 按 contextId 查询 span（从元数据中）
   */
  getByContextId(contextId: string): Span[] {
    return this.spans.filter(s => s.meta.contextId === contextId);
  }

  /**
   * 通用查询
   */
  query(options: {
    traceId?: string;
    contextId?: string;
    name?: string;
    status?: 'ok' | 'error';
    timeRange?: { start: number; end: number };
    limit?: number;
    sortBy?: 'duration' | 'timestamp';
  }): Span[] {
    let results = this.spans;

    if (options.traceId) {
      results = results.filter(s => s.traceId === options.traceId);
    }

    if (options.contextId) {
      results = results.filter(s => s.meta.contextId === options.contextId);
    }

    if (options.name) {
      // 支持模式匹配（例如 "publish*"）
      const pattern = new RegExp(`^${options.name.replace('*', '.*')}`);
      results = results.filter(s => pattern.test(s.name));
    }

    if (options.status) {
      results = results.filter(s => s.status === options.status);
    }

    if (options.timeRange) {
      results = results.filter(
        s => s.startTime >= options.timeRange!.start && s.startTime <= options.timeRange!.end,
      );
    }

    // 排序
    if (options.sortBy === 'duration') {
      results.sort((a, b) => b.duration - a.duration);
    } else if (options.sortBy === 'timestamp') {
      results.sort((a, b) => b.startTime - a.startTime);
    }

    // 限制结果数量
    if (options.limit) {
      results = results.slice(0, options.limit);
    }

    return results;
  }

  /**
   * 获取所有 span
   */
  getAll(): Span[] {
    return [...this.spans];
  }

  /**
   * 清空所有 span
   */
  clear(): void {
    this.spans = [];
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      totalSpans: this.spans.length,
      maxSpans: this.maxSpans,
      successRate:
        this.spans.length > 0
          ? `${(((this.spans.filter(s => s.status === 'ok').length / this.spans.length) * 100).toFixed(2))}%`
          : '0%',
      avgDuration:
        this.spans.length > 0
          ? (this.spans.reduce((sum, s) => sum + s.duration, 0) / this.spans.length).toFixed(2)
          : '0',
      oldestSpan: this.spans.length > 0 ? this.spans[0].startTime : null,
      newestSpan: this.spans.length > 0 ? this.spans[this.spans.length - 1].startTime : null,
    };
  }
}

// 导出单例收集器
export const traceCollector = TraceCollector.getInstance();
