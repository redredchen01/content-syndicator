import type { Page } from 'playwright';
import type { PublishOptions } from './base';
import { PlatformAdapter } from './base';
import { DevToAdapter } from './devto';
import { TelegraphAdapter } from './telegraph';
import { MediumAdapter } from './medium';
import { HashnodeAdapter } from './hashnode';
import { GitHubAdapter } from './github';
import { BloggerAdapter } from './blogger';
import { WordPressAdapter } from './wordpress';
import { TwitterAdapter } from './twitter';
import { InstapaperAdapter } from './instapaper';
import { BrowserAutomationAdapter } from './browser';

// ─── Shared automation helpers ────────────────────────────────────────────────

async function safeClick(page: Page, selector: string, timeout = 4000): Promise<boolean> {
  try {
    await page.waitForSelector(selector, { timeout });
    await page.click(selector);
    return true;
  } catch { return false; }
}

async function safeFill(page: Page, selector: string, value: string, timeout = 5000): Promise<boolean> {
  try {
    await page.waitForSelector(selector, { timeout });
    await page.fill(selector, value);
    return true;
  } catch { return false; }
}

// Kliqqi CMS two-step submit flow (ztndz, yoursocialpeople)
function kliqqiAutomation() {
  return async (page: Page, options: PublishOptions): Promise<string | undefined> => {
    await page.waitForLoadState('networkidle').catch(() => {});

    // Step 1 — URL field
    const urlFilled = await safeFill(page, 'input[name="url"]', options.originalUrl ?? page.url());
    if (urlFilled) {
      // Some installs need a "Check URL" click before the full form renders
      const hasCheck = await page.locator('input[name="check_url"], button:has-text("Check")').isVisible({ timeout: 1500 }).catch(() => false);
      if (hasCheck) {
        await safeClick(page, 'input[name="check_url"], button:has-text("Check")');
        await page.waitForTimeout(1500);
      }
    }

    // Step 2 — title (override if auto-filled value is blank)
    const titleEl = page.locator('input[name="title"]');
    const existing = await titleEl.inputValue().catch(() => '');
    if (!existing) await safeFill(page, 'input[name="title"]', options.title);

    // Step 3 — description
    const desc = options.excerpt ?? options.markdownContent.slice(0, 350);
    await safeFill(page, 'textarea[name="description"]', desc);

    await safeClick(page, 'input[type="submit"], button[type="submit"]');
    await page.waitForTimeout(2000);
    return page.url();
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export {
  DevToAdapter, TelegraphAdapter, MediumAdapter, HashnodeAdapter,
  GitHubAdapter, BloggerAdapter, WordPressAdapter,
  TwitterAdapter, InstapaperAdapter, BrowserAutomationAdapter,
};

export const allAdapters: PlatformAdapter[] = [

  // ── API-based adapters ─────────────────────────────────────────────────────
  new TelegraphAdapter(),
  new DevToAdapter(),
  new MediumAdapter(),
  new HashnodeAdapter(),
  new GitHubAdapter(),
  new BloggerAdapter(),
  new WordPressAdapter(),
  new TwitterAdapter(),
  new InstapaperAdapter(),

  // ── Browser: article / blog platforms ─────────────────────────────────────

  new BrowserAutomationAdapter({
    name: 'Substack',
    authFileName: 'substack.json',
    composeUrl: 'https://substack.com/publish/post/new',
    customAutomation: async (page: Page, options: PublishOptions) => {
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(2000);

      // Title — Substack uses a contenteditable h1
      const titleSel = 'h1[data-placeholder], [data-testid="post-title-input"], .post-title-input';
      const titleFilled = await safeFill(page, titleSel, options.title, 8000);
      if (!titleFilled) {
        await page.locator(titleSel).first().click().catch(() => {});
        await page.keyboard.type(options.title);
      }
      await page.keyboard.press('Tab');
      await page.waitForTimeout(400);

      // Body — ProseMirror contenteditable
      const editorSel = '.ProseMirror, [contenteditable="true"][class*="editor"], .editor-input';
      const editor = page.locator(editorSel).first();
      await editor.click().catch(() => {});
      await editor.fill(options.markdownContent).catch(async () => {
        await page.keyboard.type(options.markdownContent.slice(0, 5000));
      });

      if (options.publishStatus === 'public') {
        await safeClick(page, 'button:has-text("Publish"), [data-testid="publish-button"]', 6000);
        await page.waitForTimeout(1200);
        // Confirm modal if it appears
        await safeClick(page, 'button:has-text("Publish now"), button:has-text("Confirm publish")').catch(() => {});
        await page.waitForTimeout(2000);
      } else {
        await safeClick(page, 'button:has-text("Save"), button:has-text("Save draft")', 6000);
      }
      return page.url();
    },
  }),

  new BrowserAutomationAdapter({
    name: 'Indie Hackers',
    authFileName: 'indiehackers.json',
    composeUrl: 'https://www.indiehackers.com/post/new',
    customAutomation: async (page: Page, options: PublishOptions) => {
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(1500);

      await safeFill(page, 'input[name="title"], input[placeholder*="title" i]', options.title);
      await safeFill(
        page,
        'textarea[name="body"], .ql-editor, [contenteditable="true"]',
        options.markdownContent,
        6000,
      );

      if (options.tags?.length) {
        const tagInput = page.locator('input[placeholder*="tag" i], input[name="tags"]').first();
        if (await tagInput.isVisible({ timeout: 2000 }).catch(() => false)) {
          for (const tag of options.tags.slice(0, 3)) {
            await tagInput.fill(tag);
            await page.keyboard.press('Enter');
          }
        }
      }

      if (options.publishStatus === 'public') {
        await safeClick(page, 'button[type="submit"]:not([disabled]), button:has-text("Post"), button:has-text("Publish")', 6000);
        await page.waitForTimeout(2000);
      }
      return page.url();
    },
  }),

  new BrowserAutomationAdapter({
    name: 'Quora',
    authFileName: 'quora.json',
    composeUrl: 'https://www.quora.com/spaces',
    // Quora's dynamic editor is too fragile for reliable automation — manual publish only
  }),

  new BrowserAutomationAdapter({
    name: 'Product Hunt',
    authFileName: 'producthunt.json',
    composeUrl: 'https://www.producthunt.com/discussions/new',
    customAutomation: async (page: Page, options: PublishOptions) => {
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(1500);

      await safeFill(page, 'input[name="title"], input[placeholder*="title" i]', options.title, 8000);
      await safeFill(
        page,
        'textarea[name="body"], .editor-content, .ProseMirror, [contenteditable="true"]',
        options.markdownContent,
        6000,
      );

      if (options.publishStatus === 'public') {
        await safeClick(page, 'button[type="submit"], button:has-text("Post discussion"), button:has-text("Post")', 6000);
        await page.waitForTimeout(2000);
      }
      return page.url();
    },
  }),

  // ── Browser: Kliqqi CMS link directories ──────────────────────────────────

  new BrowserAutomationAdapter({
    name: 'ztndz',
    authFileName: 'ztndz.json',
    composeUrl: 'https://ztndz.com/submit',
    customAutomation: kliqqiAutomation(),
  }),

  new BrowserAutomationAdapter({
    name: 'yoursocialpeople',
    authFileName: 'yoursocialpeople.json',
    composeUrl: 'https://yoursocialpeople.com/submit',
    customAutomation: kliqqiAutomation(),
  }),

  // ── Browser: web directories (no reliable automation — AI DOM fallback) ────

  new BrowserAutomationAdapter({
    name: 'zopedirectory',
    authFileName: 'zopedirectory.json',
    composeUrl: 'https://www.zopedirectory.com/',
  }),

  new BrowserAutomationAdapter({
    name: 'zed-directory',
    authFileName: 'zeddirectory.json',
    composeUrl: 'https://www.zed-directory.com/',
  }),

  // ── Browser: WoWonder social feed ─────────────────────────────────────────

  new BrowserAutomationAdapter({
    name: 'youslade',
    authFileName: 'youslade.json',
    composeUrl: 'https://youslade.com/',
    customAutomation: async (page: Page, options: PublishOptions) => {
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(1500);

      const postContent = options.originalUrl
        ? `${options.title}\n\n${options.markdownContent.slice(0, 500)}\n\n${options.originalUrl}`
        : `${options.title}\n\n${options.markdownContent.slice(0, 500)}`;

      const postBox = page.locator(
        'textarea[placeholder*="mind" i], [name="postText"], .post-editor, [data-placeholder*="mind" i]',
      ).first();
      await postBox.click().catch(() => {});
      await postBox.fill(postContent).catch(async () => {
        await page.keyboard.type(postContent.slice(0, 1000));
      });

      if (options.publishStatus === 'public') {
        await safeClick(page, 'button[name="post"], button:has-text("Share"), button:has-text("Post")', 5000);
        await page.waitForTimeout(2000);
      }
      return page.url();
    },
  }),
];
