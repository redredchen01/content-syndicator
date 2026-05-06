import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { MediumAdapter } from '../medium';

const ORIG_ENV = { ...process.env };
const AUTH_FILE = path.join(process.cwd(), '.auth', 'medium.json');

function fakeStorageState(cookieCount: number) {
  return JSON.stringify({
    cookies: Array.from({ length: cookieCount }, (_, i) => ({
      name: `c${i}`,
      value: 'v',
      domain: 'medium.com',
      path: '/',
      expires: -1,
      httpOnly: false,
      secure: false,
      sameSite: 'Lax' as const,
    })),
    origins: [],
  });
}

describe('MediumAdapter — dual-mode', () => {
  let adapter: MediumAdapter;

  beforeEach(() => {
    process.env = { ...ORIG_ENV };
    delete process.env.MEDIUM_INTEGRATION_TOKEN;
    delete process.env.ENABLE_BROWSER_AUTOMATION;
    adapter = new MediumAdapter();
    if (fs.existsSync(AUTH_FILE)) fs.unlinkSync(AUTH_FILE);
    global.fetch = vi.fn() as any;
  });

  afterEach(() => {
    process.env = { ...ORIG_ENV };
    if (fs.existsSync(AUTH_FILE)) fs.unlinkSync(AUTH_FILE);
    vi.restoreAllMocks();
  });

  describe('flag', () => {
    it('declares supportsBrowserFallback=true', () => {
      expect(adapter.supportsBrowserFallback).toBe(true);
    });

    it('does not declare isBrowserAutomation (UI keeps API key form)', () => {
      expect(adapter.isBrowserAutomation).toBeFalsy();
    });
  });

  describe('testConnection', () => {
    it('uses API when MEDIUM_INTEGRATION_TOKEN set — ok', async () => {
      process.env.MEDIUM_INTEGRATION_TOKEN = 'tk';
      (global.fetch as any).mockResolvedValueOnce({ ok: true, status: 200 });
      const res = await adapter.testConnection();
      expect(res.ok).toBe(true);
    });

    it('uses API when MEDIUM_INTEGRATION_TOKEN set — 401', async () => {
      process.env.MEDIUM_INTEGRATION_TOKEN = 'tk';
      (global.fetch as any).mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' });
      const res = await adapter.testConnection();
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/401/);
    });

    it('falls back to browser session check when no token', async () => {
      if (!fs.existsSync(path.dirname(AUTH_FILE))) fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
      fs.writeFileSync(AUTH_FILE, fakeStorageState(8));

      const res = await adapter.testConnection();
      expect(res.ok).toBe(true);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('reports empty session when cookies < 5', async () => {
      if (!fs.existsSync(path.dirname(AUTH_FILE))) fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
      fs.writeFileSync(AUTH_FILE, fakeStorageState(2));

      const res = await adapter.testConnection();
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/empty|re-authenticate/);
    });

    it('reports corrupt session JSON', async () => {
      if (!fs.existsSync(path.dirname(AUTH_FILE))) fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
      fs.writeFileSync(AUTH_FILE, 'not-valid-json{');

      const res = await adapter.testConnection();
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/corrupt|re-authenticate/);
    });

    it('shows guidance when nothing configured', async () => {
      const res = await adapter.testConnection();
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/MEDIUM_INTEGRATION_TOKEN|浏览器登录/);
    });
  });

  describe('publish', () => {
    it('uses API path when token set', async () => {
      process.env.MEDIUM_INTEGRATION_TOKEN = 'tk';
      (global.fetch as any)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { id: 'u1' } }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { url: 'https://medium.com/p/abc' } }) });

      const res = await adapter.publish({
        title: 't',
        markdownContent: 'm',
        publishStatus: 'public',
      });
      expect(res.success).toBe(true);
      expect(res.publishedUrl).toBe('https://medium.com/p/abc');
    });

    it('returns guidance when no token, no session, no env', async () => {
      const res = await adapter.publish({ title: 't', markdownContent: 'm' });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/MEDIUM_INTEGRATION_TOKEN|浏览器登录/);
    });

    it('returns guidance when session exists but ENABLE_BROWSER_AUTOMATION not true', async () => {
      if (!fs.existsSync(path.dirname(AUTH_FILE))) fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
      fs.writeFileSync(AUTH_FILE, fakeStorageState(8));

      const res = await adapter.publish({ title: 't', markdownContent: 'm' });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/ENABLE_BROWSER_AUTOMATION|MEDIUM_INTEGRATION_TOKEN/);
    });

    it('does NOT silently fall back to browser when API token is invalid', async () => {
      process.env.MEDIUM_INTEGRATION_TOKEN = 'bad-tk';
      // Simulate API token failure during getAuthorId
      (global.fetch as any).mockResolvedValueOnce({ ok: false, status: 401 });

      const res = await adapter.publish({ title: 't', markdownContent: 'm' });
      expect(res.success).toBe(false);
      // Should bubble API failure, not switch to browser
      expect(res.error).toMatch(/Failed to fetch Medium user ID/);
    });
  });
});
