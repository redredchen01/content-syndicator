import { execFile } from 'child_process';
import util from 'util';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { logger } from '../utils/logger';
import { getBrowser, acquirePage, releasePage } from '../utils/browserManager';

const execFileAsync = util.promisify(execFile);

export interface ScrapedData {
  title: string;
  content: string; // Markdown content
  originalUrl: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}

async function fetchRawHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching raw HTML`);
  }

  const html = await response.text();
  if (!html.trim()) throw new Error('Raw HTML fetch returned an empty body');
  return html;
}

async function readStablePageHtml(page: any, url: string): Promise<string> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
      await page.waitForTimeout(1000 * attempt);
      if (attempt >= 2) {
        await page.evaluate(() => window.stop()).catch(() => undefined);
      }
      return await withTimeout(page.content(), 8000, 'page.content');
    } catch (error: any) {
      const message = error?.message || '';
      logger.warn(`[Scraper] Failed to read page content on attempt ${attempt}/5 for ${url}: ${message}`);
      await page.evaluate(() => window.stop()).catch(() => undefined);
    }
  }

  try {
    logger.warn(`[Scraper] Falling back to documentElement.outerHTML for ${url}.`);
    const html = await withTimeout<string>(page.evaluate(() => document.documentElement.outerHTML), 8000, 'outerHTML fallback');
    if (html && html.trim().length > 0) return html;
  } catch (error: any) {
    logger.warn(`[Scraper] outerHTML fallback failed for ${url}: ${error?.message || error}`);
  }

  logger.warn(`[Scraper] Falling back to raw HTTP fetch for ${url}.`);
  return fetchRawHtml(url);
}

export async function scrapeUrl(url: string): Promise<ScrapedData> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await acquirePage(context);
  page.setDefaultNavigationTimeout(45000);
  page.setDefaultTimeout(15000);
  
  // Ensure .data directory exists
  const dataDir = path.join(process.cwd(), '.data');
  try { await fs.mkdir(dataDir, { recursive: true }); } catch (e) {}
  
  const tempHtmlPath = path.join(dataDir, `temp_${crypto.randomUUID()}.html`);
  
  try {
    // 1. Fetch raw page using Playwright to handle dynamic rendering
    try {
      // Increase timeout and use a slightly less strict wait condition for slow/stuck sites
      await page.goto(url, { waitUntil: 'commit', timeout: 45000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => undefined);
      // Extra small wait to let client-side frameworks render if domcontentloaded fired too early
      await page.waitForTimeout(2000);
    } catch (navError: any) {
      if (navError.message.includes('Timeout')) {
        logger.warn(`[Scraper] Timeout waiting for full load on ${url}. Attempting to extract partial content...`);
      } else {
        throw navError;
      }
    }
    
    const rawHtml = await readStablePageHtml(page, url);
    
    let htmlToProcess = rawHtml;
    let extractedTitle = 'Extracted Article';

    // 2. Parse using JSDOM and Readability to extract ONLY the main article (strip ads, navbars)
    try {
      const dom = new JSDOM(rawHtml, { url });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();
      
      if (article && article.content) {
        htmlToProcess = `<!DOCTYPE html><html><head><title>${article.title}</title></head><body>${article.content}</body></html>`;
        if (article.title) extractedTitle = article.title;
        logger.info('Successfully cleaned article with Readability.');
      } else {
        logger.warn('Readability could not find a clear article body. Falling back to full page HTML.');
      }
    } catch (e: any) {
      logger.warn(`Readability parsing failed. Falling back to full page HTML. ${e.message}`);
    }
    
    // 3. Save the HTML to a temporary file for markitdown to process
    await fs.writeFile(tempHtmlPath, htmlToProcess, 'utf-8');
    
    // 4. Run the Python markitdown CLI command on the HTML file
    let stdout: string;
    try {
      const result = await execFileAsync('markitdown', [tempHtmlPath], {
        maxBuffer: 1024 * 1024 * 50, // 50MB buffer
        timeout: 30_000,             // 30s max — prevents hangs on large HTML
      });
      stdout = result.stdout;
    } catch (execErr: any) {
      if (execErr.killed) {
        logger.warn('markitdown timed out after 30s — returning empty markdown');
        stdout = '';
      } else {
        throw execErr;
      }
    }

    let markdownContent = stdout.trim();
    if (!markdownContent || markdownContent.length === 0) {
      // Return empty string on timeout or empty output — callers degrade gracefully
      markdownContent = '';
    }
    
    // Attempt to extract title from markitdown output if Readability didn't find one
    if (extractedTitle === 'Extracted Article') {
      const firstLine = markdownContent.split('\n')[0];
      if (firstLine && firstLine.startsWith('# ')) {
        extractedTitle = firstLine.replace('# ', '').trim();
      }
    }
    
    return {
      title: extractedTitle,
      content: markdownContent,
      originalUrl: url
    };
  } catch (error: any) {
    logger.error('Scraping or markitdown execution failed', error);
    throw new Error(`Failed to extract and clean article content: ${error.message}`);
  } finally {
    await releasePage(page).catch(() => {});
    await context.close();
    // 5. Cleanup temporary file
    try {
      await fs.unlink(tempHtmlPath);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}
