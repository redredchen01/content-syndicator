/**
 * Unit 6: Anchor Word Generator
 *
 * Runs a mini LLM prompt per variant to generate 1-2 long-tail anchor words.
 * Validates results against the brand's anchor blocklist; retries up to 3 times.
 * Falls back to ['__naked_url__'] when all retries fail.
 *
 * Attach anchors to all variants via attachAnchors(), which runs concurrently
 * (concurrency=3) after Unit 5 completes the body wave.
 */

import type Database from 'better-sqlite3';
import { invokeLLMWithTools } from '../llm/agent-llm';
import { getAnchorGeneratorPrompt, renderTemplate } from '../prompts/loader';
import { runParallel } from '../utils/parallel';
import { llmCalls } from '../db/repositories';
import { computeLlmCost } from '../constants';
import { logger } from '../utils/logger';
import type { Variant } from '../types';
import type { BrandProfile } from '../db/repositories';

export const NAKED_URL_FALLBACK = '__naked_url__';
const MAX_RETRIES = 3;

// -----------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------

/**
 * Generate anchor words for each variant and attach them in-place.
 * Runs concurrently (concurrency=3) to mirror Unit 5 wave timing.
 */
export async function attachAnchors(
  variants: Variant[],
  brand: BrandProfile,
  recentTopAnchors: string[],
  db: Database.Database,
): Promise<Variant[]> {
  const results = await runParallel(
    variants,
    variant => generateAnchorsForVariant(variant, brand, recentTopAnchors, db),
    3,
  );

  return results.map((result, i) => {
    if (!result.ok) {
      logger.warn(`[AnchorGen] ${variants[i].platform} anchor generation failed: ${result.error.message}`);
      return { ...variants[i], anchor_words: [NAKED_URL_FALLBACK] };
    }
    return { ...variants[i], anchor_words: result.value };
  });
}

/**
 * Generate 1-2 anchor words for a single variant.
 * Returns ['__naked_url__'] on exhausted retries or LLM parse errors.
 */
export async function generateAnchors(
  variant: Variant,
  brand: BrandProfile,
  recentTopAnchors: string[],
  db: Database.Database,
): Promise<string[]> {
  return generateAnchorsForVariant(variant, brand, recentTopAnchors, db);
}

// -----------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------

async function generateAnchorsForVariant(
  variant: Variant,
  brand: BrandProfile,
  recentTopAnchors: string[],
  db: Database.Database,
): Promise<string[]> {
  if (variant.generation_status === 'failed') {
    return [NAKED_URL_FALLBACK];
  }

  const promptBody = getAnchorGeneratorPrompt();
  const contextTag = brand.target_urls.find(t => t.url === variant.target_url)?.context_tag ?? 'home';
  const summary = extractSummary(variant.body_markdown);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let anchors: string[];
    try {
      anchors = await callAnchorLLM(promptBody, {
        brand,
        contextTag,
        summary,
        targetUrl: variant.target_url,
        recentTopAnchors,
      }, variant, db);
    } catch (err: any) {
      logger.warn(`[AnchorGen] ${variant.platform} attempt ${attempt + 1} parse error: ${err.message}`);
      if (attempt === MAX_RETRIES - 1) return [NAKED_URL_FALLBACK];
      continue;
    }

    const blocked = anchors.filter(a => isBlocked(a, brand.anchor_blocklist));
    if (blocked.length === 0) {
      return anchors;
    }

    logger.info(`[AnchorGen] ${variant.platform} attempt ${attempt + 1}: ${blocked.length} anchors blocked, retrying`);
    if (attempt === MAX_RETRIES - 1) {
      logger.warn(`[AnchorGen] ${variant.platform} all retries exhausted, falling back to naked URL`);
      return [NAKED_URL_FALLBACK];
    }
  }

  return [NAKED_URL_FALLBACK];
}

async function callAnchorLLM(
  promptBody: string,
  ctx: {
    brand: BrandProfile;
    contextTag: string;
    summary: string;
    targetUrl: string;
    recentTopAnchors: string[];
  },
  variant: Variant,
  db: Database.Database,
): Promise<string[]> {
  const rendered = renderTemplate(promptBody, {
    brand_name: ctx.brand.name,
    brand_variants: ctx.brand.name_variants.join(', '),
    article_summary: ctx.summary.slice(0, 80),
    target_url: ctx.targetUrl,
    target_url_context_tag: ctx.contextTag,
    anchor_blocklist: ctx.brand.anchor_blocklist.join(', '),
    recent_top_anchors: ctx.recentTopAnchors.join(', ') || 'none',
  });

  const model = process.env.SELECTED_MODEL || 'gpt-4o-mini';
  const response = await invokeLLMWithTools({
    model,
    messages: [{ role: 'user', content: rendered }],
    temperature: 0.6,
  });

  // Record cost
  const raw = response.raw as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
  const inputTokens = raw?.usage?.prompt_tokens ?? 0;
  const outputTokens = raw?.usage?.completion_tokens ?? 0;
  llmCalls.record(db, {
    batch_id: variant.variant_id.split('_').slice(0, 2).join('_') || null,
    variant_id: variant.variant_id,
    kind: 'variant_anchor',
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: computeLlmCost(model, inputTokens, outputTokens),
  });

  // Parse JSON array response
  const text = response.content.trim();
  const jsonStart = text.indexOf('[');
  const jsonEnd = text.lastIndexOf(']') + 1;
  if (jsonStart === -1 || jsonEnd === 0) {
    throw new Error(`LLM did not return a JSON array: ${text.slice(0, 100)}`);
  }
  const parsed = JSON.parse(text.slice(jsonStart, jsonEnd)) as unknown;
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) {
    throw new Error('LLM response is not a string array');
  }
  const anchors = (parsed as string[]).filter(a => a.trim().length >= 4);
  if (anchors.length === 0) {
    throw new Error('LLM returned empty anchor list');
  }
  return anchors.slice(0, 2);
}

/** Extract a plain-text summary from the variant body (first ~80 chars of first paragraph). */
function extractSummary(bodyMarkdown: string): string {
  return bodyMarkdown
    .replace(/^#+.*$/m, '') // remove headings
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // strip links
    .replace(/[*_`]/g, '') // strip markdown
    .trim()
    .slice(0, 80);
}

/** Check if an anchor hits the blocklist (case-insensitive substring match). */
function isBlocked(anchor: string, blocklist: string[]): boolean {
  const lower = anchor.toLowerCase();
  return blocklist.some(b => lower.includes(b.toLowerCase()));
}
