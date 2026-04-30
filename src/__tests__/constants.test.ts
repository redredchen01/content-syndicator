import { describe, expect, it } from 'vitest';
import {
  MVP_PLATFORMS,
  PLATFORM_HEAD_SUPPORTED,
  MODEL_PRICING,
  computeLlmCost,
} from '../constants';

describe('MVP_PLATFORMS', () => {
  it('contains exactly the 7 API platforms', () => {
    expect(MVP_PLATFORMS).toEqual([
      'Telegra.ph',
      'Dev.to',
      'Medium',
      'Hashnode',
      'GitHub',
      'Blogger',
      'WordPress',
    ]);
  });

  it('every platform has a HEAD support default', () => {
    for (const platform of MVP_PLATFORMS) {
      expect(PLATFORM_HEAD_SUPPORTED).toHaveProperty(platform);
      expect(typeof PLATFORM_HEAD_SUPPORTED[platform]).toBe('boolean');
    }
  });
});

describe('computeLlmCost', () => {
  it('charges per 1M input/output tokens for known models', () => {
    // gpt-4o-mini: $0.15/1M in, $0.60/1M out
    const cost = computeLlmCost('gpt-4o-mini', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.15 + 0.6, 5);
  });

  it('scales linearly with token count', () => {
    const small = computeLlmCost('gpt-4o-mini', 500, 500);
    const big = computeLlmCost('gpt-4o-mini', 5_000, 5_000);
    expect(big / small).toBeCloseTo(10, 5);
  });

  it('returns 0 for unknown models (graceful, used by Unit 5/6 to avoid crashes)', () => {
    expect(computeLlmCost('not-a-real-model', 1_000, 1_000)).toBe(0);
  });

  it('handles zero tokens', () => {
    expect(computeLlmCost('gpt-4o-mini', 0, 0)).toBe(0);
  });

  it('uses Gemini pricing when given a Gemini model', () => {
    // gemini-1.5-flash: $0.075/1M in, $0.30/1M out
    const cost = computeLlmCost('gemini-1.5-flash', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.075 + 0.3, 5);
  });
});

describe('MODEL_PRICING coverage', () => {
  it('includes the default OpenAI and Gemini fast models', () => {
    expect(MODEL_PRICING).toHaveProperty('gpt-4o-mini');
    expect(MODEL_PRICING).toHaveProperty('gemini-1.5-flash');
  });

  it('every entry has positive input and output prices', () => {
    for (const [model, price] of Object.entries(MODEL_PRICING)) {
      expect(price.input, `${model} input price`).toBeGreaterThan(0);
      expect(price.output, `${model} output price`).toBeGreaterThan(0);
    }
  });
});
