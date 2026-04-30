import { describe, expect, it } from 'vitest';
import { runLint, orderPairByStrength } from '..';
import type { BrandProfile } from '../../../db/repositories';
import type { Variant } from '../../../types';

function makeBrand(overrides: Partial<BrandProfile> = {}): BrandProfile {
  return {
    brand_id: 'main',
    name: 'Acme',
    name_variants: [],
    target_urls: [],
    exposure_blocklist: ['作为我们', 'as we', '本品牌'],
    anchor_blocklist: [],
    signature: null,
    anchor_concentration_threshold: 0.30,
    weekly_url_cap: 6,
    jaccard_threshold: 0.5,
    digest_channel: 'none',
    digest_destination: null,
    updated_at: '2026-04-30T00:00:00Z',
    ...overrides,
  };
}

function makeVariant(platform: string, body: string, overrides: Partial<Variant> = {}): Variant {
  return {
    variant_id: `v_${platform}`,
    platform,
    persona_group: 'tech_blogger',
    title: `Title for ${platform}`,
    body_markdown: body,
    anchor_words: [],
    target_url: 'https://example.com',
    generation_status: 'ok',
    ...overrides,
  };
}

describe('runLint — happy paths', () => {
  it('passes when 3 variants are diverse and clean', () => {
    const variants = [
      makeVariant('Dev.to', 'Independent review of the platform with technical depth and code samples.'),
      makeVariant('Medium', 'A personal essay about my afternoon trying this niche tool out.'),
      makeVariant('Telegra.ph', 'Comparison post listing three alternatives in the same category.'),
    ];
    const result = runLint(variants, makeBrand());
    expect(result.passed).toBe(true);
    expect(result.variantViolations).toEqual({});
    expect(result.batchViolation).toBeNull();
  });
});

describe('runLint — exposure (regex gate)', () => {
  it('flags variant whose body contains an exposure phrase', () => {
    const variants = [
      makeVariant('Dev.to', '作为我们 the platform we built solves problems.'),
      makeVariant('Medium', 'A different essay about a tool I found online.'),
    ];
    const result = runLint(variants, makeBrand());
    expect(result.passed).toBe(false);
    expect(result.variantViolations).toHaveProperty('Dev.to');
    expect(result.variantViolations['Dev.to'].rule).toBe('作为我们');
  });

  it('does not flag clean variants', () => {
    const variants = [makeVariant('Dev.to', 'A neutral third-party take on this tool.')];
    expect(runLint(variants, makeBrand()).variantViolations).toEqual({});
  });
});

describe('runLint — batch Jaccard (similarity gate)', () => {
  it('blocks batch when two variants are near-identical', () => {
    const same =
      'The platform offers a clean API for syndicating posts. ' +
      'Each platform supports markdown export. ' +
      'I tried it for two weeks and noticed reasonable performance overall.';
    const variants = [
      makeVariant('Dev.to', same),
      makeVariant('Medium', same), // exact dup
      makeVariant('Telegra.ph', 'Totally different sentence about cats.'),
    ];
    const result = runLint(variants, makeBrand({ jaccard_threshold: 0.5 }));
    expect(result.passed).toBe(false);
    expect(result.batchViolation).not.toBeNull();
    expect(result.batchViolation!.similarity).toBeGreaterThanOrEqual(0.5);
    expect(result.batchViolation!.platforms).toEqual(
      expect.arrayContaining(['Dev.to', 'Medium']),
    );
  });

  it('respects the brand-level threshold (0.7 looser → passes)', () => {
    const a =
      'This platform has API docs that explain the syndication flow clearly. The community is helpful.';
    const b =
      'This platform has API docs that explain the syndication flow clearly. The forum is responsive.';
    const variants = [makeVariant('Dev.to', a), makeVariant('Medium', b)];
    expect(runLint(variants, makeBrand({ jaccard_threshold: 0.5 })).passed).toBe(false);
    expect(runLint(variants, makeBrand({ jaccard_threshold: 0.95 })).passed).toBe(true);
  });

  it('skips failed variants from Jaccard pairing', () => {
    const variants = [
      makeVariant('Dev.to', 'First successful variant body content.'),
      makeVariant('Medium', '', { generation_status: 'failed', error: 'rate limit' }),
      makeVariant('Telegra.ph', 'Third successful variant with different prose.'),
    ];
    const result = runLint(variants, makeBrand());
    expect(result.passed).toBe(true);
  });
});

describe('orderPairByStrength', () => {
  it('marks the variant WITH exposure violation as the weaker one', () => {
    const variants = [
      makeVariant('Dev.to', 'Clean body.'),
      makeVariant('Medium', '作为我们 contaminated body.'),
    ];
    const exposures = {
      Medium: { rule: '作为我们', index: 0, excerpt: '作为我们 conta…' },
    };
    const ordered = orderPairByStrength(0, 1, variants, exposures);
    expect(ordered).toEqual([0, 1]); // [stronger, weaker]
  });

  it('falls back to longer body = stronger when neither has exposure', () => {
    const variants = [
      makeVariant('Dev.to', 'Short body.'),
      makeVariant('Medium', 'A much longer and more detailed body that contains more context and material to work with.'),
    ];
    const ordered = orderPairByStrength(0, 1, variants, {});
    expect(ordered).toEqual([1, 0]); // longer (Medium) is stronger, Dev.to weaker
  });
});
