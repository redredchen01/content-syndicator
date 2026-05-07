import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// vi.mock factories are hoisted; use vi.hoisted to share constants safely
const { TMP_AUTH_DIR } = vi.hoisted(() => ({
  TMP_AUTH_DIR: require('path').join(
    require('os').tmpdir(),
    `auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  ),
}));

vi.mock('../../browser-session', () => ({
  AUTH_DIR: TMP_AUTH_DIR,
  isBrowserAutomationEnabled: vi.fn(() => true),
  getBrowserAuthMode: vi.fn(() => 'chromium'),
  createBrowserAuthContext: vi.fn(),
  getAdapterId: (a: { name: string }) => a.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
  hasSavedBrowserSession: vi.fn(() => false),
}));

vi.mock('../../../adapters/index', () => ({
  allAdapters: [
    { name: 'Medium', isBrowserAutomation: true },
    { name: 'Substack', isBrowserAutomation: true },
    { name: 'Dev.to', isBrowserAutomation: false, config: { composeUrl: 'https://dev.to/new' } },
  ],
}));

vi.mock('../../../utils/browserManager', () => ({
  acquirePage: vi.fn(),
  releasePage: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(),
  },
}));

import {
  MIN_AUTH_COOKIES,
  getBrowserSessionStatus,
  prepareBrowserLogin,
  beginBrowserLoginSession,
  prepareBrowserTest,
} from '../browser-auth';
import { createBrowserAuthContext, getBrowserAuthMode } from '../../browser-session';
import { acquirePage } from '../../../utils/browserManager';

beforeEach(() => {
  vi.clearAllMocks();
  fs.mkdirSync(TMP_AUTH_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TMP_AUTH_DIR, { recursive: true, force: true });
});

describe('getBrowserSessionStatus', () => {
  it('returns exists:false when session file does not exist', () => {
    const r = getBrowserSessionStatus('nonexistent');
    expect(r).toMatchObject({
      exists: false,
      cookieCount: 0,
      minAuthCookies: MIN_AUTH_COOKIES,
      mtime: null,
      platform: 'nonexistent',
    });
  });

  it('returns exists:true with cookieCount when valid session file exists', () => {
    const file = path.join(TMP_AUTH_DIR, 'medium.json');
    fs.writeFileSync(file, JSON.stringify({ cookies: [{ a: 1 }, { b: 2 }, { c: 3 }] }));
    const r = getBrowserSessionStatus('medium');
    expect(r.exists).toBe(true);
    expect(r.cookieCount).toBe(3);
    expect(r.platform).toBe('medium');
    expect(typeof r.mtime).toBe('number');
  });

  it('reports cookieCount=0 when session file is malformed JSON', () => {
    const file = path.join(TMP_AUTH_DIR, 'corrupted.json');
    fs.writeFileSync(file, 'not-json{');
    const r = getBrowserSessionStatus('corrupted');
    expect(r.exists).toBe(true);
    expect(r.cookieCount).toBe(0);
  });

  it('normalizes platform id (lowercase + strip non-alphanumeric)', () => {
    const r = getBrowserSessionStatus('Dev.To-001');
    expect(r.platform).toBe('devto001');
  });
});

describe('prepareBrowserLogin', () => {
  it('returns 400 when platform is missing/empty', async () => {
    const r1 = await prepareBrowserLogin(undefined);
    expect(r1).toMatchObject({ ok: false, status: 400 });
    const r2 = await prepareBrowserLogin('');
    expect(r2).toMatchObject({ ok: false, status: 400 });
  });

  it('returns 400 when platform is not in LOGIN_URL_MAP and adapter has no composeUrl', async () => {
    const r = await prepareBrowserLogin('unknownplatform');
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(r.error).toMatch(/does not support browser OAuth/);
  });

  it('returns ok:true with session when known platform succeeds', async () => {
    const fakePage: any = { goto: vi.fn(), on: vi.fn(), close: vi.fn() };
    const fakeContext: any = { storageState: vi.fn(), on: vi.fn() };
    (createBrowserAuthContext as any).mockResolvedValue({
      mode: 'chromium',
      context: fakeContext,
      isConnected: () => true,
      close: vi.fn(),
    });
    (acquirePage as any).mockResolvedValue(fakePage);

    const r = await prepareBrowserLogin('medium');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('chromium');
    expect(r.message).toContain('medium');
    expect(r.session).toBeDefined();
    expect(r.session?.url).toBe('https://medium.com/m/signin');
    expect(r.session?.platform).toBe('medium');
  });

  it('returns 500 with chrome-profile hint when createBrowserAuthContext throws in profile mode', async () => {
    (getBrowserAuthMode as any).mockReturnValue('chrome-profile');
    (createBrowserAuthContext as any).mockRejectedValue(new Error('Browser launch failed'));
    const r = await prepareBrowserLogin('medium');
    expect(r).toMatchObject({ ok: false, status: 500 });
    expect(r.error).toContain('Browser launch failed');
    expect(r.error).toContain('common Chrome profile mode');
  });

  it('returns 500 without chrome-profile hint when mode is chromium', async () => {
    (getBrowserAuthMode as any).mockReturnValue('chromium');
    (createBrowserAuthContext as any).mockRejectedValue(new Error('Browser launch failed'));
    const r = await prepareBrowserLogin('medium');
    expect(r).toMatchObject({ ok: false, status: 500 });
    expect(r.error).toBe('Browser launch failed');
  });

  // Regression guard for ce:review api-contract finding: prepareBrowserLogin
  // and prepareBrowserTest must keep distinct fallback strings ('Browser auth
  // failed' vs 'Browser test failed') for errors with no .message property.
  it('prepareBrowserLogin uses "Browser auth failed" as fallback', async () => {
    (createBrowserAuthContext as any).mockRejectedValue({}); // no .message
    const r = await prepareBrowserLogin('medium');
    expect(r.error).toBe('Browser auth failed');
  });
});

describe('beginBrowserLoginSession (setInterval cleanup)', () => {
  it('clears the setInterval when context fires close event', async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');

    const closeHandlers: Array<() => void> = [];
    const fakeContext: any = {
      storageState: vi.fn().mockResolvedValue(undefined),
      on: (event: string, handler: () => void) => {
        if (event === 'close') closeHandlers.push(handler);
      },
    };
    const fakePage: any = { goto: vi.fn().mockResolvedValue(undefined), on: vi.fn() };
    const session: any = {
      authSession: {
        context: fakeContext,
        isConnected: () => true,
        mode: 'chromium',
        close: vi.fn(),
      },
      page: fakePage,
      authFilePath: path.join(TMP_AUTH_DIR, 'medium.json'),
      platform: 'medium',
      url: 'https://medium.com/m/signin',
    };

    await beginBrowserLoginSession(session);

    // Simulate context close
    expect(closeHandlers.length).toBe(1);
    closeHandlers[0]();

    expect(clearSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('clears interval when periodic save throws', async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');

    const fakeContext: any = {
      storageState: vi.fn().mockRejectedValue(new Error('disk full')),
      on: vi.fn(),
    };
    const session: any = {
      authSession: {
        context: fakeContext,
        isConnected: () => true,
        mode: 'chromium',
        close: vi.fn(),
      },
      page: { goto: vi.fn().mockResolvedValue(undefined), on: vi.fn() },
      authFilePath: path.join(TMP_AUTH_DIR, 'medium.json'),
      platform: 'medium',
      url: 'https://medium.com/m/signin',
    };

    await beginBrowserLoginSession(session);
    // Advance timer to trigger the save attempt → throws → clearInterval
    await vi.advanceTimersByTimeAsync(2100);

    expect(clearSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('prepareBrowserTest', () => {
  it('returns 400 when platform is missing', async () => {
    const r = await prepareBrowserTest(undefined);
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('returns 400 when no saved session file exists', async () => {
    // Ensure file doesn't exist
    const r = await prepareBrowserTest('nosession');
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(r.error).toMatch(/No saved session/);
  });

  it('returns ok:true with session when saved session exists', async () => {
    const file = path.join(TMP_AUTH_DIR, 'medium.json');
    fs.writeFileSync(file, JSON.stringify({ cookies: [] }));

    const fakePage: any = { goto: vi.fn(), on: vi.fn(), close: vi.fn() };
    const fakeContext: any = { storageState: vi.fn(), on: vi.fn() };
    (createBrowserAuthContext as any).mockResolvedValue({
      mode: 'chromium',
      context: fakeContext,
      isConnected: () => true,
      close: vi.fn(),
    });
    (acquirePage as any).mockResolvedValue(fakePage);

    const r = await prepareBrowserTest('medium');
    expect(r.ok).toBe(true);
    expect(r.session).toBeDefined();
    expect(r.message).toContain('Testing medium');
  });

  // Regression guard for ce:review api-contract finding: distinct fallback string.
  it('prepareBrowserTest uses "Browser test failed" as fallback (not "Browser auth failed")', async () => {
    fs.writeFileSync(path.join(TMP_AUTH_DIR, 'medium.json'), JSON.stringify({ cookies: [] }));
    (createBrowserAuthContext as any).mockRejectedValue({}); // no .message
    const r = await prepareBrowserTest('medium');
    expect(r.error).toBe('Browser test failed');
  });
});
