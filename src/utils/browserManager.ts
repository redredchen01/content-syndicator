import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { logger } from './logger';
import { CONCURRENCY_CONFIG } from '../constants';

let globalBrowser: Browser | null = null;
let _launchingPromise: Promise<Browser> | null = null;

let activePages = 0;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function getBrowser(): Promise<Browser> {
  if (globalBrowser && globalBrowser.isConnected()) return globalBrowser;

  // Serialize concurrent launch requests — only one Chromium process starts
  if (!_launchingPromise) {
    _launchingPromise = chromium
      .launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
        ],
      })
      .then(b => {
        globalBrowser = b;
        _launchingPromise = null;
        logger.info('Initializing shared headless browser pool...');
        return b;
      });
  }

  return _launchingPromise;
}

/**
 * Acquire a page from the given context, enforcing BROWSER_MAX_TABS concurrency.
 * Always release via page.close() — the provided wrapper handles the counter.
 */
export async function acquirePage(context: BrowserContext): Promise<Page> {
  while (activePages >= CONCURRENCY_CONFIG.BROWSER_MAX_TABS) {
    await sleep(100);
  }
  activePages++;
  try {
    return await context.newPage();
  } catch (e) {
    activePages--;
    throw e;
  }
}

/**
 * Close a page and decrement the concurrency counter.
 * Prefer this over page.close() directly so the counter stays accurate.
 */
export async function releasePage(page: Page): Promise<void> {
  try {
    await page.close();
  } finally {
    activePages--;
  }
}

export async function closeBrowser(): Promise<void> {
  if (globalBrowser) {
    logger.info('Closing shared headless browser pool...');
    await globalBrowser.close();
    globalBrowser = null;
  }
}

/** Exposed for testing only — resets concurrency counter between test runs. */
export function _resetActivePages(): void {
  activePages = 0;
}
