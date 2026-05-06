import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { attachAnchors, generateAnchors, NAKED_URL_FALLBACK } from '../anchor-generator';
import type { Variant } from '../../types';
import type { BrandProfile } from '../../db/repositories';
import { applyV2Schema } from '../../db/schema';

vi.mock('../../llm/agent-llm', () => ({
  invokeLLMWithTools: vi.fn(),
}));
vi.mock('../../llm/client', () => ({
  getOpenAIClient: vi.fn(),
  getGeminiClient: vi.fn(),
  safetySettings: [],
  resetLLMClients: vi.fn(),
}));
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { invokeLLMWithTools } from '../../llm/agent-llm';

const MOCK_BRAND: BrandProfile = {
  brand_id: 'main',
  name: 'TestBrand',
  name_variants: ['testbrand.io'],
  target_urls: [{ url: 'https://testbrand.io', context_tag: 'home' }],
  exposure_blocklist: [],
  anchor_blocklist: ['click here', 'read more'],
  signature: null,
  anchor_concentration_threshold: 0.3,
  weekly_url_cap: 6,
  jaccard_threshold: 0.5,
  digest_channel: 'none',
  digest_destination: null,
  updated_at: new Date().toISOString(),
};

function makeVariant(overrides: Partial<Variant> = {}): Variant {
  return {
    variant_id: 'batch_123_devto',
    platform: 'Dev.to',
    persona_group: 'tech_blogger',
    title: 'Test Article',
    body_markdown: 'This is a good article about TestBrand. It solves the problem nicely.',
    anchor_words: [],
    target_url: 'https://testbrand.io',
    generation_status: 'ok',
    ...overrides,
  };
}

function makeDb() {
  const db = new Database(':memory:');
  applyV2Schema(db);
  return db;
}

function mockAnchorResponse(anchors: string[]) {
  vi.mocked(invokeLLMWithTools).mockResolvedValue({
    content: JSON.stringify(anchors),
    tool_calls: [],
    raw: { usage: { prompt_tokens: 50, completion_tokens: 20 } },
  });
}

beforeEach(() => { vi.clearAllMocks(); });

describe('generateAnchors', () => {
  it('returns 1-2 anchors when LLM succeeds', async () => {
    const db = makeDb();
    mockAnchorResponse(['testbrand developer tool', 'a useful platform for devs']);

    const anchors = await generateAnchors(makeVariant(), MOCK_BRAND, [], db);

    expect(anchors).toHaveLength(2);
    expect(anchors[0]).toBe('testbrand developer tool');
    db.close();
  });

  it('retries when first response hits blocklist, succeeds on second clean attempt', async () => {
    const db = makeDb();
    vi.mocked(invokeLLMWithTools)
      .mockResolvedValueOnce({
        content: '["click here", "read more"]', // both blocked
        tool_calls: [],
        raw: { usage: { prompt_tokens: 50, completion_tokens: 20 } },
      })
      .mockResolvedValueOnce({
        content: '["testbrand for developers", "useful tool"]', // clean
        tool_calls: [],
        raw: { usage: { prompt_tokens: 50, completion_tokens: 20 } },
      });

    const anchors = await generateAnchors(makeVariant(), MOCK_BRAND, [], db);

    // Should succeed on attempt 2, returning clean anchors
    expect(anchors).toContain('testbrand for developers');
    expect(anchors).not.toContain('click here');
    db.close();
  });

  it('returns __naked_url__ after 3 retries all blocked', async () => {
    const db = makeDb();
    vi.mocked(invokeLLMWithTools).mockResolvedValue({
      content: '["click here", "read more"]', // both blocked
      tool_calls: [],
      raw: { usage: { prompt_tokens: 50, completion_tokens: 20 } },
    });

    const anchors = await generateAnchors(makeVariant(), MOCK_BRAND, [], db);

    expect(anchors).toEqual([NAKED_URL_FALLBACK]);
    expect(invokeLLMWithTools).toHaveBeenCalledTimes(3);
    db.close();
  });

  it('returns __naked_url__ when LLM returns non-JSON', async () => {
    const db = makeDb();
    vi.mocked(invokeLLMWithTools).mockResolvedValue({
      content: 'Sorry, I cannot generate anchors.',
      tool_calls: [],
      raw: {},
    });

    const anchors = await generateAnchors(makeVariant(), MOCK_BRAND, [], db);

    expect(anchors).toEqual([NAKED_URL_FALLBACK]);
    db.close();
  });

  it('skips failed variants and returns __naked_url__', async () => {
    const db = makeDb();
    const failed = makeVariant({ generation_status: 'failed' });

    const anchors = await generateAnchors(failed, MOCK_BRAND, [], db);

    expect(anchors).toEqual([NAKED_URL_FALLBACK]);
    expect(invokeLLMWithTools).not.toHaveBeenCalled();
    db.close();
  });

  it('works with empty recentTopAnchors (first startup)', async () => {
    const db = makeDb();
    mockAnchorResponse(['good long-tail anchor']);

    const anchors = await generateAnchors(makeVariant(), MOCK_BRAND, [], db);

    expect(anchors).toHaveLength(1);
    db.close();
  });

  it('truncates to 2 anchors if LLM returns more', async () => {
    const db = makeDb();
    mockAnchorResponse(['testbrand tool for devs', 'useful automation platform', 'third anchor candidate']);

    const anchors = await generateAnchors(makeVariant(), MOCK_BRAND, [], db);

    expect(anchors).toHaveLength(2);
    db.close();
  });
});

describe('attachAnchors', () => {
  it('attaches anchor_words to all variants in-place', async () => {
    const db = makeDb();
    mockAnchorResponse(['testbrand tool']);

    const variants = [makeVariant({ platform: 'Dev.to' }), makeVariant({ platform: 'Medium' })];
    const result = await attachAnchors(variants, MOCK_BRAND, [], db);

    expect(result).toHaveLength(2);
    expect(result.every(v => v.anchor_words.length > 0)).toBe(true);
    db.close();
  });

  it('returns __naked_url__ for failed variant, proceeds for others', async () => {
    const db = makeDb();
    mockAnchorResponse(['good anchor']);

    const variants = [
      makeVariant({ platform: 'Dev.to', generation_status: 'failed' }),
      makeVariant({ platform: 'Medium', generation_status: 'ok' }),
    ];
    const result = await attachAnchors(variants, MOCK_BRAND, [], db);

    expect(result[0].anchor_words).toEqual([NAKED_URL_FALLBACK]);
    expect(result[1].anchor_words).not.toEqual([NAKED_URL_FALLBACK]);
    db.close();
  });
});
