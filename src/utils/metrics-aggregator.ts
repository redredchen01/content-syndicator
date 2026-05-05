import { traceCollector, Span } from './tracer';
import { systemMonitor } from './systemMonitor';

/**
 * MetricsAggregator - 性能指标聚合引擎
 * 定期聚合 span、系统指标，计算基线和异常告警
 */

export interface OperationMetrics {
  count: number;
  avgDuration: number;
  p95Duration: number;
  p99Duration: number;
  errorRate: number; // 0-1 范围
  baseline: number; // 基线值
  isAnomaly: boolean;
  slowestTraceId?: string;
  slowestDuration?: number;
}

export interface AggregatedMetrics {
  timestamp: number;
  operations: Record<string, OperationMetrics>;
  systemMetrics: {
    cpu: number;
    memory: {
      rss: number;
      heapUsed: number;
      heapTotal: number;
    };
    uptime: number;
  };
  anomalies: Anomaly[];
}

export interface Anomaly {
  operation: string;
  actualDuration: number;
  baseline: number;
  severity: 'high' | 'medium' | 'low';
  affectedCount: number;
}

interface Baseline {
  operation: string;
  avgDuration: number;
  p95Duration: number;
  p99Duration: number;
  sampleCount: number;
  lastUpdated: number;
}

export class MetricsAggregator {
  private static instance: MetricsAggregator;
  private aggregationTimer: NodeJS.Timeout | null = null;
  private baseline: Map<string, Baseline> = new Map();
  private aggregationHistory: AggregatedMetrics[] = [];
  private maxHistorySize: number = 1000;
  private isRunning: boolean = false;
  private aggregationInterval: number = 5000; // 5 秒

  private constructor() {}

  static getInstance(): MetricsAggregator {
    if (!MetricsAggregator.instance) {
      MetricsAggregator.instance = new MetricsAggregator();
    }
    return MetricsAggregator.instance;
  }

  /**
   * 启动聚合引擎
   */
  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    this.aggregate(); // 立即聚合一次
    this.aggregationTimer = setInterval(() => {
      this.aggregate();
    }, this.aggregationInterval);

    // 不阻塞进程退出
    if (this.aggregationTimer.unref) {
      this.aggregationTimer.unref();
    }
  }

  /**
   * 停止聚合引擎
   */
  stop(): void {
    if (this.aggregationTimer) {
      clearInterval(this.aggregationTimer);
      this.aggregationTimer = null;
    }
    this.isRunning = false;
  }

  /**
   * 执行聚合
   */
  private aggregate(): void {
    try {
      // 收集最近 5 秒的 span
      const spans = traceCollector.getRecent(this.aggregationInterval);

      // 按操作名分组统计
      const groupedByOp = this.groupByOperation(spans);

      // 计算统计量
      const metrics = this.computeMetrics(groupedByOp);

      // 检测异常
      const anomalies = this.detectAnomalies(metrics);

      // 更新基线
      this.updateBaselines(groupedByOp);

      // 保存聚合结果
      const aggregated: AggregatedMetrics = {
        timestamp: Date.now(),
        operations: metrics,
        systemMetrics: this.getSystemMetrics(),
        anomalies,
      };

      this.saveAggregatedMetrics(aggregated);
    } catch (error) {
      console.error('[MetricsAggregator] aggregation error:', error);
    }
  }

  /**
   * 按操作名分组 span
   */
  private groupByOperation(
    spans: Span[],
  ): Record<string, { spans: Span[]; durations: number[] }> {
    const grouped: Record<string, { spans: Span[]; durations: number[] }> = {};

    spans.forEach(span => {
      if (!grouped[span.name]) {
        grouped[span.name] = { spans: [], durations: [] };
      }
      grouped[span.name].spans.push(span);
      grouped[span.name].durations.push(span.duration);
    });

    return grouped;
  }

  /**
   * 计算统计量
   */
  private computeMetrics(grouped: Record<string, { spans: Span[]; durations: number[] }>): Record<
    string,
    OperationMetrics
  > {
    const metrics: Record<string, OperationMetrics> = {};

    for (const [operation, { spans, durations }] of Object.entries(grouped)) {
      const count = spans.length;
      const errors = spans.filter(s => s.status === 'error').length;
      const errorRate = count > 0 ? errors / count : 0;

      // 计算百分位数
      const sorted = [...durations].sort((a, b) => a - b);
      const avgDuration = durations.reduce((sum, d) => sum + d, 0) / count;
      const p95Duration = sorted[Math.ceil(count * 0.95) - 1] || 0;
      const p99Duration = sorted[Math.ceil(count * 0.99) - 1] || 0;

      // 获取基线或初始化
      const baseline = this.baseline.get(operation)?.avgDuration || avgDuration;

      // 检测异常
      const isAnomaly = avgDuration > baseline * 1.5;

      // 找到最慢的 trace
      let slowestTraceId: string | undefined;
      let slowestDuration = 0;
      spans.forEach(span => {
        if (span.duration > slowestDuration) {
          slowestDuration = span.duration;
          slowestTraceId = span.traceId;
        }
      });

      metrics[operation] = {
        count,
        avgDuration: Math.round(avgDuration * 100) / 100,
        p95Duration: Math.round(p95Duration * 100) / 100,
        p99Duration: Math.round(p99Duration * 100) / 100,
        errorRate: Math.round(errorRate * 10000) / 10000,
        baseline: Math.round(baseline * 100) / 100,
        isAnomaly,
        slowestTraceId,
        slowestDuration: Math.round(slowestDuration * 100) / 100,
      };
    }

    return metrics;
  }

  /**
   * 检测异常
   */
  private detectAnomalies(metrics: Record<string, OperationMetrics>): Anomaly[] {
    const anomalies: Anomaly[] = [];

    for (const [operation, m] of Object.entries(metrics)) {
      if (m.isAnomaly) {
        anomalies.push({
          operation,
          actualDuration: m.avgDuration,
          baseline: m.baseline,
          severity: m.avgDuration > m.baseline * 2.5 ? 'high' : 'medium',
          affectedCount: m.count,
        });
      }

      if (m.errorRate > 0.1) {
        // 错误率 > 10%
        anomalies.push({
          operation,
          actualDuration: m.avgDuration,
          baseline: m.baseline,
          severity: m.errorRate > 0.5 ? 'high' : 'medium',
          affectedCount: m.count,
        });
      }
    }

    return anomalies;
  }

  /**
   * 更新性能基线
   */
  private updateBaselines(grouped: Record<string, { spans: Span[]; durations: number[] }>): void {
    for (const [operation, { durations }] of Object.entries(grouped)) {
      if (durations.length === 0) continue;

      const current = this.baseline.get(operation);
      const sorted = [...durations].sort((a, b) => a - b);
      const count = durations.length;

      const avgDuration = durations.reduce((sum, d) => sum + d, 0) / count;
      const p95Duration = sorted[Math.ceil(count * 0.95) - 1] || 0;
      const p99Duration = sorted[Math.ceil(count * 0.99) - 1] || 0;

      if (!current) {
        // 初始化基线（需要至少 100 个样本才能真正锁定）
        this.baseline.set(operation, {
          operation,
          avgDuration,
          p95Duration,
          p99Duration,
          sampleCount: count,
          lastUpdated: Date.now(),
        });
      } else if (current.sampleCount < 100) {
        // 学习期：更新基线
        const newSampleCount = current.sampleCount + count;
        this.baseline.set(operation, {
          operation,
          avgDuration:
            (current.avgDuration * current.sampleCount + avgDuration * count) / newSampleCount,
          p95Duration:
            (current.p95Duration * current.sampleCount + p95Duration * count) / newSampleCount,
          p99Duration:
            (current.p99Duration * current.sampleCount + p99Duration * count) / newSampleCount,
          sampleCount: newSampleCount,
          lastUpdated: Date.now(),
        });
      } else {
        // 基线已稳定，用指数移动平均更新
        const alpha = 0.1; // 学习率
        const current_baseline = this.baseline.get(operation)!;
        this.baseline.set(operation, {
          operation,
          avgDuration: current_baseline.avgDuration * (1 - alpha) + avgDuration * alpha,
          p95Duration: current_baseline.p95Duration * (1 - alpha) + p95Duration * alpha,
          p99Duration: current_baseline.p99Duration * (1 - alpha) + p99Duration * alpha,
          sampleCount: current_baseline.sampleCount + count,
          lastUpdated: Date.now(),
        });
      }
    }
  }

  /**
   * 获取系统指标
   */
  private getSystemMetrics() {
    const mem = process.memoryUsage();
    const uptime = process.uptime();

    return {
      cpu: 0, // CPU 统计需要额外的采集
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
      },
      uptime,
    };
  }

  /**
   * 保存聚合结果
   */
  private saveAggregatedMetrics(metrics: AggregatedMetrics): void {
    // 保存到历史记录
    this.aggregationHistory.push(metrics);

    // 限制历史大小
    if (this.aggregationHistory.length > this.maxHistorySize) {
      this.aggregationHistory.shift();
    }
  }

  /**
   * 查询聚合指标
   */
  query(options: {
    operation?: string;
    timeRange?: { start: number; end: number };
    limit?: number;
  }): AggregatedMetrics[] {
    let results = [...this.aggregationHistory];

    if (options.operation) {
      results = results.filter(m => options.operation! in m.operations);
    }

    if (options.timeRange) {
      results = results.filter(
        m =>
          m.timestamp >= options.timeRange!.start && m.timestamp <= options.timeRange!.end,
      );
    }

    if (options.limit) {
      results = results.slice(-options.limit);
    }

    return results;
  }

  /**
   * 获取最新的聚合结果
   */
  getLatest(): AggregatedMetrics | null {
    return this.aggregationHistory.length > 0
      ? this.aggregationHistory[this.aggregationHistory.length - 1]
      : null;
  }

  /**
   * 获取基线信息
   */
  getBaselines(): Map<string, Baseline> {
    return new Map(this.baseline);
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const latest = this.getLatest();

    return {
      isRunning: this.isRunning,
      aggregationCount: this.aggregationHistory.length,
      baselineCount: this.baseline.size,
      latestAggregation: latest ? latest.timestamp : null,
      anomalyCount: latest ? latest.anomalies.length : 0,
      monitoredOperations: latest ? Object.keys(latest.operations).length : 0,
    };
  }
}

// 导出单例
export const metricsAggregator = MetricsAggregator.getInstance();
