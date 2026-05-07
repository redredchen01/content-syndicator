import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const scrapeUrlMock = vi.fn();
const generateMarkdownMock = vi.fn();
const generatePromoMarkdownMock = vi.fn();

vi.mock('../../../scraper', () => ({
  scrapeUrl: (...args: unknown[]) => scrapeUrlMock(...args),
}));

vi.mock('../../../llm', () => ({
  generateMarkdown: (...args: unknown[]) => generateMarkdownMock(...args),
  generatePromoMarkdown: (...args: unknown[]) => generatePromoMarkdownMock(...args),
}));

vi.mock('../../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
  randomSleep: vi.fn(),
}));

// SUT
import { runGenerate, runGenerateManual, runGeneratePromo } from '../generation';

beforeEach(() => {
  scrapeUrlMock.mockReset();
  generateMarkdownMock.mockReset();
  generatePromoMarkdownMock.mockReset();
});

// ---------------------------------------------------------------------------
// runGenerate
// ---------------------------------------------------------------------------

describe('runGenerate', () => {
  it('scrapes and generates markdown on happy path', async () => {
    scrapeUrlMock.mockResolvedValue({ title: 's', content: 'c', originalUrl: 'https://x' });
    generateMarkdownMock.mockResolvedValue({
      title: 'gT',
      content: 'gC',
      tags: ['t'],
      excerpt: 'e',
    });

    const r = await runGenerate({ url: 'https://x' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload).toEqual({
        title: 'gT',
        content: 'gC',
        originalUrl: 'https://x',
        tags: ['t'],
        excerpt: 'e',
      });
    }
    expect(scrapeUrlMock).toHaveBeenCalledWith('https://x');
  });

  it('returns 400 when url is missing', async () => {
    const r = await runGenerate({});
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(scrapeUrlMock).not.toHaveBeenCalled();
  });

  it('returns 400 when url is not a string', async () => {
    const r = await runGenerate({ url: 123 as unknown as string });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });
});

// ---------------------------------------------------------------------------
// runGenerateManual
// ---------------------------------------------------------------------------

describe('runGenerateManual', () => {
  it('passes rawContent to generateMarkdown with manual title', async () => {
    generateMarkdownMock.mockResolvedValue({
      title: 'gT',
      content: 'gC',
      tags: [],
      excerpt: '',
    });

    const r = await runGenerateManual({
      rawContent: 'raw text',
      originalUrl: 'https://orig.com',
    });

    expect(generateMarkdownMock).toHaveBeenCalledWith({
      title: 'Manual Content',
      content: 'raw text',
      originalUrl: 'https://orig.com',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.originalUrl).toBe('https://orig.com');
  });

  it('defaults originalUrl to empty string when omitted', async () => {
    generateMarkdownMock.mockResolvedValue({
      title: 't',
      content: 'c',
      tags: [],
      excerpt: '',
    });

    const r = await runGenerateManual({ rawContent: 'raw' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.originalUrl).toBe('');
    expect(generateMarkdownMock).toHaveBeenCalledWith({
      title: 'Manual Content',
      content: 'raw',
      originalUrl: '',
    });
  });

  it('returns 400 when rawContent missing', async () => {
    const r = await runGenerateManual({});
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(generateMarkdownMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runGeneratePromo
// ---------------------------------------------------------------------------

describe('runGeneratePromo', () => {
  it('delegates to generatePromoMarkdown and shapes the response', async () => {
    generatePromoMarkdownMock.mockResolvedValue({
      title: 'pT',
      content: 'pC',
      tags: ['promo'],
      excerpt: 'pe',
    });

    const r = await runGeneratePromo({
      title: 'orig',
      content: 'body',
      urls: ['https://a.com', 'https://b.com'],
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload).toEqual({
        title: 'pT',
        content: 'pC',
        tags: ['promo'],
        excerpt: 'pe',
      });
    }
    expect(generatePromoMarkdownMock).toHaveBeenCalledWith('orig', 'body', [
      'https://a.com',
      'https://b.com',
    ]);
  });

  it('returns 400 when any of title / content / urls is missing', async () => {
    const r1 = await runGeneratePromo({ content: 'c', urls: [] });
    expect(r1).toMatchObject({ ok: false, status: 400 });

    const r2 = await runGeneratePromo({ title: 't', urls: [] });
    expect(r2).toMatchObject({ ok: false, status: 400 });

    const r3 = await runGeneratePromo({ title: 't', content: 'c' });
    expect(r3).toMatchObject({ ok: false, status: 400 });

    expect(generatePromoMarkdownMock).not.toHaveBeenCalled();
  });
});
