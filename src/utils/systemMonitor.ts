import fs from 'fs';
import path from 'path';
import { logger } from './logger';

interface PerformanceMetric {
  operation: string;
  duration: number;
  timestamp: number;
  success: boolean;
  metadata?: Record<string, any>;
}

interface ResourceUsage {
  rss: number; // Resident Set Size in MB
  heapUsed: number; // V8 heap used in MB
  heapTotal: number; // V8 heap total in MB
  cpuUsage: NodeJS.CpuUsage;
}

interface SystemStats {
  totalOperations: number;
  successRate: string;
  averageDuration: string;
  slowestOperation: PerformanceMetric | null;
  fastestOperation: PerformanceMetric | null;
  resourceUsage: ResourceUsage;
  uptime: number;
}

class SystemMonitor {
  private metrics: PerformanceMetric[] = [];
  private maxMetrics = 1000;
  private startTime = Date.now();
  private metricsFile: string;

  constructor() {
    this.metricsFile = path.join(process.cwd(), '.data', 'performance-metrics.json');
    this.loadMetrics();
  }

  recordOperation(
    operation: string,
    duration: number,
    success: boolean,
    metadata?: Record<string, any>
  ): void {
    const metric: PerformanceMetric = {
      operation,
      duration,
      timestamp: Date.now(),
      success,
      metadata,
    };

    this.metrics.push(metric);

    // Keep only recent metrics
    if (this.metrics.length > this.maxMetrics) {
      this.metrics = this.metrics.slice(-this.maxMetrics);
    }

    // Save periodically (every 100 operations)
    if (this.metrics.length % 100 === 0) {
      this.saveMetrics();
    }
  }

  async measureOperation<T>(
    operation: string,
    fn: () => Promise<T>,
    metadata?: Record<string, any>
  ): Promise<T> {
    const start = Date.now();
    let success = true;
    let result: T;

    try {
      result = await fn();
      return result;
    } catch (error) {
      success = false;
      throw error;
    } finally {
      const duration = Date.now() - start;
      this.recordOperation(operation, duration, success, metadata);
    }
  }

  getStats(): SystemStats {
    const totalOps = this.metrics.length;
    const successfulOps = this.metrics.filter(m => m.success).length;
    const successRate = totalOps > 0
      ? ((successfulOps / totalOps) * 100).toFixed(2) + '%'
      : 'N/A';

    const durations = this.metrics.map(m => m.duration);
    const avgDuration = durations.length > 0
      ? (durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(2) + 'ms'
      : 'N/A';

    const sortedByDuration = [...this.metrics].sort((a, b) => b.duration - a.duration);
    const slowest = sortedByDuration[0] || null;
    const fastest = sortedByDuration[sortedByDuration.length - 1] || null;

    const resourceUsage = this.getResourceUsage();
    const uptime = Date.now() - this.startTime;

    return {
      totalOperations: totalOps,
      successRate,
      averageDuration: avgDuration,
      slowestOperation: slowest,
      fastestOperation: fastest,
      resourceUsage,
      uptime,
    };
  }

  getResourceUsage(): ResourceUsage {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();

    return {
      rss: memUsage.rss / 1024 / 1024, // Convert to MB
      heapUsed: memUsage.heapUsed / 1024 / 1024,
      heapTotal: memUsage.heapTotal / 1024 / 1024,
      cpuUsage,
    };
  }

  getMetricsByOperation(operation: string): PerformanceMetric[] {
    return this.metrics.filter(m => m.operation === operation);
  }

  getSlowOperations(thresholdMs: number = 5000): PerformanceMetric[] {
    return this.metrics.filter(m => m.duration > thresholdMs);
  }

  clearMetrics(): void {
    this.metrics = [];
    this.saveMetrics();
    logger.info('[Monitor] Metrics cleared');
  }

  private saveMetrics(): void {
    try {
      const dir = path.dirname(this.metricsFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const data = {
        metrics: this.metrics.slice(-100), // Save only last 100
        savedAt: Date.now(),
      };

      fs.writeFileSync(this.metricsFile, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error: any) {
      logger.warn(`[Monitor] Failed to save metrics: ${error.message}`);
    }
  }

  private loadMetrics(): void {
    try {
      if (fs.existsSync(this.metricsFile)) {
        const data = JSON.parse(fs.readFileSync(this.metricsFile, 'utf-8'));
        this.metrics = data.metrics || [];
        logger.info(`[Monitor] Loaded ${this.metrics.length} metrics from disk`);
      }
    } catch (error: any) {
      logger.warn(`[Monitor] Failed to load metrics: ${error.message}`);
    }
  }

  getUptimeString(): string {
    const uptime = Date.now() - this.startTime;
    const seconds = Math.floor(uptime / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
}

export const systemMonitor = new SystemMonitor();

// Helper function to measure async operations
export async function measure<T>(
  operation: string,
  fn: () => Promise<T>,
  metadata?: Record<string, any>
): Promise<T> {
  return systemMonitor.measureOperation(operation, fn, metadata);
}

// Helper to record sync operations
export function record(
  operation: string,
  duration: number,
  success: boolean,
  metadata?: Record<string, any>
): void {
  systemMonitor.recordOperation(operation, duration, success, metadata);
}

// Get formatted stats for display
export function getFormattedStats(): string {
  const stats = systemMonitor.getStats();
  const lines = [
    '=== System Performance Stats ===',
    `Uptime: ${systemMonitor.getUptimeString()}`,
    `Total Operations: ${stats.totalOperations}`,
    `Success Rate: ${stats.successRate}`,
    `Average Duration: ${stats.averageDuration}`,
    `Memory (RSS): ${stats.resourceUsage.rss.toFixed(2)} MB`,
    `Heap Used: ${stats.resourceUsage.heapUsed.toFixed(2)} MB`,
    `Heap Total: ${stats.resourceUsage.heapTotal.toFixed(2)} MB`,
  ];

  if (stats.slowestOperation) {
    lines.push(`Slowest: ${stats.slowestOperation.operation} (${stats.slowestOperation.duration}ms)`);
  }

  return lines.join('\n');
}
