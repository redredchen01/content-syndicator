import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  generateVariants,
  parseMarkdownResponse,
  DRAFT_TOO_SHORT,
  type GenerateVariantsInput,
} from '../variant-generator';
import { MVP_PLATFORMS } from '../../constants';
import type { BrandProfile } from '../../db/repositories';
import { applyV2Schema } from '../../db/schema';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

import { invokeLLMWithTools } from '../../llm/agent-llm';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_BRAND: BrandProfile = {
  brand_id: 'main',
  name: 'TestBrand',
  name_variants: ['Test Brand', 'testbrand.io'],
  target_urls: [{ url: 'https://testbrand.io', context_tag: 'home' }],
  exposure_blocklist: ['我们', '我方', '本公司', '官方', '内部'],
  anchor_blocklist: ['click here', 'read more'],
  signature: null,
  anchor_concentration_threshold: 0.3,
  weekly_url_cap: 6,
  jaccard_threshold: 0.5,
  digest_channel: 'none',
  digest_destination: null,
  updated_at: new Date().toISOString(),
};

const LONG_DRAFT = '这是一篇关于 TestBrand 的测试草稿内容。'.repeat(40); // well over 600 non-whitespace chars

function makeMockLLMResponse(platform: string) {
  return {
    content: `# ${platform} Article Title\n\nThis is the article body for ${platform}. TestBrand provides a great service.\n\nLearn more at [TestBrand](https://testbrand.io).`,
    tool_calls: [],
    raw: { usage: { prompt_tokens: 100, completion_tokens: 200 } },
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function makeDb() {
  const db = new Database(':memory:');
  applyV2Schema(db);
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invokeLLMWithTools).mockImplementation(async (opts) => {
    const model = opts.model ?? 'gpt-4o-mini';
    return makeMockLLMResponse(model);
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseMarkdownResponse', () => {
  it('extracts title from first h1 line', () => {
    const { title, body } = parseMarkdownResponse('# My Title\n\nBody text here');
    expect(title).toBe('My Title');
    expect(body).toBe('Body text here');
  });

  it('handles ## heading level', () => {
    const { title } = parseMarkdownResponse('## Sub Title\n\nContent');
    expect(title).toBe('Sub Title');
  });

  it('handles missing heading gracefully', () => {
    const { title, body } = parseMarkdownResponse('No heading here\n\nBody');
    expect(title).toBe('No heading here');
    expect(body).toBe('Body');
  });
});

describe('generateVariants', () => {
  it('throws DRAFT_TOO_SHORT for short draft', async () => {
    const db = makeDb();
    const input: GenerateVariantsInput = {
      draft: '너무 짧아',
      brand: MOCK_BRAND,
    };
    await expect(generateVariants(input, db)).rejects.toMatchObject({
      code: DRAFT_TOO_SHORT,
    });
    db.close();
  });

  it('returns 7 variants in MVP_PLATFORMS order', async () => {
    const db = makeDb();
    vi.mocked(invokeLLMWithTools).mockImplementation(async (opts) => {
      const userMsg = opts.messages.find(m => m.role === 'user')?.content ?? '';
      const platform = MVP_PLATFORMS.find(p => userMsg.includes('TestBrand')) ?? 'Unknown';
      return makeMockLLMResponse(platform);
    });

    const { variants } = await generateVariants({ draft: LONG_DRAFT, brand: MOCK_BRAND }, db);

    expect(variants).toHaveLength(7);
    expect(variants.map(v => v.platform)).toEqual(MVP_PLATFORMS);
    db.close();
  });

  it('marks failed variants with generation_status=failed without throwing', async () => {
    const db = makeDb();
    let callCount = 0;
    vi.mocked(invokeLLMWithTools).mockImplementation(async () => {
      callCount++;
      // 2nd call always fails
      if (callCount === 2) throw new Error('LLM timeout');
      return makeMockLLMResponse('generic');
    });

    const { variants } = await generateVariants({ draft: LONG_DRAFT, brand: MOCK_BRAND }, db);

    expect(variants).toHaveLength(7);
    const failed = variants.filter(v => v.generation_status === 'failed');
    const ok = variants.filter(v => v.generation_status === 'ok');
    expect(failed).toHaveLength(1);
    expect(ok).toHaveLength(6);
    expect(failed[0].error).toContain('LLM timeout');
    db.close();
  });

  it('all 7 fail → returns 7 failed variants, no throw', async () => {
    const db = makeDb();
    vi.mocked(invokeLLMWithTools).mockRejectedValue(new Error('API down'));

    const { variants } = await generateVariants({ draft: LONG_DRAFT, brand: MOCK_BRAND }, db);

    expect(variants.every(v => v.generation_status === 'failed')).toBe(true);
    db.close();
  });

  it('records batchId and returns it', async () => {
    const db = makeDb();
    vi.mocked(invokeLLMWithTools).mockResolvedValue(makeMockLLMResponse('test'));

    const { batchId, variants } = await generateVariants(
      { draft: LONG_DRAFT, brand: MOCK_BRAND },
      db,
    );

    expect(batchId).toMatch(/^batch_\d+_[a-f0-9]{6}$/);
    expect(variants.every(v => v.variant_id.startsWith(batchId))).toBe(true);
    db.close();
  });

  it('concurrent performance: 7 tasks with 200ms mock each run under 1500ms', async () => {
    const db = makeDb();
    vi.mocked(invokeLLMWithTools).mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve(makeMockLLMResponse('perf')), 200)),
    );

    const start = Date.now();
    await generateVariants({ draft: LONG_DRAFT, brand: MOCK_BRAND }, db);
    const elapsed = Date.now() - start;

    // concurrency=3 → 3 batches of tasks → ~600ms total, well under 1500ms
    expect(elapsed).toBeLessThan(1500);
    db.close();
  });

  it('saves draft batch to DB', async () => {
    const db = makeDb();
    vi.mocked(invokeLLMWithTools).mockResolvedValue(makeMockLLMResponse('test'));

    const { batchId } = await generateVariants({ draft: LONG_DRAFT, brand: MOCK_BRAND }, db);

    const row = db
      .prepare('SELECT * FROM draft_batches WHERE batch_id = ?')
      .get(batchId) as { batch_id: string; variants_json: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.batch_id).toBe(batchId);
    const saved = JSON.parse(row!.variants_json) as unknown[];
    expect(saved).toHaveLength(7);
    db.close();
  });

  it('records llm_calls for successful variants', async () => {
    const db = makeDb();
    vi.mocked(invokeLLMWithTools).mockResolvedValue(makeMockLLMResponse('test'));

    const { batchId } = await generateVariants({ draft: LONG_DRAFT, brand: MOCK_BRAND }, db);

    const rows = db
      .prepare("SELECT * FROM llm_calls WHERE batch_id = ? AND kind = 'variant_body'")
      .all(batchId) as unknown[];

    expect(rows.length).toBe(7); // one per platform
    db.close();
  });
});
