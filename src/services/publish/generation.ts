/**
 * services/publish/generation.ts (Plan 2026-05-07-002 Unit 6)
 *
 * v0.1 content-generation API — encapsulates the three /api/generate*
 * endpoints' business logic. Pure delegation to scraper + LLM, no DB writes.
 *
 *   POST /api/generate          → runGenerate         (URL → markdown)
 *   POST /api/generate-manual   → runGenerateManual   (raw text → markdown)
 *   POST /api/generate-promo    → runGeneratePromo    (promo blurb)
 *
 * Tagged-result shape for predictable validation failures (400). Programming
 * errors (LLM throw, scrape throw) bubble up to asyncRoute's 500 mapper.
 */

import { logger } from '../../utils/logger';
import { scrapeUrl } from '../../scraper';
import { generateMarkdown, generatePromoMarkdown } from '../../llm';

// ---------------------------------------------------------------------------
// runGenerate (POST /api/generate)
// ---------------------------------------------------------------------------

export interface RunGenerateInput {
  url?: unknown;
}

export interface GeneratedMarkdown {
  title: string;
  content: string;
  originalUrl: string;
  tags?: string[];
  excerpt?: string;
}

export type RunGenerateResult =
  | { ok: true; payload: GeneratedMarkdown }
  | { ok: false; error: string; status: 400 };

export async function runGenerate(body: RunGenerateInput): Promise<RunGenerateResult> {
  const url = typeof body.url === 'string' ? body.url : null;
  if (!url) return { ok: false, error: 'URL is required', status: 400 };

  logger.info(`API: Starting scrape for URL: ${url}`);
  const scrapedData = await scrapeUrl(url);
  logger.info('API: Calling LLM to generate Markdown content...');
  const { title, content, tags, excerpt } = await generateMarkdown(scrapedData);

  return { ok: true, payload: { title, content, originalUrl: url, tags, excerpt } };
}

// ---------------------------------------------------------------------------
// runGenerateManual (POST /api/generate-manual)
// ---------------------------------------------------------------------------

export interface RunGenerateManualInput {
  rawContent?: unknown;
  originalUrl?: unknown;
}

export type RunGenerateManualResult =
  | { ok: true; payload: GeneratedMarkdown }
  | { ok: false; error: string; status: 400 };

export async function runGenerateManual(
  body: RunGenerateManualInput,
): Promise<RunGenerateManualResult> {
  const rawContent = typeof body.rawContent === 'string' ? body.rawContent : null;
  if (!rawContent) return { ok: false, error: 'rawContent is required', status: 400 };

  const originalUrl = typeof body.originalUrl === 'string' ? body.originalUrl : '';
  logger.info('API: Rewriting manual content via LLM...');
  const { title, content, tags, excerpt } = await generateMarkdown({
    title: 'Manual Content',
    content: rawContent,
    originalUrl,
  });

  return { ok: true, payload: { title, content, originalUrl, tags, excerpt } };
}

// ---------------------------------------------------------------------------
// runGeneratePromo (POST /api/generate-promo)
// ---------------------------------------------------------------------------

export interface RunGeneratePromoInput {
  title?: unknown;
  content?: unknown;
  urls?: unknown;
}

export interface PromoMarkdown {
  title: string;
  content: string;
  tags?: string[];
  excerpt?: string;
}

export type RunGeneratePromoResult =
  | { ok: true; payload: PromoMarkdown }
  | { ok: false; error: string; status: 400 };

export async function runGeneratePromo(
  body: RunGeneratePromoInput,
): Promise<RunGeneratePromoResult> {
  const title = typeof body.title === 'string' ? body.title : null;
  const content = typeof body.content === 'string' ? body.content : null;
  const urls = Array.isArray(body.urls) ? (body.urls as string[]) : null;
  if (!title || !content || !urls) {
    return {
      ok: false,
      error: 'Missing required fields: title, content, urls',
      status: 400,
    };
  }

  logger.info('API: Generating promotional Markdown via LLM...');
  const promo = await generatePromoMarkdown(title, content, urls);

  return {
    ok: true,
    payload: {
      title: promo.title,
      content: promo.content,
      tags: promo.tags,
      excerpt: promo.excerpt,
    },
  };
}
