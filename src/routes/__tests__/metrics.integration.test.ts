import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../server';
import { traceCollector } from '../../utils/tracer';
import { metricsAggregator } from '../../utils/metrics-aggregator';
import { span } from '../../utils/tracer';

describe('Metrics API', () => {
  beforeEach(() => {
    traceCollector.clear();
  });

  afterAll(() => {
    metricsAggregator.stop();
  });

  describe('GET /api/stats', () => {
    it('should return system statistics', async () => {
      const res = await request(app).get('/api/stats');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.timestamp).toBeGreaterThan(0);
      expect(res.body.data.systemMonitor).toBeDefined();
      expect(res.body.data.metricsAggregator).toBeDefined();
    });

    it('should include uptime in stats', async () => {
      const res = await request(app).get('/api/stats');

      expect(res.body.data.systemMonitor.uptime).toBeGreaterThan(0);
    });
  });

  describe('GET /api/metrics', () => {
    beforeEach(async () => {
      // 创建一些 span 用于测试
      for (let i = 0; i < 5; i++) {
        await span('test.operation', async () => {
          await new Promise(r => setTimeout(r, 10 + Math.random() * 10));
        });
      }

      metricsAggregator.start();
      await new Promise(r => setTimeout(r, 100));
    });

    it('should return aggregated metrics', async () => {
      const res = await request(app).get('/api/metrics?operation=test.operation&since=1h');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.results).toBeDefined();
      expect(Array.isArray(res.body.data.results)).toBe(true);
    });

    it('should support time range parameters', async () => {
      const res = await request(app)
        .get('/api/metrics')
        .query({ since: '6h', limit: 10 });

      expect(res.status).toBe(200);
      expect(res.body.data.timeRange).toBeDefined();
      expect(res.body.data.timeRange.start).toBeLessThan(res.body.data.timeRange.end);
    });

    it('should respect limit parameter', async () => {
      const res = await request(app).get('/api/metrics?limit=5');

      expect(res.status).toBe(200);
      expect(res.body.data.results.length).toBeLessThanOrEqual(5);
    });
  });

  describe('GET /api/traces', () => {
    beforeEach(async () => {
      // 创建一些 span
      for (let i = 0; i < 3; i++) {
        await span(`trace.test.${i}`, async () => {
          await new Promise(r => setTimeout(r, 5));
        });
      }
    });

    it('should return traces', async () => {
      const res = await request(app).get('/api/traces?since=1h');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.traces).toBeDefined();
      expect(Array.isArray(res.body.data.traces)).toBe(true);
    });

    it('should support name filtering with wildcard', async () => {
      const res = await request(app).get('/api/traces?name=trace.test.*&since=1h');

      expect(res.status).toBe(200);
      expect(res.body.data.traces.length).toBeGreaterThanOrEqual(0);
    });

    it('should limit results', async () => {
      const res = await request(app).get('/api/traces?limit=2');

      expect(res.status).toBe(200);
      expect(res.body.data.traces.length).toBeLessThanOrEqual(2);
    });
  });

  describe('POST /api/analyze', () => {
    beforeEach(async () => {
      // 创建测试数据
      for (let i = 0; i < 10; i++) {
        await span('analyze.test', async () => {
          await new Promise(r => setTimeout(r, 10 + Math.random() * 10));
        });
      }

      metricsAggregator.start();
      await new Promise(r => setTimeout(r, 100));
    });

    it('should analyze operation and return diagnosis', async () => {
      const res = await request(app).post('/api/analyze').send({
        operation: 'analyze.test',
      });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.operation).toBe('analyze.test');
      expect(res.body.data.diagnosis).toBeDefined();
      expect(res.body.data.recommendations).toBeDefined();
      expect(res.body.data.relatedTraces).toBeDefined();
    });

    it('should return recommendations', async () => {
      const res = await request(app).post('/api/analyze').send({
        operation: 'analyze.test',
      });

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.recommendations)).toBe(true);
    });

    it('should reject invalid operation', async () => {
      const res = await request(app).post('/api/analyze').send({
        // 缺少 operation
      });

      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it('should accept custom time range', async () => {
      const now = Date.now();
      const res = await request(app).post('/api/analyze').send({
        operation: 'analyze.test',
        timeRange: {
          start: now - 3600000,
          end: now,
        },
      });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  describe('GET /api/baselines', () => {
    it('should return baseline information', async () => {
      const res = await request(app).get('/api/baselines');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.baselines).toBeDefined();
      expect(Array.isArray(res.body.data.baselines)).toBe(true);
      expect(res.body.data.count).toBeGreaterThanOrEqual(0);
    });
  });

  describe('POST /api/metrics/start and stop', () => {
    it('should start metrics aggregator', async () => {
      const res = await request(app).post('/api/metrics/start');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.message).toContain('started');
    });

    it('should stop metrics aggregator', async () => {
      // 先启动
      await request(app).post('/api/metrics/start');

      // 再停止
      const res = await request(app).post('/api/metrics/stop');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.message).toContain('stopped');
    });
  });

  describe('Error handling', () => {
    it('should handle invalid time format gracefully', async () => {
      const res = await request(app).get('/api/metrics?since=invalid');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      // 应该使用默认时间范围
      expect(res.body.data.timeRange).toBeDefined();
    });

    it('should handle limit exceeding maximum', async () => {
      const res = await request(app).get('/api/metrics?limit=10000');

      expect(res.status).toBe(200);
      // limit 应该被限制在 1000 以内
      expect(res.body.data.query.limit).toBeLessThanOrEqual(1000);
    });
  });
});
