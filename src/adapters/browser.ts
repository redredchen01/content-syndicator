import { type Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import { BaseAdapter, PublishResult, PublishOptions, TestConnectionResult } from './base';
import { logger } from '../utils/logger';
import { getBrowser, acquirePage, releasePage } from '../utils/browserManager';
import { analyzeDOMForSelectors } from '../llm';
import { executeBrowserPublish } from '../services/browser-publish';

export interface BrowserAutomationConfig {
  name: string;
  authFileName: string;
  composeUrl: string;
  titleSelector?: string;
  contentSelector?: string;
  publishButtonSelector?: string;
  customAutomation?: (page: Page, options: PublishOptions) => Promise<string | undefined>;
}

export class BrowserAutomationAdapter extends BaseAdapter {
  name: string;
  isBrowserAutomation = true;
  canPublishAutomatically: boolean;
  private config: BrowserAutomationConfig;

  constructor(config: BrowserAutomationConfig) {
    super();
    this.name = config.name;
    this.config = config;
    this.canPublishAutomatically = Boolean(
      config.customAutomation ||
      (config.titleSelector && config.contentSelector && config.publishButtonSelector),
    );
  }

  async testConnection(): Promise<TestConnectionResult> {
    const cleanId = this.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const authFile = path.join(process.cwd(), '.auth', `${cleanId}.json`);

    if (!fs.existsSync(authFile)) {
      return { ok: false, error: `No saved login session found for ${this.name}. Please authenticate using 1-Click Connect.` };
    }

    if (process.env.ENABLE_BROWSER_AUTOMATION !== 'true') {
      return { ok: false, error: 'Browser automation is disabled. Set ENABLE_BROWSER_AUTOMATION=true to enable.' };
    }

    const LOGIN_URL_RE = /\/login\b|\/sign[-_]?in\b|\/auth\b|\/account\/login/i;

    let context;
    let page;
    try {
      const browser = await getBrowser();
      context = await browser.newContext({ storageState: authFile });
      page = await acquirePage(context);

      await page.goto(this.config.composeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

      if (LOGIN_URL_RE.test(page.url())) {
        return { ok: false, error: 'Session expired — please re-authenticate via 1-Click Connect' };
      }
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: `Failed to load session: ${error?.message ?? String(error)}` };
    } finally {
      if (page) await releasePage(page).catch(() => {});
      await context?.close();
    }
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const cleanId = this.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const authFile = path.join(process.cwd(), '.auth', `${cleanId}.json`);

    if (!this.canPublishAutomatically) {
      return {
        platform: this.name,
        success: false,
        error: `${this.name} has saved login cookies, but no stable publishing automation is configured yet.`,
      };
    }

    return executeBrowserPublish({
      name: this.name,
      authFile,
      composeUrl: this.config.composeUrl,
      options,
      customAutomation: this.config.customAutomation ?? this.buildSelectorAutomation(),
    });
  }

  /** Builds a customAutomation closure that uses configured selectors,
   *  falling back to AI DOM analysis if any selector is missing. */
  private buildSelectorAutomation() {
    return async (page: Page, options: PublishOptions): Promise<string | undefined> => {
      logger.info(`[${this.name}] Running DOM automation...`);
      let { titleSelector, contentSelector, publishButtonSelector } = this.config;

      if (!titleSelector || !contentSelector || !publishButtonSelector) {
        logger.warn(`[${this.name}] Missing selectors — running AI DOM analysis...`);
        await page.waitForTimeout(3000);

        const domSnapshot = await page.evaluate(() => {
          const els = document.querySelectorAll(
            'input, textarea, button, [contenteditable="true"], [role="textbox"], [role="button"], a',
          );
          let output = '';
          els.forEach(el => {
            const e = el as HTMLElement;
            if (e.offsetWidth === 0 && e.offsetHeight === 0) return;
            const tag = e.tagName.toLowerCase();
            const attrs = [
              e.id && `id="${e.id}"`,
              e.className && typeof e.className === 'string' && `class="${e.className}"`,
              e.getAttribute('name') && `name="${e.getAttribute('name')}"`,
              e.getAttribute('type') && `type="${e.getAttribute('type')}"`,
              e.getAttribute('placeholder') && `placeholder="${e.getAttribute('placeholder')}"`,
              e.getAttribute('aria-label') && `aria-label="${e.getAttribute('aria-label')}"`,
              e.getAttribute('data-testid') && `data-testid="${e.getAttribute('data-testid')}"`,
            ].filter(Boolean).join(' ');
            const text = (e.innerText || e.getAttribute('value') || '').substring(0, 40).replace(/\n/g, ' ');
            output += `<${tag} ${attrs}>${text}</${tag}>\n`;
          });
          return output;
        });

        if (!domSnapshot) throw new Error('Could not extract any interactive DOM elements.');
        const ai = await analyzeDOMForSelectors(domSnapshot.substring(0, 30000), this.name);
        titleSelector = ai.titleSelector;
        contentSelector = ai.contentSelector;
        publishButtonSelector = ai.publishButtonSelector;
        logger.info(`[${this.name}] AI selectors: title=${titleSelector} content=${contentSelector} btn=${publishButtonSelector}`);
      }

      if (!titleSelector || !contentSelector || !publishButtonSelector) {
        throw new Error(`AI was unable to find required DOM selectors for ${this.name}.`);
      }

      try {
        await page.waitForSelector(titleSelector, { timeout: 10000 });
        await page.fill(titleSelector, options.title);
      } catch { logger.warn(`[${this.name}] Failed to fill title (${titleSelector})`); }

      try {
        await page.waitForSelector(contentSelector, { timeout: 5000 });
        await page.fill(contentSelector, this.withAttribution(options.markdownContent, options.originalUrl));
      } catch { logger.warn(`[${this.name}] Failed to fill content (${contentSelector})`); }

      if (options.publishStatus === 'public') {
        await page.click(publishButtonSelector);
        await page.waitForTimeout(5000);
      } else {
        logger.info(`[${this.name}] Draft mode — skipped publish click.`);
      }

      return page.url() !== this.config.composeUrl ? page.url() : undefined;
    };
  }
}
