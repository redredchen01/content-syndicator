import path from 'path';
import fs from 'fs';
import type { Page } from 'playwright';
import { BaseAdapter, PublishResult, PublishOptions, TestConnectionResult } from './base';
import { executeBrowserPublish } from '../services/browser-publish';

const MEDIUM_COMPOSE_URL = 'https://medium.com/new-story';
const AUTH_FILE = path.join(process.cwd(), '.auth', 'medium.json');
const MEDIUM_API_TIMEOUT_MS = 15_000;
// Mirrors the storageState cookie threshold used by the browser-fallback poll
// (see admin.ts MIN_AUTH_COOKIES). Below this count we treat the saved
// session as empty / pre-login.
const MIN_VALID_SESSION_COOKIES = 5;

export class MediumAdapter extends BaseAdapter {
  name = 'Medium';
  /** Tells the UI to render a secondary "use browser login" link
   *  alongside the API key form. Distinct from isBrowserAutomation. */
  supportsBrowserFallback = true;

  private authorId?: string;

  private async getAuthorId(token: string): Promise<string> {
    if (this.authorId) return this.authorId;
    const res = await fetch('https://api.medium.com/v1/me', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(MEDIUM_API_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error('Failed to fetch Medium user ID');
    const data = await res.json();
    this.authorId = data.data.id;
    return this.authorId!;
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const token = process.env.MEDIUM_INTEGRATION_TOKEN;
    if (token) return this.publishViaApi(token, options);

    if (fs.existsSync(AUTH_FILE) && process.env.ENABLE_BROWSER_AUTOMATION === 'true') {
      return executeBrowserPublish({
        name: this.name,
        authFile: AUTH_FILE,
        composeUrl: MEDIUM_COMPOSE_URL,
        customAutomation: this.browserAutomation,
        options,
      });
    }

    return {
      platform: this.name,
      success: false,
      error: 'Medium 未配置：请设置 MEDIUM_INTEGRATION_TOKEN（旧 token 仍可用），' +
             '或在 admin 页点击 Medium 卡片的「使用浏览器登录」并启用 ENABLE_BROWSER_AUTOMATION=true',
    };
  }

  async testConnection(): Promise<TestConnectionResult> {
    const token = process.env.MEDIUM_INTEGRATION_TOKEN;

    // API path
    if (token) {
      try {
        const response = await fetch('https://api.medium.com/v1/me', {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(MEDIUM_API_TIMEOUT_MS),
        });
        if (!response.ok) {
          return { ok: false, error: `${response.status} ${response.statusText}` };
        }
        return { ok: true };
      } catch (error: any) {
        return { ok: false, error: `Network error: ${error.message}` };
      }
    }

    // Browser-fallback path — lightweight check (file exists + valid JSON shape)
    // Avoid launching a browser here; users explicitly verify via "Test
    // connection" which can run a heavier check separately.
    if (fs.existsSync(AUTH_FILE)) {
      try {
        const raw = fs.readFileSync(AUTH_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.cookies) && parsed.cookies.length >= MIN_VALID_SESSION_COOKIES) {
          return { ok: true };
        }
        return { ok: false, error: 'Browser session looks empty — please re-authenticate.' };
      } catch {
        return { ok: false, error: 'Saved browser session is corrupt — please re-authenticate.' };
      }
    }

    return {
      ok: false,
      error: 'Medium 未配置：请设置 MEDIUM_INTEGRATION_TOKEN 或点击「使用浏览器登录」',
    };
  }

  private async publishViaApi(token: string, options: PublishOptions): Promise<PublishResult> {
    const { title, markdownContent, originalUrl, publishStatus = 'draft', tags } = options;
    try {
      const authorId = await this.getAuthorId(token);
      const response = await fetch(`https://api.medium.com/v1/users/${authorId}/posts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          title,
          contentFormat: 'markdown',
          content: markdownContent,
          canonicalUrl: originalUrl || '',
          tags: tags?.slice(0, 5),
          publishStatus: publishStatus === 'public' ? 'public' : 'draft',
        }),
        signal: AbortSignal.timeout(MEDIUM_API_TIMEOUT_MS),
      });

      const data = await response.json();
      if (response.ok) return this.ok(data.data.url);
      throw new Error(data.errors?.[0]?.message || 'Failed to publish to Medium');
    } catch (error: any) {
      return this.fail(error);
    }
  }

  /** Medium-specific Playwright DOM choreography. Multiple selectors per
   *  field guard against editor-class name churn. */
  private browserAutomation = async (page: Page, options: PublishOptions): Promise<string | undefined> => {
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1500);

    // Strip control characters from the title so a stray newline does not
    // break out of the contenteditable h3 (page.keyboard.type would treat
    // \n as Enter, splitting the title block).
    const sanitizedTitle = options.title.replace(/[\r\n\t\f\v]+/g, ' ').trim();

    // Title — Medium uses a contenteditable h3 for the title placeholder
    const titleSel = 'h3[data-testid="editorTitleParagraph"], h3.graf--title, [data-default-value*="Title" i]';
    try {
      await page.waitForSelector(titleSel, { timeout: 8000 });
      await page.click(titleSel);
      await page.keyboard.type(sanitizedTitle);
    } catch {
      // Hard fallback — focus and type
      await page.keyboard.type(sanitizedTitle);
    }

    // Tab moves focus from title to body editor
    await page.keyboard.press('Tab');
    await page.waitForTimeout(400);

    // Body — contenteditable below title. Use locator.fill() which handles
    // long content and special characters more reliably than keyboard.type
    // (no silent truncation; handles \n as soft breaks rather than Enter).
    const body = options.originalUrl
      ? `${options.markdownContent}\n\nOriginally published at: ${options.originalUrl}`
      : options.markdownContent;
    const editor = page.locator(
      '[data-testid="editorBodyParagraph"], .ProseMirror, [contenteditable="true"]',
    ).first();
    try {
      await editor.fill(body);
    } catch {
      // Fallback to keyboard.type in chunks if fill is unsupported on the editor
      const CHUNK = 4000;
      for (let i = 0; i < body.length; i += CHUNK) {
        await page.keyboard.type(body.slice(i, i + CHUNK));
      }
    }

    if (options.publishStatus === 'public') {
      // Open publish menu
      const publishBtn = 'button[data-action="show-prepublish"], button:has-text("Publish")';
      try {
        await page.waitForSelector(publishBtn, { timeout: 6000 });
        await page.click(publishBtn);
        await page.waitForTimeout(1500);
      } catch {
        // Some Medium variants nest publish in a kebab menu — best-effort
      }

      // Confirm publish
      const confirmBtn = 'button[data-action="publish"], button:has-text("Publish now")';
      try {
        await page.waitForSelector(confirmBtn, { timeout: 6000 });
        await page.click(confirmBtn);
        await page.waitForTimeout(3000);
      } catch {
        // Confirmation modal didn't appear; URL check below will indicate state
      }
    }
    // Draft: Medium auto-saves; closing the page in cleanup is enough.

    return page.url() !== MEDIUM_COMPOSE_URL ? page.url() : undefined;
  };
}
