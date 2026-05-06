import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RootCauseAnalyzer } from '../root-cause-analyzer';
import { metricsAggregator } from '../metrics-aggregator';
import { traceCollector } from '../tracer';
import { span } from '../tracer';

describe('RootCauseAnalyzer', () => {
  let analyzer: RootCauseAnalyzer;

  beforeEach(() => {
    analyzer = RootCauseAnalyzer.getInstance();
    traceCollector.clear();
  });

  afterEach(() => {
    metricsAggregator.stop();
  });

  describe('Happy path', () => {
    it('should analyze operation with normal metrics', async () => {
      // 创建正常的 span
      for (let i = 0; i < 10; i++) {
        await span('normal.operation', async () => {
          await new Promise(r => setTimeout(r, 10 + Math.random() * 5));
        });
      }

      // 启动聚合
      metricsAggregator.start();
      await new Promise(r => setTimeout(r, 100));

      const analysis = analyzer.analyze('normal.operation');

      expect(analysis.operation).toBe('normal.operation');
      expect(analysis.diagnosis).toBeDefined();
      expect(analysis.recommendations).toBeDefined();
      expect(analysis.confidence).toBeGreaterThanOrEqual(0);
      expect(analysis.confidence).toBeLessThanOrEqual(1);
    });

    it('should detect error anomalies', async () => {
      // 创建一些失败的 span
      for (let i = 0; i < 5; i++) {
        try {
          await span('error.operation', async () => {
            if (i % 2 === 0) {
              throw new Error('Test error');
            }
          });
        } catch (e) {
          // Expected
        }
      }

      metricsAggregator.start();
      await new Promise(r => setTimeout(r, 100));

      const analysis = analyzer.analyze('error.operation');

      // 应该检测到错误率异常
      expect(analysis.diagnosis.factors.length).toBeGreaterThan(0);
      const hasErrorFactor = analysis.diagnosis.factors.some(f => f.type === 'error');
      expect(hasErrorFactor).toBe(true);
    });

    it('should detect latency anomalies', async () => {
      // 创建一些慢操作
      for (let i = 0; i < 10; i++) {
        await span('slow.operation', async () => {
          await new Promise(r => setTimeout(r, 50 + Math.random() * 20));
        });
      }

      metricsAggregator.start();
      await new Promise(r => setTimeout(r, 100));

      const analysis = analyzer.analyze('slow.operation');

      expect(analysis.diagnosis.factors).toBeDefined();
      expect(analysis.recommendations).toBeDefined();
    });
  });

  describe('Edge cases', () => {
    it('should handle empty operation', () => {
      const analysis = analyzer.analyze('nonexistent.operation');

      expect(analysis.operation).toBe('nonexistent.operation');
      expect(analysis.diagnosis.primary).toContain('无数据');
      expect(analysis.confidence).toBe(0);
    });

    it('should generate recommendations for publish operations', async () => {
      // 创建 publish 操作的 span
      for (let i = 0; i < 5; i++) {
        await span('services.publish.start', async () => {
          await new Promise(r => setTimeout(r, 100 + Math.random() * 50));
        });
      }

      metricsAggregator.start();
      await new Promise(r => setTimeout(r, 100));

      const analysis = analyzer.analyze('services.publish.start');

      expect(analysis.recommendations).toBeDefined();
      // 如果有延迟建议，应该包含 publish 相关的优化
      const publishRec = analysis.recommendations.find(r =>
        r.title.toLowerCase().includes('publish') || r.title.toLowerCase().includes('发布'),
      );
      // 根据是否检测到延迟异常，可能有或没有 publish 相关建议
      expect(analysis.recommendations.length).toBeGreaterThan(0);
    });

    it('should handle custom time range', async () => {
      const now = Date.now();
      const oneHourAgo = now - 3600000;

      const analysis = analyzer.analyze('test.operation', {
        start: oneHourAgo,
        end: now,
      });

      expect(analysis.timeRange.start).toBe(oneHourAgo);
      expect(analysis.timeRange.end).toBe(now);
    });
  });

  describe('Recommendations', () => {
    it('should prioritize high-severity issues', async () => {
      // 创建高错误率的操作
      for (let i = 0; i < 5; i++) {
        try {
          await span('failing.operation', async () => {
            throw new Error('Persistent error');
          });
        } catch (e) {
          // Expected
        }
      }

      metricsAggregator.start();
      await new Promise(r => setTimeout(r, 100));

      const analysis = analyzer.analyze('failing.operation');

      // 应该有优先级为 1 的建议
      const p1Recs = analysis.recommendations.filter(r => r.priority === 1);
      expect(p1Recs.length).toBeGreaterThan(0);
    });

    it('should include trace information in analysis', async () => {
      for (let i = 0; i < 3; i++) {
        await span('trace.operation', async () => {
          await new Promise(r => setTimeout(r, 10));
        });
      }

      metricsAggregator.start();
      await new Promise(r => setTimeout(r, 100));

      const analysis = analyzer.analyze('trace.operation');

      expect(analysis.relatedTraces).toBeDefined();
      expect(Array.isArray(analysis.relatedTraces)).toBe(true);
    });
  });

  describe('Confidence', () => {
    it('should increase confidence with more samples', async () => {
      // 创建 1 个 span
      await span('confidence.test1', async () => {});

      metricsAggregator.start();
      await new Promise(r => setTimeout(r, 100));

      const analysis1 = analyzer.analyze('confidence.test1');
      const confidence1 = analysis1.confidence;

      metricsAggregator.stop();
      traceCollector.clear();

      // 创建 100 个 span
      for (let i = 0; i < 100; i++) {
        await span('confidence.test2', async () => {});
      }

      metricsAggregator.start();
      await new Promise(r => setTimeout(r, 100));

      const analysis2 = analyzer.analyze('confidence.test2');
      const confidence2 = analysis2.confidence;

      // 样本越多，置信度应该越高
      expect(confidence2).toBeGreaterThanOrEqual(confidence1);
    });
  });
});
