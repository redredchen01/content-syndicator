import { describe, it, expect, afterEach } from 'vitest';
import { isLoopbackRequest, loopbackOnly } from '../loopback-only';
import type { Request, Response, NextFunction } from 'express';

const ORIG_ENV = { ...process.env };

function fakeReq(ip: string): Request {
  return { ip, socket: { remoteAddress: ip } } as unknown as Request;
}

function fakeRes() {
  let status = 200;
  let body: any = null;
  const res = {
    status(code: number) { status = code; return res; },
    json(b: any) { body = b; return res; },
    get _status() { return status; },
    get _body() { return body; },
  };
  return res as unknown as Response & { _status: number; _body: any };
}

describe('loopback-only middleware', () => {
  afterEach(() => {
    process.env = { ...ORIG_ENV };
  });

  describe('isLoopbackRequest', () => {
    it('accepts IPv4 loopback', () => {
      expect(isLoopbackRequest(fakeReq('127.0.0.1'))).toBe(true);
    });
    it('accepts IPv6 loopback', () => {
      expect(isLoopbackRequest(fakeReq('::1'))).toBe(true);
    });
    it('accepts IPv4-mapped IPv6 loopback', () => {
      expect(isLoopbackRequest(fakeReq('::ffff:127.0.0.1'))).toBe(true);
    });
    it('rejects LAN IPs', () => {
      expect(isLoopbackRequest(fakeReq('192.168.1.50'))).toBe(false);
    });
    it('rejects public IPs', () => {
      expect(isLoopbackRequest(fakeReq('8.8.8.8'))).toBe(false);
    });
    it('rejects empty IP', () => {
      expect(isLoopbackRequest(fakeReq(''))).toBe(false);
    });
  });

  describe('loopbackOnly handler', () => {
    it('calls next() for loopback requests', () => {
      let called = false;
      const next: NextFunction = () => { called = true; };
      loopbackOnly(fakeReq('127.0.0.1'), fakeRes(), next);
      expect(called).toBe(true);
    });

    it('responds 403 for non-loopback', () => {
      let called = false;
      const next: NextFunction = () => { called = true; };
      const res = fakeRes();
      loopbackOnly(fakeReq('192.168.1.50'), res, next);
      expect(called).toBe(false);
      expect(res._status).toBe(403);
      expect(res._body.error).toMatch(/loopback/i);
      expect(res._body.error).toMatch(/OAUTH_ALLOW_REMOTE/);
    });

    it('bypasses check when OAUTH_ALLOW_REMOTE=true', () => {
      process.env.OAUTH_ALLOW_REMOTE = 'true';
      let called = false;
      const next: NextFunction = () => { called = true; };
      loopbackOnly(fakeReq('8.8.8.8'), fakeRes(), next);
      expect(called).toBe(true);
    });

    it('does not bypass when OAUTH_ALLOW_REMOTE has any other value', () => {
      process.env.OAUTH_ALLOW_REMOTE = '1';
      let called = false;
      const next: NextFunction = () => { called = true; };
      const res = fakeRes();
      loopbackOnly(fakeReq('8.8.8.8'), res, next);
      expect(called).toBe(false);
      expect(res._status).toBe(403);
    });
  });
});
