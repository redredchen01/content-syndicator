import { describe, expect, it } from 'vitest';
import {
  compileBlocklist,
  compileRule,
  findFirstExposure,
} from '../regex-rules';

describe('compileRule', () => {
  it('escapes regex metacharacters in latin entries', () => {
    const rx = compileRule('co.uk');
    expect(rx.test('co.uk site')).toBe(true);
    expect(rx.test('coxuk')).toBe(false); // dot was escaped
  });

  it('uses substring matching for CJK entries (no \\b)', () => {
    const rx = compileRule('本品牌');
    expect(rx.test('支持本品牌很好')).toBe(true);
  });

  it('throws on empty entry', () => {
    expect(() => compileRule('   ')).toThrow();
  });

  it('Latin entries respect word boundaries', () => {
    const rx = compileRule('we');
    expect(rx.test('as we said')).toBe(true);
    expect(rx.test('werewolf')).toBe(false); // boundary prevents partial-word hit
  });
});

describe('compileBlocklist', () => {
  it('skips empty entries', () => {
    const rules = compileBlocklist(['', '  ', '本品牌']);
    expect(rules).toHaveLength(1);
  });
});

describe('findFirstExposure', () => {
  const blocklist = ['作为我们', '本品牌', 'as we', 'our team'];
  const rules = compileBlocklist(blocklist);

  it('returns null when no exposure', () => {
    expect(
      findFirstExposure('A clean third-party recommendation post.', blocklist, rules),
    ).toBeNull();
  });

  it('returns the FIRST hit by index', () => {
    const text = 'they tried it. as we noted, our team prefers it.';
    const hit = findFirstExposure(text, blocklist, rules);
    expect(hit).not.toBeNull();
    expect(hit!.rule).toBe('as we');
    expect(text.slice(hit!.index, hit!.index + 'as we'.length)).toBe('as we');
  });

  it('CJK rule: 本品牌 → caught', () => {
    const hit = findFirstExposure('支持本品牌的用户都说不错。', blocklist, rules);
    expect(hit?.rule).toBe('本品牌');
  });

  it('does NOT trigger on similar but distinct phrasing', () => {
    expect(
      findFirstExposure('our community loves it', blocklist, rules),
    ).toBeNull();
    expect(
      findFirstExposure('the team behind it', blocklist, rules),
    ).toBeNull();
  });

  it('throws when blocklist and rules are misaligned', () => {
    expect(() => findFirstExposure('x', ['a', 'b'], compileBlocklist(['a']))).toThrow();
  });

  it('returns excerpt window with ellipsis on long input', () => {
    const text = 'x'.repeat(100) + '本品牌' + 'y'.repeat(100);
    const hit = findFirstExposure(text, blocklist, rules);
    expect(hit?.excerpt).toContain('本品牌');
    expect(hit?.excerpt).toContain('…');
  });
});
