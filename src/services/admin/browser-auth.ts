/**
 * services/admin/browser-auth.ts (Plan 2026-05-07-002 Unit 2)
 *
 * Browser-session login + test orchestration. Originally inline in
 * routes/admin.ts:188-331 (3 endpoints, ~145 lines containing setInterval
 * cleanup, context.on('close') wiring, hardcoded loginUrlMap, file path
 * construction).
 *
 * Architecture: prepare/begin split
 *   - `prepareXxx(...)` does validation + creates browser context (returns
 *     tagged result, throws caught and converted to 500). Synchronously safe
 *     to use in controller before sending response.
 *   - `beginXxx(session)` is the post-response async work (page.goto +
 *     setInterval + context.on close). Controller invokes after res.json()
 *     and ignores its return value (errors go to logger).
 *
 * Security invariant: ENABLE_BROWSER_AUTOMATION 403 gate stays in the
 * controller — service is publicly callable; gate must live HTTP-side.
 */

import fs from 'fs';
import path from 'path';
import type { Page } from 'playwright';
import { allAdapters } from '../../adapters/index';
import { acquirePage, releasePage } from '../../utils/browserManager';
import {
  AUTH_DIR,
  createBrowserAuthContext,
  getBrowserAuthMode,
} from '../browser-session';
import { logger } from '../../utils/logger';

export const MIN_AUTH_COOKIES = 5;

/** Curated login URLs per platform — extracted from old admin.ts:198-211. */
const LOGIN_URL_MAP: Record<string, string> = {
  medium:           'https://medium.com/m/signin',
  devto:            'https://dev.to/enter',
  google:           'https://accounts.google.com/',
  blogger:          'https://accounts.google.com/',
  substack:         'https://substack.com/sign-in',
  indiehackers:     'https://www.indiehackers.com/sign-in',
  quora:            'https://www.quora.com/',
  producthunt:      'https://www.producthunt.com/login',
  ztndz:            'https://ztndz.com/login',
  yoursocialpeople: 'https://yoursocialpeople.com/login',
  zopedirectory:    'https://www.zopedirectory.com/login',
  zeddirectory:     'https://www.zed-directory.com/login',
  youslade:         'https://youslade.com/login',
};

export interface BrowserSessionStatus {
  exists: boolean;
  cookieCount: number;
  minAuthCookies: number;
  mtime: number | null;
  platform: string;
}

/** GET /api/auth/browser/status/:platform — pure FS read, never throws. */
export function getBrowserSessionStatus(platform: string): BrowserSessionStatus {
  const cleanId = String(platform).toLowerCase().replace(/[^a-z0-9]/g, '');
  const authFile = path.join(AUTH_DIR, `${cleanId}.json`);

  try {
    const stat = fs.statSync(authFile);
    const raw = fs.readFileSync(authFile, 'utf-8');
    let cookieCount = 0;
    try {
      const parsed = JSON.parse(raw);
      cookieCount = Array.isArray(parsed.cookies) ? parsed.cookies.length : 0;
    } catch { /* malformed JSON, cookieCount stays 0 */ }

    return {
      exists: true,
      cookieCount,
      minAuthCookies: MIN_AUTH_COOKIES,
      mtime: stat.mtimeMs,
      platform: cleanId,
    };
  } catch {
    return { exists: false, cookieCount: 0, minAuthCookies: MIN_AUTH_COOKIES, mtime: null, platform: cleanId };
  }
}

/** Internal: handle to a started browser session, passed prepare → begin. */
export interface PreparedSession {
  authSession: Awaited<ReturnType<typeof createBrowserAuthContext>>;
  page: Page;
  authFilePath: string;
  platform: string;
  url: string;
}

export interface PrepareResult {
  ok: boolean;
  status?: 400 | 500;
  error?: string;
  session?: PreparedSession;
  message?: string;
}

/**
 * Append the chrome-profile mode hint when relevant. Mirrors the formatting
 * from old admin.ts:413-415, 451-453. The fallback message preserves the
 * endpoint-specific default ('Browser auth failed' for /api/auth/browser,
 * 'Browser test failed' for /api/auth/test) so existing UI code that asserts
 * on those exact strings keeps working.
 */
function formatBrowserError(error: unknown, defaultMessage: string): string {
  const message = (error as any)?.message || defaultMessage;
  const profileHint = getBrowserAuthMode() === 'chrome-profile'
    ? ' If you selected common Chrome profile mode, close all Chrome windows first or switch to Installed Chrome, separate profile.'
    : '';
  return `${message}${profileHint}`;
}

/** POST /api/auth/browser — validate, resolve URL, open browser. */
export async function prepareBrowserLogin(platform: unknown): Promise<PrepareResult> {
  if (typeof platform !== 'string' || platform.length === 0) {
    return { ok: false, status: 400, error: 'platform is required' };
  }

  const adapter: any = allAdapters.find(a => a.name.toLowerCase().replace(/[^a-z0-9]/g, '') === platform);

  const loginUrl = LOGIN_URL_MAP[platform] ?? (adapter?.config?.composeUrl ?? '');
  if (!loginUrl) {
    const platformName = adapter?.name || platform;
    return {
      ok: false,
      status: 400,
      error: `${platformName} does not support browser OAuth in this app. Configure it in Publishing Platforms with its API token/application password instead.`,
    };
  }

  try {
    const authSession = await createBrowserAuthContext(platform);
    const context = authSession.context;
    const page = await acquirePage(context);
    const authFilePath = path.join(AUTH_DIR, `${platform}.json`);

    return {
      ok: true,
      message: `Opened ${authSession.mode} for ${platform}. Please log in and close the window to save your session.`,
      session: { authSession, page, authFilePath, platform, url: loginUrl },
    };
  } catch (error: unknown) {
    logger.error('Browser Auth Error', error as any);
    return { ok: false, status: 500, error: formatBrowserError(error, 'Browser auth failed') };
  }
}

/**
 * POST /api/auth/browser begin: navigate to login URL, periodically save
 * session state until the browser context closes. Fire-and-forget — caller
 * (controller) sends the response then invokes this without awaiting.
 *
 * setInterval is cleared in two paths: (a) save attempt fails, (b) context
 * fires its 'close' event. Both mark the periodic save complete.
 */
export async function beginBrowserLoginSession(session: PreparedSession): Promise<void> {
  const { authSession, page, authFilePath, platform, url } = session;
  const context = authSession.context;

  await page.goto(url);

  const saveInterval = setInterval(async () => {
    try {
      if (context && authSession.isConnected()) {
        await context.storageState({ path: authFilePath });
      } else {
        clearInterval(saveInterval);
      }
    } catch (e) {
      clearInterval(saveInterval);
    }
  }, 2000);

  context.on('close', () => {
    clearInterval(saveInterval);
    logger.success(`Browser closed for ${platform}. Cookies were saved periodically.`);
  });
}

/** POST /api/auth/test — validate saved session exists, open test URL. */
export async function prepareBrowserTest(platform: unknown): Promise<PrepareResult> {
  if (typeof platform !== 'string' || platform.length === 0) {
    return { ok: false, status: 400, error: 'platform is required' };
  }

  const authFile = path.join(AUTH_DIR, `${platform}.json`);
  if (!fs.existsSync(authFile)) {
    return { ok: false, status: 400, error: `No saved session found for ${platform}. Please Connect first.` };
  }

  const adapter: any = allAdapters.find(a => a.name.toLowerCase().replace(/[^a-z0-9]/g, '') === platform);
  const testUrl = adapter?.config?.composeUrl || 'https://google.com';

  try {
    const authSession = await createBrowserAuthContext(platform);
    const context = authSession.context;
    const page = await acquirePage(context);

    return {
      ok: true,
      message: `Testing ${platform} session in ${authSession.mode}. If you see the editor/dashboard, your cookies are valid!`,
      session: { authSession, page, authFilePath: authFile, platform, url: testUrl },
    };
  } catch (error: unknown) {
    logger.error('Browser Test Auth Error', error as any);
    return { ok: false, status: 500, error: formatBrowserError(error, 'Browser test failed') };
  }
}

/**
 * POST /api/auth/test begin: navigate to test URL, persist storage state
 * when the page closes, release Playwright resources. Fire-and-forget.
 */
export async function beginBrowserTestSession(session: PreparedSession): Promise<void> {
  const { authSession, page, authFilePath, url } = session;
  const context = authSession.context;

  await page.goto(url);

  page.on('close', async () => {
    releasePage(page).catch(() => { /* ignore */ });
    try {
      await context.storageState({ path: authFilePath });
    } catch (e) { /* ignore */ }
    await authSession.close();
  });
}
