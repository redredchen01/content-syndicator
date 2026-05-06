/**
 * Unit 7: Performance Metrics Collector
 *
 * Collects timing, counting, and gauge metrics for performance monitoring.
 * Computes percentiles (p50, p95, p99) for histogram metrics.
 */

// -----------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------

export interface MetricsReport {
  counters: Map<string, number>;
  gauges: Map<string, number>;
  histograms: Map<
    string,
    {
      count: number;
      sum: number;
      min: number;
      max: number;
      avg: number;
      p50: number;
      p95: number;
      p99: number;
    }
  >;
}

// -----------------------------------------------------------------------
// State
// -----------------------------------------------------------------------

const counters: Map<string, number> = new Map();
const gauges: Map<string, number> = new Map();
const histograms: Map<string, number[]> = new Map();

// -----------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------

/**
 * Increment a counter metric.
 */
export function incrementCounter(name: string, value: number = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + value);
}

/**
 * Set a gauge metric (current value).
 */
export function setGauge(name: string, value: number): void {
  gauges.set(name, value);
}

/**
 * Record a histogram value (e.g., latency in milliseconds).
 */
export function recordHistogram(name: string, value: number): void {
  if (!histograms.has(name)) {
    histograms.set(name, []);
  }
  histograms.get(name)!.push(value);
}

/**
 * Time an async operation and record histogram value.
 * Usage: await timeAsync('operation_name', async () => { ... })
 */
export async function timeAsync<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    const duration = Date.now() - start;
    recordHistogram(name, duration);
  }
}

/**
 * Time a sync operation and record histogram value.
 */
export function timeSync<T>(name: string, fn: () => T): T {
  const start = Date.now();
  try {
    return fn();
  } finally {
    const duration = Date.now() - start;
    recordHistogram(name, duration);
  }
}

/**
 * Get current metrics report with statistics.
 */
export function getReport(): MetricsReport {
  const histogramStats = new Map<
    string,
    {
      count: number;
      sum: number;
      min: number;
      max: number;
      avg: number;
      p50: number;
      p95: number;
      p99: number;
    }
  >();

  histograms.forEach((values, name) => {
    if (values.length === 0) return;

    const sorted = [...values].sort((a, b) => a - b);
    const count = values.length;
    const sum = values.reduce((a, b) => a + b, 0);
    const min = sorted[0];
    const max = sorted[count - 1];
    const avg = sum / count;

    histogramStats.set(name, {
      count,
      sum,
      min,
      max,
      avg,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
    });
  });

  return {
    counters: new Map(counters),
    gauges: new Map(gauges),
    histograms: histogramStats,
  };
}

/**
 * Reset all metrics.
 */
export function reset(): void {
  counters.clear();
  gauges.clear();
  histograms.clear();
}

/**
 * Format metrics report for logging.
 */
export function formatReport(report: MetricsReport): string {
  const lines: string[] = [];

  if (report.counters.size > 0) {
    lines.push('Counters:');
    report.counters.forEach((value, name) => {
      lines.push(`  ${name}: ${value}`);
    });
  }

  if (report.gauges.size > 0) {
    lines.push('Gauges:');
    report.gauges.forEach((value, name) => {
      lines.push(`  ${name}: ${value.toFixed(2)}`);
    });
  }

  if (report.histograms.size > 0) {
    lines.push('Histograms (ms):');
    report.histograms.forEach((stats, name) => {
      lines.push(`  ${name}:`);
      lines.push(
        `    count=${stats.count}, avg=${stats.avg.toFixed(2)}, min=${stats.min}, max=${stats.max}`,
      );
      lines.push(
        `    p50=${stats.p50.toFixed(2)}, p95=${stats.p95.toFixed(2)}, p99=${stats.p99.toFixed(2)}`,
      );
    });
  }

  return lines.join('\n');
}

// -----------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------

/**
 * Calculate percentile from sorted array.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}
