/**
 * Unit 5: Variant Generator
 *
 * Generates 7 platform-specific content variants from an editor draft.
 * Each variant is assigned to a persona group via PERSONA_TO_PLATFORMS,
 * rendered with the persona prompt template, and generated via LLM
 * (concurrency configurable via LLM_CONCURRENCY env var, default 5; fail-isolated via runParallel).
 *
 * LLM calls are recorded in llm_calls for cost tracking.
 * Variant results are cached in variant_cache with 24-hour TTL for cost reduction.
 * Draft is persisted in draft_batches (archived if caller resubmits).
 */

import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { MVP_PLATFORMS, computeLlmCost, CONCURRENCY_CONFIG } from '../constants';
import { platformToPersona } from '../types';
import type { Variant, PersonaGroup } from '../types';
import type { BrandProfile } from '../db/repositories';
import { getPersonaPrompt, renderTemplate } from '../prompts/loader';
import { invokeLLMWithTools } from '../llm/agent-llm';
import { runParallel } from '../utils/parallel';
import { llmCalls, draftBatches } from '../db/repositories';
import { generateDraftHash, getOrNull as getCachedVariant, set as setCachedVariant } from './variant-cache';
import { logger } from '../utils/logger';

// -----------------------------------------------------------------------
// Input / error types
// -----------------------------------------------------------------------

export interface GenerateVariantsInput {
  draft: string;
  title?: string;
  target_url_override?: string;
  brand: BrandProfile;
}

export const DRAFT_TOO_SHORT = 'DRAFT_TOO_SHORT';
const MIN_DRAFT_CHARS = 600; // Plan Unit 5: 600 non-whitespace chars

// -----------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------

/**
 * Generate a single variant for one platform.
 * Used by the regenerate-variant endpoint so we only pay for 1 LLM call
 * instead of re-running all 7 platforms.
 * Returns generation_status='failed' (instead of throwing) on LLM errors.
 */
export async function generateSingleVariant(
  platform: string,
  input: GenerateVariantsInput,
  batchId: string,
  db: Database.Database,
): Promise<Variant> {
  const persona_group = platformToPersona(platform);
  const variantId = `${batchId}_${platform.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  const targetUrl = resolveTargetUrl(input);
  const draftHash = generateDraftHash(input.draft);

  if (!persona_group) {
    return {
      variant_id: variantId, platform, persona_group: 'tech_blogger',
      title: '', body_markdown: '', anchor_words: [], target_url: targetUrl,
      generation_status: 'failed', error: `Unknown platform: ${platform}`,
    };
  }

  try {
    return await generateOne({ platform, persona_group }, input, targetUrl, batchId, draftHash, db);
  } catch (e: any) {
    logger.warn(`[VariantGen] regenerate ${platform} failed: ${e.message}`);
    return {
      variant_id: variantId, platform, persona_group,
      title: '', body_markdown: '', anchor_words: [], target_url: targetUrl,
      generation_status: 'failed', error: e.message,
    };
  }
}

/**
 * Generate 7 variants, one per MVP platform, in MVP_PLATFORMS order.
 * Returns partial results: failed variants carry generation_status='failed'.
 */
export async function generateVariants(
  input: GenerateVariantsInput,
  db: Database.Database,
): Promise<{ batchId: string; variants: Variant[] }> {
  const charCount = input.draft.replace(/\s+/g, '').length;
  if (charCount < MIN_DRAFT_CHARS) {
    const err = new Error(
      `Draft too short: ${charCount} non-whitespace chars (min ${MIN_DRAFT_CHARS})`,
    );
    Object.assign(err, { code: DRAFT_TOO_SHORT, minLength: MIN_DRAFT_CHARS });
    throw err;
  }

  const batchId = `batch_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const targetUrl = resolveTargetUrl(input);
  const draftHash = generateDraftHash(input.draft);

  // Persist the draft (new submission archives any prior drafting batch).
  draftBatches.save(db, {
    batch_id: batchId,
    draft_text: input.draft,
    status: 'drafting',
  });

  const tasks = MVP_PLATFORMS.map(platform => ({
    platform,
    persona_group: platformToPersona(platform)!,
  }));

  // Run concurrently with configurable LLM_FAN_OUT (default 5 for pay-as-you-go tier).
  // Failures are isolated per variant.
  const concurrency = CONCURRENCY_CONFIG.LLM_FAN_OUT;
  logger.info(`[VariantGen] Starting generation with concurrency=${concurrency}`);
  const results = await runParallel(
    tasks,
    task => generateOne(task, input, targetUrl, batchId, draftHash, db),
    concurrency,
  );

  const variants: Variant[] = results.map((result, i) => {
    const { platform, persona_group } = tasks[i];
    const variantId = `${batchId}_${platform.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    if (!result.ok) {
      logger.warn(`[VariantGen] ${platform} failed: ${result.error.message}`);
      return {
        variant_id: variantId,
        platform,
        persona_group,
        title: '',
        body_markdown: '',
        anchor_words: [],
        target_url: targetUrl,
        generation_status: 'failed' as const,
        error: result.error.message,
      };
    }
    return { ...result.value, variant_id: variantId };
  });

  // Persist variants so Unit 8 can restore from draft history.
  draftBatches.save(db, {
    batch_id: batchId,
    draft_text: input.draft,
    variants_json: JSON.stringify(variants),
    status: 'drafting',
  });

  return { batchId, variants };
}

// -----------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------

function resolveTargetUrl(input: GenerateVariantsInput): string {
  if (input.target_url_override) return input.target_url_override;
  if (input.brand.target_urls.length > 0) return input.brand.target_urls[0].url;
  return '';
}

function resolveContextTag(input: GenerateVariantsInput, targetUrl: string): string {
  const match = input.brand.target_urls.find(t => t.url === targetUrl);
  return match?.context_tag ?? 'home';
}

async function generateOne(
  task: { platform: string; persona_group: PersonaGroup },
  input: GenerateVariantsInput,
  targetUrl: string,
  batchId: string,
  draftHash: string,
  db: Database.Database,
): Promise<Variant> {
  // Check cache first (24-hour TTL, hit-counted).
  const cached = getCachedVariant(db, input.brand.brand_id, draftHash, task.persona_group);
  if (cached) {
    logger.info(`[VariantGen] ${task.persona_group} cache hit`);
    const variantId = `${batchId}_${task.platform.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    return {
      variant_id: variantId,
      platform: task.platform,
      persona_group: task.persona_group,
      ...cached,
      anchor_words: cached.anchor_words,
      target_url: targetUrl,
      generation_status: 'ok' as const,
    };
  }

  const prompt = getPersonaPrompt(task.persona_group);

  // Placeholder anchor_words for the prompt — real anchors come from Unit 6.
  // We give the LLM the brand name + first variant as minimal anchors.
  const placeholderAnchors = [
    input.brand.name,
    ...input.brand.name_variants.slice(0, 1),
  ]
    .filter(Boolean)
    .map(a => `- ${a}`)
    .join('\n');

  const rendered = renderTemplate(prompt.body, {
    brand_name: input.brand.name,
    brand_variants: input.brand.name_variants.join(', '),
    target_url: targetUrl,
    target_url_context_tag: resolveContextTag(input, targetUrl),
    exposure_blocklist: input.brand.exposure_blocklist.map(b => `- ${b}`).join('\n'),
    anchor_words: placeholderAnchors,
    draft_content: input.draft,
  });

  const model = process.env.SELECTED_MODEL || 'gpt-4o-mini';
  const response = await invokeLLMWithTools({
    model,
    messages: [
      {
        role: 'system',
        content:
          'You are a professional content editor. Follow the instructions exactly and output the requested format.',
      },
      { role: 'user', content: rendered },
    ],
    temperature: 0.7,
  });

  const { title, body } = parseMarkdownResponse(response.content);

  // Record LLM cost
  const raw = response.raw as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
  const inputTokens = raw?.usage?.prompt_tokens ?? 0;
  const outputTokens = raw?.usage?.completion_tokens ?? 0;
  const cost = computeLlmCost(model, inputTokens, outputTokens);
  llmCalls.record(db, {
    batch_id: batchId,
    variant_id: `${batchId}_${task.platform.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
    kind: 'variant_body',
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: cost,
  });

  const variant = {
    variant_id: `${batchId}_${task.platform.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
    platform: task.platform,
    persona_group: task.persona_group,
    title,
    body_markdown: body,
    anchor_words: [], // populated by Unit 6 attachAnchors()
    target_url: targetUrl,
    generation_status: 'ok' as const,
  };

  // Cache the result for 24 hours to reduce LLM cost on repeated content.
  setCachedVariant(db, input.brand.brand_id, draftHash, task.persona_group, variant);

  return variant;
}

/** Extract title and body from a Markdown response that starts with `# Title`. */
export function parseMarkdownResponse(content: string): { title: string; body: string } {
  const lines = content.trim().split('\n');
  const titleLine = lines[0] ?? '';
  const title = titleLine.startsWith('#')
    ? titleLine.replace(/^#+\s*/, '').trim()
    : titleLine.trim();
  const body = lines.slice(1).join('\n').trim();
  return { title, body };
}
