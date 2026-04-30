import { describe, expect, it, beforeEach } from 'vitest';
import {
  splitFrontmatter,
  parseYamlFrontmatter,
  renderTemplate,
  assertNoUnsubstitutedPlaceholders,
  getPersonaPrompt,
  getAnchorGeneratorPrompt,
  _clearCacheForTests,
} from '../loader';
import { PERSONA_TO_PLATFORMS, platformToPersona, PERSONA_LABEL_ZH } from '../../types';

describe('splitFrontmatter', () => {
  it('separates YAML block from body', () => {
    const raw = '---\npersona: tech_blogger\n---\nbody starts here';
    const { meta, body } = splitFrontmatter(raw);
    expect(meta).toBe('persona: tech_blogger');
    expect(body).toBe('body starts here');
  });

  it('returns null meta when no frontmatter is present', () => {
    expect(splitFrontmatter('plain markdown').meta).toBeNull();
  });
});

describe('parseYamlFrontmatter', () => {
  it('parses key: value scalars', () => {
    const got = parseYamlFrontmatter('persona: tech_blogger\nlabel_zh: 技术博主');
    expect(got).toEqual({ persona: 'tech_blogger', label_zh: '技术博主' });
  });

  it('parses indented hyphen lists', () => {
    const got = parseYamlFrontmatter(
      ['tone_keywords:', '  - clear', '  - structured', '  - pragmatic'].join('\n'),
    );
    expect(got.tone_keywords).toEqual(['clear', 'structured', 'pragmatic']);
  });

  it('strips quotes around scalar values', () => {
    const got = parseYamlFrontmatter('persona: "tech_blogger"');
    expect(got.persona).toBe('tech_blogger');
  });

  it('throws on malformed lines', () => {
    expect(() => parseYamlFrontmatter('not-a-key-value')).toThrowError(/Cannot parse/);
  });
});

describe('renderTemplate', () => {
  it('substitutes named placeholders', () => {
    expect(renderTemplate('Hello {{name}}!', { name: 'world' })).toBe('Hello world!');
  });

  it('handles multiple placeholders + repeats', () => {
    const got = renderTemplate('{{a}} and {{a}} and {{b}}', { a: '1', b: '2' });
    expect(got).toBe('1 and 1 and 2');
  });

  it('throws on missing variable', () => {
    expect(() => renderTemplate('hi {{name}}', {})).toThrowError(/Missing prompt variable: name/);
  });

  it('returns clean output when vars match', () => {
    const result = renderTemplate('a={{x}}, b={{y}}', { x: 'X', y: 'Y' });
    expect(result).toBe('a=X, b=Y');
  });
});

describe('assertNoUnsubstitutedPlaceholders', () => {
  it('throws when leftover placeholder is present', () => {
    expect(() => assertNoUnsubstitutedPlaceholders('hello {{name}}')).toThrowError(
      /Unsubstituted placeholder/,
    );
  });

  it('passes on clean string', () => {
    expect(() => assertNoUnsubstitutedPlaceholders('all good')).not.toThrow();
  });
});

describe('getPersonaPrompt', () => {
  beforeEach(() => _clearCacheForTests());

  it('loads tech_blogger and parses frontmatter', () => {
    const p = getPersonaPrompt('tech_blogger');
    expect(p.meta.persona).toBe('tech_blogger');
    expect(p.meta.label_zh).toBe('技术博主');
    expect(p.meta.tone_keywords.length).toBeGreaterThan(0);
    expect(p.body).toContain('{{brand_name}}');
  });

  it('loads personal_essay', () => {
    const p = getPersonaPrompt('personal_essay');
    expect(p.meta.persona).toBe('personal_essay');
    expect(p.meta.label_zh).toBe('个人随笔');
  });

  it('loads reviewer', () => {
    const p = getPersonaPrompt('reviewer');
    expect(p.meta.persona).toBe('reviewer');
    expect(p.meta.label_zh).toBe('评论客');
  });

  it('uses cache (mtime unchanged) — same object on repeat call', () => {
    const a = getPersonaPrompt('tech_blogger');
    const b = getPersonaPrompt('tech_blogger');
    expect(a).toBe(b); // strict equality means same cached instance
  });
});

describe('getAnchorGeneratorPrompt', () => {
  beforeEach(() => _clearCacheForTests());

  it('returns the body without YAML preface', () => {
    const body = getAnchorGeneratorPrompt();
    expect(body).not.toContain('purpose: anchor_generator');
    expect(body).toContain('{{brand_name}}');
    expect(body).toContain('{{recent_top_anchors}}');
    expect(body).toContain('{{anchor_blocklist}}');
  });
});

describe('persona ↔ platform mapping (types/index.ts)', () => {
  it('exports a label for each persona group', () => {
    for (const group of Object.keys(PERSONA_TO_PLATFORMS)) {
      expect(PERSONA_LABEL_ZH).toHaveProperty(group);
    }
  });

  it('platformToPersona resolves all 7 MVP platforms', () => {
    expect(platformToPersona('Dev.to')).toBe('tech_blogger');
    expect(platformToPersona('Hashnode')).toBe('tech_blogger');
    expect(platformToPersona('GitHub')).toBe('tech_blogger');
    expect(platformToPersona('Medium')).toBe('personal_essay');
    expect(platformToPersona('Telegra.ph')).toBe('reviewer');
    expect(platformToPersona('Blogger')).toBe('reviewer');
    expect(platformToPersona('WordPress')).toBe('reviewer');
  });

  it('returns null for unknown platforms', () => {
    expect(platformToPersona('Substack')).toBeNull();
  });

  it('every platform belongs to exactly one persona group', () => {
    const counts = new Map<string, number>();
    for (const platforms of Object.values(PERSONA_TO_PLATFORMS)) {
      for (const p of platforms) counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    for (const [, n] of counts) expect(n).toBe(1);
  });
});

describe('end-to-end: persona prompt renders with realistic vars', () => {
  it('tech_blogger renders cleanly with all vars supplied', () => {
    const prompt = getPersonaPrompt('tech_blogger');
    const rendered = renderTemplate(prompt.body, {
      brand_name: 'Acme',
      brand_variants: '["Acme", "acme.io"]',
      target_url: 'https://acme.io/product',
      target_url_context_tag: 'product:main',
      exposure_blocklist: '- "as we"\n- "本品牌"',
      anchor_words: '- "the platform"\n- "this tool"',
      draft_content: 'This is a sample draft.',
    });
    expect(rendered).toContain('Acme');
    expect(rendered).toContain('acme.io/product');
    expect(rendered).not.toContain('{{');
  });
});
