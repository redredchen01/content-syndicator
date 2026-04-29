import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import { PlatformAdapter, PublishResult, PublishOptions } from './base';
import { logger } from '../utils/logger';
import { getBrowser } from '../utils/browserManager';
import { analyzeDOMForSelectors } from '../llm';

export interface BrowserAutomationConfig {
  name: string;
  authFileName: string;
  composeUrl: string;
  titleSelector?: string;
  contentSelector?: string;
  publishButtonSelector?: string;
  customAutomation?: (page: Page, options: PublishOptions) => Promise<string | undefined>;
}

export class BrowserAutomationAdapter implements PlatformAdapter {
  name: string;
  isBrowserAutomation = true;
  canPublishAutomatically: boolean;
  private config: BrowserAutomationConfig;

  constructor(config: BrowserAutomationConfig) {
    this.name = config.name;
    this.config = config;
    this.canPublishAutomatically = Boolean(
      config.customAutomation ||
      (config.titleSelector && config.contentSelector && config.publishButtonSelector)
    );
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    if (process.env.ENABLE_BROWSER_AUTOMATION !== 'true') {
      return {
        platform: this.name,
        success: false,
        error: 'Browser automation is disabled. Enable it explicitly with ENABLE_BROWSER_AUTOMATION=true before selecting browser-based platforms.'
      };
    }

    const cleanId = this.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const authFile = path.join(process.cwd(), '.auth', `${cleanId}.json`);
    
    if (!fs.existsSync(authFile)) {
      return {
        platform: this.name,
        success: false,
        error: `Please authenticate first using 1-Click Connect for ${this.name}`
      };
    }

    if (!this.canPublishAutomatically) {
      return {
        platform: this.name,
        success: false,
        error: `${this.name} has saved login cookies, but no stable publishing automation is configured yet. Add platform-specific selectors/customAutomation before selecting it for auto publish.`
      };
    }

    let context;
    try {
      const browser = await getBrowser();
      context = await browser.newContext({ storageState: authFile });
      const page = await context.newPage();
      
      logger.info(`[${this.name}] Navigating to compose URL...`);
      await page.goto(this.config.composeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2000);

      // Run custom automation if provided
      if (this.config.customAutomation) {
        logger.info(`[${this.name}] Running custom automation script...`);
        const publishedUrl = await this.config.customAutomation(page, options);
        return { platform: this.name, success: true, publishedUrl };
      }

      // Default generic automation fallback
      logger.info(`[${this.name}] Running DOM automation...`);
      
      let { titleSelector, contentSelector, publishButtonSelector } = this.config;
      if (!titleSelector || !contentSelector || !publishButtonSelector) {
        logger.warn(`[${this.name}] Missing hardcoded selectors. Triggering AI-Driven DOM Analysis...`);
        
        // Ensure page is fully rendered before extracting DOM
        await page.waitForTimeout(3000);
        
        const domSnapshot = await page.evaluate(() => {
          const els = document.querySelectorAll('input, textarea, button, [contenteditable="true"], [role="textbox"], [role="button"], a');
          let output = '';
          els.forEach(el => {
            const e = el as HTMLElement;
            // Ignore hidden elements
            if (e.offsetWidth === 0 && e.offsetHeight === 0) return;
            
            const tag = e.tagName.toLowerCase();
            const id = e.id ? ` id="${e.id}"` : '';
            const className = e.className && typeof e.className === 'string' ? ` class="${e.className}"` : '';
            const name = e.getAttribute('name') ? ` name="${e.getAttribute('name')}"` : '';
            const type = e.getAttribute('type') ? ` type="${e.getAttribute('type')}"` : '';
            const placeholder = e.getAttribute('placeholder') ? ` placeholder="${e.getAttribute('placeholder')}"` : '';
            const ariaLabel = e.getAttribute('aria-label') ? ` aria-label="${e.getAttribute('aria-label')}"` : '';
            const dataTestId = e.getAttribute('data-testid') ? ` data-testid="${e.getAttribute('data-testid')}"` : '';
            
            let innerText = e.innerText || e.getAttribute('value') || '';
            innerText = innerText.substring(0, 40).replace(/\n/g, ' ');
            
            output += `<${tag}${id}${className}${name}${type}${placeholder}${ariaLabel}${dataTestId}>${innerText}</${tag}>\n`;
          });
          return output;
        });

        if (!domSnapshot) throw new Error('Could not extract any interactive DOM elements.');

        // Use LLM to find the selectors
        const aiSelectors = await analyzeDOMForSelectors(domSnapshot.substring(0, 30000), this.name);
        titleSelector = aiSelectors.titleSelector;
        contentSelector = aiSelectors.contentSelector;
        publishButtonSelector = aiSelectors.publishButtonSelector;
        
        logger.success(`[${this.name}] AI Vision Found Selectors: \nTitle: ${titleSelector}\nContent: ${contentSelector}\nPublishBtn: ${publishButtonSelector}`);
      }

      if (!titleSelector || !contentSelector || !publishButtonSelector) {
        throw new Error(`AI was unable to find the required DOM selectors for ${this.name}.`);
      }

      // Fill Title
      try {
        await page.waitForSelector(titleSelector, { timeout: 10000 });
        await page.fill(titleSelector, options.title);
      } catch (e) {
        logger.warn(`Failed to fill title using selector ${titleSelector}`);
      }

      // Fill Content
      try {
        await page.waitForSelector(contentSelector, { timeout: 5000 });
        await page.fill(contentSelector, options.markdownContent + (options.originalUrl ? `\n\n> Originally published at: ${options.originalUrl}` : ''));
      } catch (e) {
        logger.warn(`Failed to fill content using selector ${contentSelector}`);
      }

      // Click Publish
      if (options.publishStatus === 'public') {
        try {
          await page.click(publishButtonSelector);
          await page.waitForTimeout(5000); // wait for request to fire and page to redirect
        } catch(e) {
          throw new Error(`Failed to click publish button using selector ${publishButtonSelector}`);
        }
      } else {
        logger.info(`[${this.name}] Draft mode: Filled content but didn't click publish.`);
      }

      return {
        platform: this.name,
        success: true,
        publishedUrl: page.url() !== this.config.composeUrl ? page.url() : `Auto-Published on ${this.name} (URL unknown)`
      };
    } catch (error: any) {
      logger.error(`[${this.name}] Browser automation failed`, error);
      return {
        platform: this.name,
        success: false,
        error: error.message
      };
    } finally {
      if (context) {
        await context.close();
      }
    }
  }
}
