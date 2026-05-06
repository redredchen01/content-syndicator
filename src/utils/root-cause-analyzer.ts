import { metricsAggregator, OperationMetrics, AggregatedMetrics } from './metrics-aggregator';
import { traceCollector } from './tracer';

/**
 * RootCauseAnalyzer - 根因分析工具
 * 基于聚合指标和异常告警，提供快速根因分析和优化建议
 */

export interface DiagnosisRecord {
  type: 'error' | 'latency' | 'resource' | 'dependency';
  severity: 'high' | 'medium' | 'low';
  metric: string;
  currentValue: number;
  baseline: number;
  affectedCount: number;
}

export interface Recommendation {
  priority: 1 | 2 | 3;
  title: string;
  description: string;
  estimatedImprovement: string;
  implementation: string;
  relatedIssues?: string[];
}

export interface RootCauseAnalysis {
  operation: string;
  timeRange: { start: number; end: number };

  diagnosis: {
    primary: string;
    factors: DiagnosisRecord[];
  };

  recommendations: Recommendation[];

  relatedTraces: Array<{
    traceId: string;
    duration: number;
    errorMessage?: string;
  }>;

  confidence: number; // 0-1，诊断的置信度
}

export class RootCauseAnalyzer {
  private static instance: RootCauseAnalyzer;

  private constructor() {}

  static getInstance(): RootCauseAnalyzer {
    if (!RootCauseAnalyzer.instance) {
      RootCauseAnalyzer.instance = new RootCauseAnalyzer();
    }
    return RootCauseAnalyzer.instance;
  }

  /**
   * 分析操作的根因
   */
  analyze(
    operation: string,
    timeRange?: { start: number; end: number },
  ): RootCauseAnalysis {
    // 默认时间范围：最近 1 小时
    if (!timeRange) {
      const now = Date.now();
      timeRange = {
        start: now - 3600000,
        end: now,
      };
    }

    // 获取聚合指标
    const metricsHistory = metricsAggregator.query({
      operation,
      timeRange,
    });

    if (metricsHistory.length === 0) {
      return this.createEmptyAnalysis(operation, timeRange);
    }

    // 诊断问题
    const diagnosis = this.diagnose(operation, metricsHistory);

    // 生成建议
    const recommendations = this.generateRecommendations(diagnosis, operation);

    // 收集相关 trace
    const traces = traceCollector.query({
      name: operation,
      timeRange,
      sortBy: 'duration',
      limit: 5,
    });

    const relatedTraces = traces.map(t => ({
      traceId: t.traceId,
      duration: t.duration,
      errorMessage: t.status === 'error' ? t.errorMessage : undefined,
    }));

    // 计算置信度
    const confidence = this.calculateConfidence(diagnosis, metricsHistory.length);

    return {
      operation,
      timeRange,
      diagnosis,
      recommendations,
      relatedTraces,
      confidence,
    };
  }

  /**
   * 诊断问题
   */
  private diagnose(operation: string, metrics: AggregatedMetrics[]): {
    primary: string;
    factors: DiagnosisRecord[];
  } {
    const factors: DiagnosisRecord[] = [];

    // 获取最新指标
    const latest = metrics[metrics.length - 1];
    const operationMetrics = latest.operations[operation];

    if (!operationMetrics) {
      return {
        primary: '无数据',
        factors: [],
      };
    }

    // 检查 1: 错误率
    if (operationMetrics.errorRate > 0.1) {
      factors.push({
        type: 'error',
        severity: operationMetrics.errorRate > 0.5 ? 'high' : 'medium',
        metric: 'errorRate',
        currentValue: operationMetrics.errorRate,
        baseline: 0.02,
        affectedCount: Math.round(operationMetrics.count * operationMetrics.errorRate),
      });
    }

    // 检查 2: 延迟
    if (operationMetrics.isAnomaly) {
      const severity =
        operationMetrics.avgDuration > operationMetrics.baseline * 2.5 ? 'high' : 'medium';
      factors.push({
        type: 'latency',
        severity,
        metric: 'avgDuration',
        currentValue: operationMetrics.avgDuration,
        baseline: operationMetrics.baseline,
        affectedCount: operationMetrics.count,
      });
    }

    // 检查 3: 资源（从系统指标）
    if (latest.systemMetrics.memory.heapUsed > latest.systemMetrics.memory.heapTotal * 0.8) {
      factors.push({
        type: 'resource',
        severity: 'medium',
        metric: 'heapUsage',
        currentValue: latest.systemMetrics.memory.heapUsed,
        baseline: latest.systemMetrics.memory.heapTotal * 0.6,
        affectedCount: operationMetrics.count,
      });
    }

    // 生成主要诊断信息
    const primary = this.generatePrimaryDiagnosis(factors, operationMetrics);

    return { primary, factors };
  }

  /**
   * 生成主要诊断信息
   */
  private generatePrimaryDiagnosis(
    factors: DiagnosisRecord[],
    metrics: OperationMetrics,
  ): string {
    if (factors.length === 0) {
      return '系统运行正常，未发现异常';
    }

    const highSeverity = factors.filter(f => f.severity === 'high');

    if (highSeverity.length > 0) {
      const types = highSeverity.map(f => f.type).join(', ');
      return `检测到严重问题：${types}，需要立即关注`;
    }

    const latencyFactor = factors.find(f => f.type === 'latency');
    const errorFactor = factors.find(f => f.type === 'error');

    if (latencyFactor && errorFactor) {
      return `性能下降（${(metrics.avgDuration / metrics.baseline).toFixed(2)}x基线）+ 错误率升高（${(metrics.errorRate * 100).toFixed(2)}%）`;
    }

    if (latencyFactor) {
      return `性能下降：平均耗时 ${metrics.avgDuration.toFixed(0)}ms，基线 ${metrics.baseline.toFixed(0)}ms`;
    }

    if (errorFactor) {
      return `错误率升高：${(metrics.errorRate * 100).toFixed(2)}%，受影响请求 ${Math.round(metrics.count * metrics.errorRate)} 个`;
    }

    return '检测到异常，但原因待进一步分析';
  }

  /**
   * 生成优化建议
   */
  private generateRecommendations(diagnosis: { primary: string; factors: DiagnosisRecord[] }, operation: string): Recommendation[] {
    const recommendations: Recommendation[] = [];

    for (const factor of diagnosis.factors) {
      if (factor.type === 'error') {
        recommendations.push({
          priority: 1,
          title: '查看错误日志并分析错误类型',
          description: `错误率 ${(factor.currentValue * 100).toFixed(2)}%，影响 ${factor.affectedCount} 个请求`,
          estimatedImprovement: '根据错误类型决定',
          implementation: '使用 /api/traces 端点查询失败的 trace，分析错误堆栈',
          relatedIssues: ['error-rate-spike'],
        });
      } else if (factor.type === 'latency') {
        // 根据操作名提供具体建议
        if (operation.includes('publish')) {
          recommendations.push({
            priority: 2,
            title: '优化发布路由中的固定延迟',
            description: `当前耗时 ${factor.currentValue.toFixed(0)}ms，基线 ${factor.baseline.toFixed(0)}ms`,
            estimatedImprovement: '30-50% 性能提升',
            implementation:
              '将发布路由中的固定延迟（30-60s）改为平台适配（2-8s）+ 指数退避',
            relatedIssues: ['publish-fixed-delay'],
          });
        } else if (operation.includes('scrape')) {
          recommendations.push({
            priority: 2,
            title: '优化爬虫并发控制',
            description: `当前耗时 ${factor.currentValue.toFixed(0)}ms`,
            estimatedImprovement: '20-30% 性能提升',
            implementation: '增加并发度或优化网络请求策略',
          });
        } else {
          recommendations.push({
            priority: 2,
            title: '性能诊断',
            description: `操作耗时超过基线 ${((factor.currentValue / factor.baseline) * 100 - 100).toFixed(0)}%`,
            estimatedImprovement: '待确定',
            implementation: '分析关键路径中的慢操作，使用 /api/traces 查看详细耗时分布',
          });
        }
      } else if (factor.type === 'resource') {
        recommendations.push({
          priority: 2,
          title: '监控内存占用',
          description: `堆内存使用 ${(factor.currentValue / 1024 / 1024).toFixed(0)}MB`,
          estimatedImprovement: '系统稳定性提升',
          implementation: '检查是否有内存泄漏，优化大对象的生命周期',
        });
      }
    }

    // 添加通用建议
    if (recommendations.length === 0) {
      recommendations.push({
        priority: 3,
        title: '继续监控',
        description: '系统运行正常，建议继续监控以发现潜在问题',
        estimatedImprovement: '预防性维护',
        implementation: '设置告警阈值，监控性能趋势',
      });
    }

    return recommendations;
  }

  /**
   * 计算诊断的置信度
   */
  private calculateConfidence(diagnosis: { factors: DiagnosisRecord[] }, sampleCount: number): number {
    // 样本越多，置信度越高
    const sampleConfidence = Math.min(sampleCount / 100, 1);

    // 因素越多，置信度越高（因为诊断更有据可查）
    const factorConfidence = Math.min(diagnosis.factors.length / 3, 1);

    return (sampleConfidence + factorConfidence) / 2;
  }

  /**
   * 创建空的分析结果
   */
  private createEmptyAnalysis(
    operation: string,
    timeRange: { start: number; end: number },
  ): RootCauseAnalysis {
    return {
      operation,
      timeRange,
      diagnosis: {
        primary: '无数据：该操作在指定时间范围内没有执行记录',
        factors: [],
      },
      recommendations: [
        {
          priority: 3,
          title: '检查时间范围和操作名称',
          description: '确保指定的操作在指定的时间范围内有执行',
          estimatedImprovement: '获取有效数据',
          implementation: '扩大时间范围或检查操作名称是否正确',
        },
      ],
      relatedTraces: [],
      confidence: 0,
    };
  }
}

// 导出单例
export const rootCauseAnalyzer = RootCauseAnalyzer.getInstance();
