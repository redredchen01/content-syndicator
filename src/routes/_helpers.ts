import express from 'express';
import { logger } from '../utils/logger';

export type Req = express.Request;
export type Res = express.Response;

export function asyncRoute(fn: (req: Req, res: Res) => Promise<unknown>) {
  return async (req: Req, res: Res) => {
    try {
      await fn(req, res);
    } catch (error: any) {
      logger.error(`${req.method} ${req.path}`, error);
      if (!res.headersSent) res.status(500).json({ error: error.message });
    }
  };
}

export function syncRoute(fn: (req: Req, res: Res) => unknown) {
  return (req: Req, res: Res) => {
    try {
      fn(req, res);
    } catch (error: any) {
      logger.error(`${req.method} ${req.path}`, error);
      res.status(500).json({ error: error.message });
    }
  };
}
