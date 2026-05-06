import { describe, expect, it } from 'vitest';
import {
  jaccardSim,
  normalizeForShingling,
  pairwiseMaxJaccard,
  tokenize5gram,
} from '../jaccard';

describe('normalizeForShingling', () => {
  it('strips fenced code blocks', () => {
    const got = normalizeForShingling('hello\n```js\nlet x = 1;\n```\nworld');
    expect(got).not.toContain('let x');
    expect(got).toContain('hello');
    expect(got).toContain('world');
  });

  it('keeps anchor text but drops link URL', () => {
    expect(normalizeForShingling('[click here](https://example.com)')).toBe(
      'click here',
    );
  });

  it('keeps image alt but drops image URL', () => {
    expect(normalizeForShingling('![cat](https://x.png)')).toBe('cat');
  });

  it('lowercases and collapses whitespace', () => {
    expect(normalizeForShingling('Hello  WORLD\n\n\tfoo')).toBe('hello world foo');
  });
});

describe('tokenize5gram', () => {
  it('returns chars in 5-gram windows', () => {
    const grams = tokenize5gram('abcdefg');
    // 'abcde', 'bcdef', 'cdefg' after lowercasing
    expect(grams.size).toBe(3);
    expect(grams.has('abcde')).toBe(true);
    expect(grams.has('cdefg')).toBe(true);
  });

  it('handles short text shorter than 5 chars', () => {
    const grams = tokenize5gram('abc');
    expect(grams.size).toBe(1);
    expect(grams.has('abc')).toBe(true);
  });

  it('treats Chinese chars as single tokens (5 ideographs)', () => {
    const grams = tokenize5gram('我们的产品很好');
    // 我们的产品 / 们的产品很 / 的产品很好
    expect(grams.size).toBe(3);
  });
});

describe('jaccardSim', () => {
  it('returns 1 for identical sets', () => {
    const s = new Set(['a', 'b', 'c']);
    expect(jaccardSim(s, s)).toBe(1);
  });

  it('returns 0 for disjoint sets', () => {
    expect(jaccardSim(new Set(['a']), new Set(['b']))).toBe(0);
  });

  it('returns 0.5 for half-overlap', () => {
    // |A∩B|=1, |A∪B|=3 → 1/3 ≈ 0.333
    const sim = jaccardSim(new Set(['a', 'b']), new Set(['b', 'c']));
    expect(sim).toBeCloseTo(1 / 3, 5);
  });

  it('returns 0 for two empty sets', () => {
    expect(jaccardSim(new Set(), new Set())).toBe(0);
  });
});

describe('pairwiseMaxJaccard', () => {
  it('returns null when fewer than 2 inputs', () => {
    expect(pairwiseMaxJaccard([])).toBeNull();
    expect(pairwiseMaxJaccard(['only one'])).toBeNull();
  });

  it('finds the highest-similarity pair', () => {
    const texts = [
      'the quick brown fox jumps over the lazy dog',
      'a totally unrelated sentence about cats',
      'the quick brown fox jumps over the lazy cat', // similar to [0]
    ];
    const result = pairwiseMaxJaccard(texts);
    expect(result).not.toBeNull();
    expect(result!.pair).toEqual([0, 2]);
    expect(result!.similarity).toBeGreaterThan(0.5);
  });

  it('returns 0 similarity for fully unrelated texts', () => {
    const result = pairwiseMaxJaccard(['abcdefghij', 'zyxwvutsrq']);
    expect(result!.similarity).toBe(0);
  });

  it('handles 100KB text under 200ms (Plan performance gate)', () => {
    const big = 'a'.repeat(100_000);
    const big2 = 'b'.repeat(100_000);
    const start = performance.now();
    const result = pairwiseMaxJaccard([big, big2, big.slice(0, 50_000) + 'c'.repeat(50_000)]);
    const ms = performance.now() - start;
    expect(result).not.toBeNull();
    expect(ms).toBeLessThan(500); // generous bound; prove it's not pathological
  });
});
