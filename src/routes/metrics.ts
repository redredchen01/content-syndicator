import express from 'express';
import { asyncRoute, Req, Res } from './_helpers';
import { systemMonitor } from '../utils/systemMonitor';
import { metricsAggregator } from '../utils/metrics-aggregator';
import { traceCollector } from '../utils/tracer';
import { rootCauseAnalyzer } from '../utils/root-cause-analyzer';
import { logger } from '../utils/logger';

const router = express.Router();

/**
 * 解析时间范围参数（如 "1h", "6h", "24h"）
 */
function parseTimeRange(since: string | string[] | undefined): { start: number; end: number } {
  if (!since || typeof since !== 'string') {
    // 默认 1 小时
    const now = Date.now();
    return { start: now - 3600000, end: now };
  }

  const now = Date.now();
  const match = since.match(/^(\d+)([smhdw])$/);

  if (!match) {
    // 默认
    return { start: now - 3600000, end: now };
  }

  const [, value, unit] = match;
  const num = parseInt(value, 10);

  const unitMs: Record<string, number> = {
    s: 1000,
    m: 60000,
    h: 3600000,
    d: 86400000,
    w: 604800000,
  };

  const ms = unitMs[unit] || 3600000;

  return {
    start: now - num * ms,
    end: now,
  };
}

/**
 * GET /api/stats
 * 返回实时系统统计信息
 */
router.get(
  '/stats',
  asyncRoute(async (req: Req, res: Res) => {
    logger.info('metrics.stats.request');

    const stats = systemMonitor.getStats();
    const aggregatorStats = metricsAggregator.getStats();

    res.json({
      ok: true,
      data: {
        timestamp: Date.now(),
        systemMonitor: stats,
        metricsAggregator: aggregatorStats,
      },
    });
  }),
);

/**
 * GET /api/metrics
 * 查询聚合指标
 * 参数：
 *  - operation: 操作名称（支持 * 通配符）
 *  - since: 时间范围（如 "1h", "6h", "24h"）
 *  - limit: 结果数量限制
 */
router.get(
  '/metrics',
  asyncRoute(async (req: Req, res: Res) => {
    const { operation, since = '1h', limit = 50 } = req.query;

    logger.info('metrics.metrics.request', {
      operation,
      since,
      limit,
    });

    const timeRange = parseTimeRange(since as string);
    const limitNum = Math.min(Math.max(1, parseInt(limit as string, 10)), 1000);

    try {
      let query: any = {
        timeRange,
        limit: limitNum,
      };

      if (operation && typeof operation === 'string') {
        query.operation = operation;
      }

      const results = metricsAggregator.query(query);

      res.json({
        ok: true,
        data: {
          query: { operation, since, limit: limitNum },
          timeRange,
          results,
          count: results.length,
          generatedAt: Date.now(),
        },
      });
    } catch (error: any) {
      logger.error('metrics.metrics.error', {
        error: error.message,
        operation,
      });

      res.status(400).json({
        ok: false,
        error: error.message,
      });
    }
  }),
);

/**
 * GET /api/traces
 * 查询追踪 span
 * 参数：
 *  - traceId: 追踪 ID
 *  - contextId: 上下文 ID
 *  - name: span 名称（支持 * 通配符）
 *  - since: 时间范围
 *  - limit: 结果数量限制
 */
router.get(
  '/traces',
  asyncRoute(async (req: Req, res: Res) => {
    const { traceId, contextId, name, since = '1h', limit = 50 } = req.query;

    logger.info('metrics.traces.request', {
      traceId,
      contextId,
      name,
      since,
      limit,
    });

    try {
      const timeRange = parseTimeRange(since as string);
      const limitNum = Math.min(Math.max(1, parseInt(limit as string, 10)), 100);

      const query: any = {
        timeRange,
        limit: limitNum,
      };

      if (traceId && typeof traceId === 'string') {
        query.traceId = traceId;
      }

      if (contextId && typeof contextId === 'string') {
        query.contextId = contextId;
      }

      if (name && typeof name === 'string') {
        query.name = name;
      }

      const traces = traceCollector.query(query);

      res.json({
        ok: true,
        data: {
          query: { traceId, contextId, name, since, limit: limitNum },
          timeRange,
          traces,
          count: traces.length,
          generatedAt: Date.now(),
        },
      });
    } catch (error: any) {
      logger.error('metrics.traces.error', {
        error: error.message,
      });

      res.status(400).json({
        ok: false,
        error: error.message,
      });
    }
  }),
);

/**
 * POST /api/analyze
 * 根因分析
 * 请求体：
 *  {
 *    operation: string,
 *    timeRange?: { start: number, end: number }
 *  }
 */
router.post(
  '/analyze',
  asyncRoute(async (req: Req, res: Res) => {
    const { operation, timeRange } = req.body;

    logger.info('metrics.analyze.request', {
      operation,
      timeRange,
    });

    try {
      // 验证
      if (!operation || typeof operation !== 'string') {
        return res.status(400).json({
          ok: false,
          error: 'operation is required and must be a string',
        });
      }

      // 解析时间范围
      let parsedTimeRange: { start: number; end: number } | undefined;
      if (timeRange && typeof timeRange === 'object') {
        if (typeof timeRange.start !== 'number' || typeof timeRange.end !== 'number') {
          return res.status(400).json({
            ok: false,
            error: 'timeRange must have numeric start and end properties',
          });
        }
        parsedTimeRange = timeRange;
      }

      // 执行分析
      const analysis = rootCauseAnalyzer.analyze(operation, parsedTimeRange);

      res.json({
        ok: true,
        data: analysis,
      });
    } catch (error: any) {
      logger.error('metrics.analyze.error', {
        error: error.message,
        operation,
      });

      res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }),
);

/**
 * GET /api/baselines
 * 获取性能基线信息
 */
router.get(
  '/baselines',
  asyncRoute(async (req: Req, res: Res) => {
    logger.info('metrics.baselines.request');

    try {
      const baselines = metricsAggregator.getBaselines();
      const baselineArray = Array.from(baselines.values());

      res.json({
        ok: true,
        data: {
          baselines: baselineArray,
          count: baselineArray.length,
          generatedAt: Date.now(),
        },
      });
    } catch (error: any) {
      logger.error('metrics.baselines.error', {
        error: error.message,
      });

      res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }),
);

/**
 * POST /api/metrics/start
 * 启动指标聚合
 */
router.post(
  '/metrics/start',
  asyncRoute(async (req: Req, res: Res) => {
    logger.info('metrics.aggregator.start.request');

    try {
      metricsAggregator.start();

      res.json({
        ok: true,
        message: 'Metrics aggregator started',
        data: {
          timestamp: Date.now(),
        },
      });
    } catch (error: any) {
      logger.error('metrics.aggregator.start.error', {
        error: error.message,
      });

      res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }),
);

/**
 * POST /api/metrics/stop
 * 停止指标聚合
 */
router.post(
  '/metrics/stop',
  asyncRoute(async (req: Req, res: Res) => {
    logger.info('metrics.aggregator.stop.request');

    try {
      metricsAggregator.stop();

      res.json({
        ok: true,
        message: 'Metrics aggregator stopped',
        data: {
          timestamp: Date.now(),
        },
      });
    } catch (error: any) {
      logger.error('metrics.aggregator.stop.error', {
        error: error.message,
      });

      res.status(500).json({
        ok: false,
        error: error.message,
      });
    }
  }),
);

export default router;
