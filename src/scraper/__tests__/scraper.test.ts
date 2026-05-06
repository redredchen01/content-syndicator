import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted runs before ALL imports and vi.mock factories, so we use it to
// build mock objects that vi.mock closures can reference.
//
// child_process.execFile needs a util.promisify.custom symbol so that
// util.promisify(execFile) returns our directly-controllable async fn instead
// of wrapping the callback-style mock (which would break result.stdout access).
// ---------------------------------------------------------------------------
const hoisted = vi.hoisted(() => {
  const execFileCustom = vi.fn().mockResolvedValue({ stdout: '# Test Title\n\nMarkdown body', stderr: '' });
  const execFileFn = Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: execFileCustom,
  });

  const mockPage = {
    setDefaultNavigationTimeout: vi.fn(),
    setDefaultTimeout: vi.fn(),
    goto: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    content: vi.fn().mockResolvedValue(
      '<html><head><title>Page Title</title></head><body>' +
        '<article><h1>Article Heading</h1><p>Article body text.</p></article>' +
        '</body></html>',
    ),
    evaluate: vi.fn().mockResolvedValue('<html><body>fallback</body></html>'),
  };

  const mockContext = {
    close: vi.fn().mockResolvedValue(undefined),
  };

  const mockBrowser = {
    newContext: vi.fn().mockResolvedValue(mockContext),
  };

  return { execFileFn, execFileCustom, mockPage, mockContext, mockBrowser };
});

vi.mock('child_process', () => ({ execFile: hoisted.execFileFn }));

vi.mock('../../utils/browserManager', () => ({
  getBrowser: vi.fn().mockResolvedValue(hoisted.mockBrowser),
  acquirePage: vi.fn().mockResolvedValue(hoisted.mockPage),
  releasePage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getBrowser, acquirePage, releasePage } from '../../utils/browserManager';
import { scrapeUrl } from '../index';

const { execFileCustom, mockPage, mockContext, mockBrowser } = hoisted;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBrowser).mockResolvedValue(mockBrowser as any);
  vi.mocked(acquirePage).mockResolvedValue(mockPage as any);
  vi.mocked(releasePage).mockResolvedValue(undefined);
  mockPage.goto.mockResolvedValue(undefined);
  mockPage.waitForLoadState.mockResolvedValue(undefined);
  mockPage.waitForTimeout.mockResolvedValue(undefined);
  mockPage.content.mockResolvedValue(
    '<html><head><title>Page Title</title></head><body>' +
      '<article><h1>Article Heading</h1><p>Article body text.</p></article>' +
      '</body></html>',
  );
  execFileCustom.mockResolvedValue({ stdout: '# Test Title\n\nMarkdown body', stderr: '' });
});

describe('scrapeUrl', () => {
  it('happy path: returns title, content, and originalUrl', async () => {
    execFileCustom.mockResolvedValue({ stdout: '# My Article\n\nGreat content here', stderr: '' });

    const result = await scrapeUrl('https://example.com/article');

    expect(result.originalUrl).toBe('https://example.com/article');
    expect(result.content).toBe('# My Article\n\nGreat content here');
    expect(result.title).toBeTruthy();
    expect(mockPage.goto).toHaveBeenCalledWith('https://example.com/article', expect.any(Object));
  });

  it('calls releasePage and context.close in finally block', async () => {
    await scrapeUrl('https://example.com/article');

    expect(releasePage).toHaveBeenCalledWith(mockPage);
    expect(mockContext.close).toHaveBeenCalled();
  });

  it('extracts title from markitdown H1 when Readability finds no clear article', async () => {
    mockPage.content.mockResolvedValue(
      '<html><head></head><body><div>Unstructured text without article tag</div></body></html>',
    );
    execFileCustom.mockResolvedValue({ stdout: '# Title From Markdown\n\nContent', stderr: '' });

    const result = await scrapeUrl('https://example.com/');

    expect(result.title).toBe('Title From Markdown');
  });

  it('markitdown timeout (killed=true) — returns empty content, does not throw', async () => {
    const killErr = Object.assign(new Error('process killed'), { killed: true });
    execFileCustom.mockRejectedValue(killErr);

    const result = await scrapeUrl('https://example.com/article');

    expect(result.content).toBe('');
    expect(result.originalUrl).toBe('https://example.com/article');
    expect(releasePage).toHaveBeenCalled();
    expect(mockContext.close).toHaveBeenCalled();
  });

  it('markitdown non-timeout error — propagates as wrapped error', async () => {
    const execErr = Object.assign(new Error('markitdown not found'), { killed: false, code: 127 });
    execFileCustom.mockRejectedValue(execErr);

    await expect(scrapeUrl('https://example.com/article')).rejects.toThrow(
      'Failed to extract and clean article content',
    );
    expect(releasePage).toHaveBeenCalled();
  });

  it('navigation timeout — logs warn and continues to extract content', async () => {
    mockPage.goto.mockRejectedValue(new Error('Timeout exceeded waiting for page load'));
    const { logger } = await import('../../utils/logger');

    const result = await scrapeUrl('https://slow.example.com/');

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('Timeout waiting for full load'),
    );
    expect(result.originalUrl).toBe('https://slow.example.com/');
  });

  it('non-timeout navigation error — propagates as wrapped error', async () => {
    mockPage.goto.mockRejectedValue(new Error('net::ERR_NAME_NOT_RESOLVED'));

    await expect(scrapeUrl('https://nonexistent.invalid/')).rejects.toThrow(
      'Failed to extract and clean article content',
    );
  });

  it('markitdown returns empty stdout — content is empty string', async () => {
    execFileCustom.mockResolvedValue({ stdout: '', stderr: '' });

    const result = await scrapeUrl('https://example.com/article');

    expect(result.content).toBe('');
    expect(result.title).toBeTruthy();
  });
});
