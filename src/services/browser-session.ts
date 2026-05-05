import path from 'path';
import fs from 'fs';
import { chromium } from 'playwright';
import { acquirePage } from '../utils/browserManager';
import { PlatformAdapter } from '../adapters/base';

export const AUTH_DIR = path.join(process.cwd(), '.auth');
const DEFAULT_CHROME_USER_DATA_DIR = path.join(process.env.HOME || '', 'Library', 'Application Support', 'Google', 'Chrome');

export type BrowserAuthMode = 'chromium' | 'chrome-isolated' | 'chrome-profile';

export function getBrowserAuthMode(): BrowserAuthMode {
  const mode = process.env.BROWSER_AUTH_MODE;
  if (mode === 'chrome-isolated' || mode === 'chrome-profile') return mode;
  return 'chromium';
}

export function isBrowserAutomationEnabled() {
  return process.env.ENABLE_BROWSER_AUTOMATION === 'true';
}

export function getChromeProfileDir() {
  return process.env.BROWSER_AUTH_CHROME_PROFILE || 'Default';
}

export function getChromeUserDataDir() {
  return process.env.BROWSER_AUTH_CHROME_USER_DATA_DIR || DEFAULT_CHROME_USER_DATA_DIR;
}

export function getAdapterId(adapter: PlatformAdapter) {
  return adapter.name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function hasSavedBrowserSession(adapter: PlatformAdapter) {
  return fs.existsSync(path.join(AUTH_DIR, `${getAdapterId(adapter)}.json`));
}

export async function createBrowserAuthContext(platform: string) {
  const mode = getBrowserAuthMode();
  const viewport = null;
  const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

  if (mode === 'chrome-profile') {
    const context = await chromium.launchPersistentContext(getChromeUserDataDir(), {
      channel: 'chrome',
      headless: false,
      viewport,
      userAgent,
      args: [
        `--profile-directory=${getChromeProfileDir()}`,
        '--disable-blink-features=AutomationControlled',
        '--start-maximized'
      ]
    });

    return {
      mode,
      context,
      close: async () => context.close(),
      isConnected: () => Boolean(context.browser()?.isConnected())
    };
  }

  const launchOptions: any = {
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--start-maximized'
    ]
  };
  if (mode === 'chrome-isolated') launchOptions.channel = 'chrome';

  const browser = await chromium.launch(launchOptions);
  const authFile = path.join(AUTH_DIR, `${platform}.json`);
  const context = await browser.newContext({
    viewport,
    userAgent,
    ...(fs.existsSync(authFile) ? { storageState: authFile } : {})
  });

  return {
    mode,
    context,
    close: async () => browser.close(),
    isConnected: () => browser.isConnected()
  };
}

// Ensure auth directory exists on module load
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}
