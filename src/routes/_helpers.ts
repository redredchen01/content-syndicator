import express from 'express';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';
import { runWithContext } from '../utils/context';

export type Req = express.Request;
export type Res = express.Response;

function getOrCreateContextId(req: Req): string {
  const headerContextId = req.headers['x-request-id'] || req.headers['x-context-id'];
  if (typeof headerContextId === 'string' && headerContextId.trim()) {
    return headerContextId;
  }
  return randomUUID();
}

export function asyncRoute(fn: (req: Req, res: Res) => Promise<unknown>) {
  return async (req: Req, res: Res) => {
    const contextId = getOrCreateContextId(req);
    try {
      await runWithContext(contextId, async () => {
        await fn(req, res);
      });
    } catch (error: any) {
      logger.error('route.handler.error', {
        method: req.method,
        path: req.path,
        message: error.message,
      });
      if (!res.headersSent) res.status(500).json({ error: error.message });
    }
  };
}

export function syncRoute(fn: (req: Req, res: Res) => unknown) {
  return (req: Req, res: Res) => {
    const contextId = getOrCreateContextId(req);
    try {
      // For sync routes, we can't use runWithContext since it's async
      // Instead, create context directly
      const { createRequestContext } = require('../utils/context');
      createRequestContext(contextId);
      fn(req, res);
    } catch (error: any) {
      logger.error('route.handler.error', {
        method: req.method,
        path: req.path,
        message: error.message,
      });
      if (!res.headersSent) res.status(500).json({ error: error.message });
    }
  };
}
