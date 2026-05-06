/**
 * Shared browser-publish helper.
 *
 * Wraps the launch → newContext(storageState) → page.goto → customAutomation →
 * cleanup boilerplate so MediumAdapter's browser-fallback path can reuse the
 * same machinery as BrowserAutomationAdapter without copy-pasting 80+ lines
 * of try/finally context management.
 *
 * The caller supplies the per-platform DOM choreography as a customAutomation
 * closure. AI DOM fallback (used only by BrowserAutomationAdapter when no
 * explicit selectors or customAutomation are configured) lives in that
 * adapter itself, not in this helper.
 */

import type { Page } from 'playwright';
import fs from 'fs';
import { logger } from '../utils/logger';
import { getBrowser, acquirePage, releasePage } from '../utils/browserManager';
import type { PublishOptions, PublishResult } from '../adapters/base';

export interface ExecuteBrowserPublishOptions {
  /** Adapter display name for logs and result.platform */
  name: string;
  /** Absolute path to the Playwright storageState JSON */
  authFile: string;
  /** URL to navigate to before running customAutomation */
  composeUrl: string;
  /** Per-platform DOM choreography. Returns the published URL when known. */
  customAutomation: (page: Page, options: PublishOptions) => Promise<string | undefined>;
  /** Publish payload */
  options: PublishOptions;
}

export async function executeBrowserPublish(
  opts: ExecuteBrowserPublishOptions,
): Promise<PublishResult> {
  const { name, authFile, composeUrl, customAutomation, options } = opts;

  if (process.env.ENABLE_BROWSER_AUTOMATION !== 'true') {
    return {
      platform: name,
      success: false,
      error: 'Browser automation is disabled. Set ENABLE_BROWSER_AUTOMATION=true to enable.',
    };
  }

  if (!fs.existsSync(authFile)) {
    return {
      platform: name,
      success: false,
      error: `Please authenticate first using 1-Click Connect for ${name}`,
    };
  }

  let context;
  let page;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({ storageState: authFile });
    page = await acquirePage(context);

    logger.info(`[${name}] Navigating to compose URL...`);
    await page.goto(composeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);

    logger.info(`[${name}] Running custom automation...`);
    const publishedUrl = await customAutomation(page, options);
    return {
      platform: name,
      success: true,
      publishedUrl: publishedUrl ?? `Auto-Published on ${name}`,
    };
  } catch (error: any) {
    logger.error(`[${name}] Publish failed`, error);
    return {
      platform: name,
      success: false,
      error: error?.message ?? String(error),
    };
  } finally {
    if (page) await releasePage(page).catch(() => {});
    await context?.close();
  }
}
