/**
 * Loopback-only request gate for ops endpoints.
 *
 * Single-tenant deployment is the default — admin and OAuth-management
 * endpoints assume the operator runs the server locally and connects via
 * 127.0.0.1. Without this gate, anyone with network reachability to the
 * server (LAN, exposed port, misconfigured proxy) could disconnect OAuth
 * tokens (`DELETE /api/auth/oauth/...`) or trigger consent-flow spam.
 *
 * Set `OAUTH_ALLOW_REMOTE=true` to opt out — required when deploying behind
 * a reverse proxy that supplies its own authentication. The flag is named
 * deliberately so that flipping it forces the operator to acknowledge they
 * are taking responsibility for upstream auth.
 *
 * Express trusts X-Forwarded-For only when `app.set('trust proxy', ...)` is
 * configured, which this app does not currently do — so `req.ip` is the
 * direct socket peer, immune to header spoofing in our setup.
 */

import type { Request, Response, NextFunction } from 'express';

const LOOPBACK_IPS = new Set([
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
]);

export function isLoopbackRequest(req: Request): boolean {
  const ip = req.ip || req.socket?.remoteAddress || '';
  return LOOPBACK_IPS.has(ip);
}

export function loopbackOnly(req: Request, res: Response, next: NextFunction) {
  if (process.env.OAUTH_ALLOW_REMOTE === 'true') {
    return next();
  }
  if (isLoopbackRequest(req)) {
    return next();
  }
  res.status(403).json({
    error: 'This endpoint is restricted to loopback (127.0.0.1) by default. ' +
           'Set OAUTH_ALLOW_REMOTE=true to allow remote access — only do this ' +
           'when the server sits behind a reverse proxy that enforces its own ' +
           'authentication.',
  });
}
