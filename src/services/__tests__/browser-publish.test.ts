import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const ORIG_ENV = { ...process.env };

describe('executeBrowserPublish', () => {
  let tmpAuthFile: string;

  beforeEach(() => {
    process.env = { ...ORIG_ENV };
    tmpAuthFile = path.join(os.tmpdir(), `auth-${Date.now()}-${Math.random()}.json`);
  });

  afterEach(() => {
    process.env = { ...ORIG_ENV };
    if (fs.existsSync(tmpAuthFile)) fs.unlinkSync(tmpAuthFile);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns disabled error when ENABLE_BROWSER_AUTOMATION is not true', async () => {
    delete process.env.ENABLE_BROWSER_AUTOMATION;
    fs.writeFileSync(tmpAuthFile, '{}');

    const { executeBrowserPublish } = await import('../browser-publish');
    const result = await executeBrowserPublish({
      name: 'TestPlatform',
      authFile: tmpAuthFile,
      composeUrl: 'https://example.com/new',
      customAutomation: async () => 'https://example.com/post/1',
      options: { title: 't', markdownContent: 'm' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/disabled/);
  });

  it('returns auth-required error when authFile missing', async () => {
    process.env.ENABLE_BROWSER_AUTOMATION = 'true';

    const { executeBrowserPublish } = await import('../browser-publish');
    const result = await executeBrowserPublish({
      name: 'TestPlatform',
      authFile: '/nonexistent/path.json',
      composeUrl: 'https://example.com/new',
      customAutomation: async () => 'https://x',
      options: { title: 't', markdownContent: 'm' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/authenticate first/);
  });

  it('runs customAutomation and returns publishedUrl on success', async () => {
    process.env.ENABLE_BROWSER_AUTOMATION = 'true';
    fs.writeFileSync(tmpAuthFile, '{"cookies":[],"origins":[]}');

    const fakePage = { goto: vi.fn(), waitForTimeout: vi.fn() };
    const fakeContext = { close: vi.fn() };
    const fakeBrowser = { newContext: vi.fn().mockResolvedValue(fakeContext) };

    vi.doMock('../../utils/browserManager', () => ({
      getBrowser: vi.fn().mockResolvedValue(fakeBrowser),
      acquirePage: vi.fn().mockResolvedValue(fakePage),
      releasePage: vi.fn().mockResolvedValue(undefined),
    }));

    const customAutomation = vi.fn().mockResolvedValue('https://example.com/published/1');
    const { executeBrowserPublish } = await import('../browser-publish');
    const result = await executeBrowserPublish({
      name: 'TestPlatform',
      authFile: tmpAuthFile,
      composeUrl: 'https://example.com/new',
      customAutomation,
      options: { title: 't', markdownContent: 'm' },
    });

    expect(result.success).toBe(true);
    expect(result.publishedUrl).toBe('https://example.com/published/1');
    expect(customAutomation).toHaveBeenCalledOnce();
  });

  it('returns success with placeholder URL when customAutomation returns undefined', async () => {
    process.env.ENABLE_BROWSER_AUTOMATION = 'true';
    fs.writeFileSync(tmpAuthFile, '{"cookies":[],"origins":[]}');

    const fakePage = { goto: vi.fn(), waitForTimeout: vi.fn() };
    const fakeContext = { close: vi.fn() };
    const fakeBrowser = { newContext: vi.fn().mockResolvedValue(fakeContext) };

    vi.doMock('../../utils/browserManager', () => ({
      getBrowser: vi.fn().mockResolvedValue(fakeBrowser),
      acquirePage: vi.fn().mockResolvedValue(fakePage),
      releasePage: vi.fn().mockResolvedValue(undefined),
    }));

    const { executeBrowserPublish } = await import('../browser-publish');
    const result = await executeBrowserPublish({
      name: 'TestPlatform',
      authFile: tmpAuthFile,
      composeUrl: 'https://example.com/new',
      customAutomation: async () => undefined,
      options: { title: 't', markdownContent: 'm' },
    });

    expect(result.success).toBe(true);
    expect(result.publishedUrl).toContain('Auto-Published on TestPlatform');
  });

  it('cleans up page and context when customAutomation throws', async () => {
    process.env.ENABLE_BROWSER_AUTOMATION = 'true';
    fs.writeFileSync(tmpAuthFile, '{"cookies":[],"origins":[]}');

    const fakePage = { goto: vi.fn(), waitForTimeout: vi.fn() };
    const fakeContext = { close: vi.fn().mockResolvedValue(undefined) };
    const fakeBrowser = { newContext: vi.fn().mockResolvedValue(fakeContext) };

    const releasePage = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../utils/browserManager', () => ({
      getBrowser: vi.fn().mockResolvedValue(fakeBrowser),
      acquirePage: vi.fn().mockResolvedValue(fakePage),
      releasePage,
    }));

    const { executeBrowserPublish } = await import('../browser-publish');
    const result = await executeBrowserPublish({
      name: 'TestPlatform',
      authFile: tmpAuthFile,
      composeUrl: 'https://example.com/new',
      customAutomation: async () => { throw new Error('boom'); },
      options: { title: 't', markdownContent: 'm' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('boom');
    expect(releasePage).toHaveBeenCalled();
    expect(fakeContext.close).toHaveBeenCalled();
  });
});
