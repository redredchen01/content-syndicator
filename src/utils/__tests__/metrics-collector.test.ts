import { describe, it, expect, beforeEach } from 'vitest';
import {
  incrementCounter,
  setGauge,
  recordHistogram,
  timeAsync,
  timeSync,
  getReport,
  reset,
  formatReport,
} from '../metrics-collector';

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

describe('Metrics Collector', () => {
  beforeEach(() => {
    reset();
  });

  describe('Counters', () => {
    it('increments counter by 1 (default)', () => {
      incrementCounter('requests');
      incrementCounter('requests');

      const report = getReport();
      expect(report.counters.get('requests')).toBe(2);
    });

    it('increments counter by specified value', () => {
      incrementCounter('processed_items', 5);
      incrementCounter('processed_items', 3);

      const report = getReport();
      expect(report.counters.get('processed_items')).toBe(8);
    });

    it('initializes counter to 0 if not set', () => {
      const report = getReport();
      expect(report.counters.get('nonexistent')).toBeUndefined();
    });
  });

  describe('Gauges', () => {
    it('sets gauge value', () => {
      setGauge('active_connections', 5);
      expect(getReport().gauges.get('active_connections')).toBe(5);
    });

    it('overwrites previous gauge value', () => {
      setGauge('queue_length', 10);
      setGauge('queue_length', 7);
      expect(getReport().gauges.get('queue_length')).toBe(7);
    });
  });

  describe('Histograms', () => {
    it('records histogram values', () => {
      recordHistogram('latency_ms', 100);
      recordHistogram('latency_ms', 150);
      recordHistogram('latency_ms', 200);

      const report = getReport();
      const stats = report.histograms.get('latency_ms');
      expect(stats?.count).toBe(3);
      expect(stats?.sum).toBe(450);
      expect(stats?.min).toBe(100);
      expect(stats?.max).toBe(200);
    });

    it('calculates average correctly', () => {
      recordHistogram('response_time', 100);
      recordHistogram('response_time', 200);
      recordHistogram('response_time', 300);

      const report = getReport();
      expect(report.histograms.get('response_time')?.avg).toBe(200);
    });

    it('calculates percentiles correctly', () => {
      // Record 100 values: 1, 2, 3, ..., 100
      for (let i = 1; i <= 100; i++) {
        recordHistogram('values', i);
      }

      const report = getReport();
      const stats = report.histograms.get('values')!;

      expect(stats.p50).toBeLessThanOrEqual(51); // Around 50
      expect(stats.p95).toBeLessThanOrEqual(96); // Around 95
      expect(stats.p99).toBeLessThanOrEqual(100); // Around 99
      expect(stats.p50).toBeGreaterThanOrEqual(49);
      expect(stats.p95).toBeGreaterThanOrEqual(93);
      expect(stats.p99).toBeGreaterThanOrEqual(97);
    });
  });

  describe('timeSync', () => {
    it('records timing of sync operation', () => {
      timeSync('simple_operation', () => {
        // Simulate work
        let sum = 0;
        for (let i = 0; i < 100; i++) {
          sum += i;
        }
        return sum;
      });

      const report = getReport();
      const stats = report.histograms.get('simple_operation');
      expect(stats?.count).toBe(1);
      expect(stats!.sum).toBeGreaterThanOrEqual(0);
    });

    it('returns function result', () => {
      const result = timeSync('get_value', () => {
        return 42;
      });

      expect(result).toBe(42);
    });

    it('records timing even if function throws', () => {
      try {
        timeSync('failing_operation', () => {
          throw new Error('test error');
        });
      } catch {
        // Expected
      }

      const report = getReport();
      expect(report.histograms.get('failing_operation')?.count).toBe(1);
    });
  });

  describe('timeAsync', () => {
    it('records timing of async operation', async () => {
      await timeAsync('async_operation', async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
      });

      const report = getReport();
      const stats = report.histograms.get('async_operation');
      expect(stats?.count).toBe(1);
      expect(stats!.sum).toBeGreaterThanOrEqual(10);
    });

    it('returns async function result', async () => {
      const result = await timeAsync('async_get_value', async () => {
        return 'hello';
      });

      expect(result).toBe('hello');
    });

    it('records timing even if async function throws', async () => {
      try {
        await timeAsync('failing_async', async () => {
          throw new Error('async test error');
        });
      } catch {
        // Expected
      }

      const report = getReport();
      expect(report.histograms.get('failing_async')?.count).toBe(1);
    });
  });

  describe('reset', () => {
    it('clears all metrics', () => {
      incrementCounter('test_counter');
      setGauge('test_gauge', 42);
      recordHistogram('test_histogram', 100);

      reset();

      const report = getReport();
      expect(report.counters.size).toBe(0);
      expect(report.gauges.size).toBe(0);
      expect(report.histograms.size).toBe(0);
    });
  });

  describe('formatReport', () => {
    it('formats counters section', () => {
      incrementCounter('requests', 10);
      const report = getReport();
      const formatted = formatReport(report);

      expect(formatted).toContain('Counters:');
      expect(formatted).toContain('requests: 10');
    });

    it('formats gauges section', () => {
      setGauge('cpu_usage', 75.5);
      const report = getReport();
      const formatted = formatReport(report);

      expect(formatted).toContain('Gauges:');
      expect(formatted).toContain('cpu_usage');
    });

    it('formats histograms with statistics', () => {
      recordHistogram('latency', 100);
      recordHistogram('latency', 200);
      recordHistogram('latency', 300);

      const report = getReport();
      const formatted = formatReport(report);

      expect(formatted).toContain('Histograms');
      expect(formatted).toContain('latency:');
      expect(formatted).toContain('count=3');
      expect(formatted).toContain('avg=');
      expect(formatted).toContain('p50=');
      expect(formatted).toContain('p95=');
      expect(formatted).toContain('p99=');
    });

    it('omits empty sections', () => {
      incrementCounter('test', 1); // Only counters
      const report = getReport();
      const formatted = formatReport(report);

      expect(formatted).toContain('Counters:');
      expect(formatted).not.toContain('Gauges:');
      expect(formatted).not.toContain('Histograms');
    });
  });

  describe('Integration', () => {
    it('collects comprehensive metrics across all types', async () => {
      incrementCounter('cache_hits');
      incrementCounter('cache_hits');
      incrementCounter('cache_misses');

      setGauge('active_publishes', 3);

      for (let i = 0; i < 5; i++) {
        await timeAsync('variant_generation', async () => {
          await new Promise(resolve => setTimeout(resolve, 5 + Math.random() * 10));
        });
      }

      const report = getReport();

      // Verify all metric types
      expect(report.counters.get('cache_hits')).toBe(2);
      expect(report.counters.get('cache_misses')).toBe(1);
      expect(report.gauges.get('active_publishes')).toBe(3);

      const histStats = report.histograms.get('variant_generation');
      expect(histStats?.count).toBe(5);
      expect(histStats?.p50).toBeGreaterThan(0);
      expect(histStats?.p95).toBeGreaterThan(histStats?.p50 || 0);
    });
  });
});
