import { describe, it, expect, beforeEach } from 'vitest';
import { span, traceCollector, Span } from '../tracer';

describe('Tracer', () => {
  beforeEach(() => {
    traceCollector.clear();
  });

  describe('Happy path', () => {
    it('should record a successful span', async () => {
      await span('test.operation', async () => {
        // 模拟异步操作
        await new Promise(r => setTimeout(r, 10));
        return 'result';
      });

      const spans = traceCollector.getAll();
      expect(spans).toHaveLength(1);
      expect(spans[0].name).toBe('test.operation');
      expect(spans[0].status).toBe('ok');
      expect(spans[0].duration).toBeGreaterThanOrEqual(10);
    });

    it('should support nested spans', async () => {
      await span('parent', async () => {
        await span('child1', async () => {
          await new Promise(r => setTimeout(r, 5));
        });
        await span('child2', async () => {
          await new Promise(r => setTimeout(r, 5));
        });
      });

      const spans = traceCollector.getAll();
      expect(spans).toHaveLength(3);

      const parent = spans.find(s => s.name === 'parent');
      const children = spans.filter(s => s.name === 'child1' || s.name === 'child2');

      expect(parent).toBeDefined();
      expect(children).toHaveLength(2);

      // 验证嵌套关系
      children.forEach(child => {
        expect(child.parentSpanId).toBe(parent?.spanId);
      });
    });

    it('should attach metadata to spans', async () => {
      await span('test.with.meta', async () => {}, { userId: 'user123', action: 'publish' });

      const spans = traceCollector.getAll();
      expect(spans[0].meta).toEqual({
        userId: 'user123',
        action: 'publish',
      });
    });

    it('should support concurrent spans', async () => {
      const results = await Promise.all([
        span('concurrent1', async () => {
          await new Promise(r => setTimeout(r, 5));
          return 'result1';
        }),
        span('concurrent2', async () => {
          await new Promise(r => setTimeout(r, 5));
          return 'result2';
        }),
        span('concurrent3', async () => {
          await new Promise(r => setTimeout(r, 5));
          return 'result3';
        }),
      ]);

      const spans = traceCollector.getAll();
      expect(spans).toHaveLength(3);
      expect(results).toEqual(['result1', 'result2', 'result3']);
    });
  });

  describe('Edge cases', () => {
    it('should handle zero duration spans', async () => {
      await span('instant.operation', async () => {
        // 不做任何操作
      });

      const spans = traceCollector.getAll();
      expect(spans[0].duration).toBeGreaterThanOrEqual(0);
    });

    it('should handle many spans without memory issues', async () => {
      for (let i = 0; i < 100; i++) {
        await span(`operation.${i}`, async () => {
          // 快速完成
        });
      }

      const spans = traceCollector.getAll();
      expect(spans).toHaveLength(100);
    });
  });

  describe('Error handling', () => {
    it('should record error spans with error message', async () => {
      try {
        await span('failing.operation', async () => {
          throw new Error('Test error');
        });
      } catch (error) {
        // Expected
      }

      const spans = traceCollector.getAll();
      expect(spans).toHaveLength(1);
      expect(spans[0].status).toBe('error');
      expect(spans[0].errorMessage).toBe('Test error');
    });

    it('should record error even if nested operation fails', async () => {
      try {
        await span('parent', async () => {
          await span('child', async () => {
            throw new Error('Child error');
          });
        });
      } catch (error) {
        // Expected
      }

      const spans = traceCollector.getAll();
      expect(spans).toHaveLength(2);

      const child = spans.find(s => s.name === 'child');
      const parent = spans.find(s => s.name === 'parent');

      expect(child?.status).toBe('error');
      expect(parent?.status).toBe('error');
    });
  });

  describe('Querying', () => {
    beforeEach(async () => {
      // 创建一些测试 span
      const traceId = 'test-trace-123';
      for (let i = 0; i < 5; i++) {
        await span(`operation.${i}`, async () => {
          await new Promise(r => setTimeout(r, Math.random() * 20));
        });
      }
    });

    it('should query spans by name pattern', () => {
      const results = traceCollector.query({
        name: 'operation.*',
      });

      expect(results.length).toBeGreaterThan(0);
      results.forEach(r => {
        expect(r.name).toMatch(/^operation\./);
      });
    });

    it('should query spans by status', () => {
      const results = traceCollector.query({
        status: 'ok',
      });

      expect(results.length).toBeGreaterThan(0);
      results.forEach(r => {
        expect(r.status).toBe('ok');
      });
    });

    it('should sort by duration', () => {
      const results = traceCollector.query({
        sortBy: 'duration',
        limit: 3,
      });

      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].duration).toBeGreaterThanOrEqual(results[i].duration);
      }
    });

    it('should limit results', () => {
      const results = traceCollector.query({
        limit: 2,
      });

      expect(results).toHaveLength(2);
    });

    it('should return statistics', () => {
      const stats = traceCollector.getStats();

      expect(stats.totalSpans).toBeGreaterThan(0);
      expect(stats.successRate).toMatch(/^\d+\.?\d*%$/);
      expect(stats.avgDuration).toBeDefined();
    });
  });
});
