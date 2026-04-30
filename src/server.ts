import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import csv from 'csv-parser';
import { chromium } from 'playwright';
import { scrapeUrl } from './scraper';
import { generateMarkdown, generatePromoMarkdown, getRawPrompts, saveRawPrompts } from './llm';
import { PlatformAdapter } from './adapters/base';
import { allAdapters } from './adapters/index';
import { appendToSheet } from './sheets';
import { db, savePost, getPostsHistory } from './db';
import { logger, randomSleep } from './utils/logger';
import { getProfile, saveProfile, isReadyForDispatch } from './services/brand-profile';

export const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
// Serve static files from the public directory
app.use(express.static(path.join(__dirname, '../public')));

const upload = multer({ dest: path.join(process.cwd(), '.data', 'uploads') });

const ENV_PATH = path.join(process.cwd(), '.env');
const AUTH_DIR = path.join(process.cwd(), '.auth');
const DEFAULT_CHROME_USER_DATA_DIR = path.join(process.env.HOME || '', 'Library', 'Application Support', 'Google', 'Chrome');

type BrowserAuthMode = 'chromium' | 'chrome-isolated' | 'chrome-profile';

function getBrowserAuthMode(): BrowserAuthMode {
  const mode = process.env.BROWSER_AUTH_MODE;
  if (mode === 'chrome-isolated' || mode === 'chrome-profile') return mode;
  return 'chromium';
}

function isBrowserAutomationEnabled() {
  return process.env.ENABLE_BROWSER_AUTOMATION === 'true';
}

function getChromeProfileDir() {
  return process.env.BROWSER_AUTH_CHROME_PROFILE || 'Default';
}

function getChromeUserDataDir() {
  return process.env.BROWSER_AUTH_CHROME_USER_DATA_DIR || DEFAULT_CHROME_USER_DATA_DIR;
}

async function createBrowserAuthContext(platform: string) {
  const mode = getBrowserAuthMode();
  const viewport = null;
  const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

  if (mode === 'chrome-profile') {
    const context = await chromium.launchPersistentContext(getChromeUserDataDir(), {
      channel: 'chrome',
      headless: false,
      viewport,
      userAgent,
      args: [
        `--profile-directory=${getChromeProfileDir()}`,
        '--disable-blink-features=AutomationControlled',
        '--start-maximized'
      ]
    });

    return {
      mode,
      context,
      close: async () => context.close(),
      isConnected: () => Boolean(context.browser()?.isConnected())
    };
  }

  const launchOptions: any = {
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--start-maximized'
    ]
  };
  if (mode === 'chrome-isolated') launchOptions.channel = 'chrome';

  const browser = await chromium.launch(launchOptions);
  const authFile = path.join(AUTH_DIR, `${platform}.json`);
  const context = await browser.newContext({
    viewport,
    userAgent,
    ...(fs.existsSync(authFile) ? { storageState: authFile } : {})
  });

  return {
    mode,
    context,
    close: async () => browser.close(),
    isConnected: () => browser.isConnected()
  };
}

if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

function getAdapterId(adapter: PlatformAdapter) {
  return adapter.name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function hasSavedBrowserSession(adapter: PlatformAdapter) {
  return fs.existsSync(path.join(AUTH_DIR, `${getAdapterId(adapter)}.json`));
}

function isAdapterConnected(adapter: PlatformAdapter) {
  if (adapter.isBrowserAutomation) return isBrowserAutomationEnabled() && hasSavedBrowserSession(adapter);

  switch (adapter.name) {
    case 'Telegra.ph':
      return true;
    case 'Dev.to':
      return Boolean(process.env.DEVTO_API_KEY);
    case 'Medium':
      return Boolean(process.env.MEDIUM_INTEGRATION_TOKEN);
    case 'Hashnode':
      return Boolean(process.env.HASHNODE_TOKEN && process.env.HASHNODE_PUBLICATION_ID);
    case 'GitHub':
      return Boolean(process.env.GITHUB_TOKEN);
    case 'Blogger':
      return Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON && process.env.BLOGGER_BLOG_ID);
    case 'WordPress':
      return Boolean(process.env.WORDPRESS_SITE_URL && process.env.WORDPRESS_USERNAME && process.env.WORDPRESS_APP_PASSWORD);
    default:
      return false;
  }
}

function isDefaultPublishTarget(adapter: PlatformAdapter) {
  if (!isAdapterConnected(adapter)) return false;
  if (adapter.isBrowserAutomation) return Boolean(adapter.canPublishAutomatically);
  return true;
}

function getPlatformStatus(adapter: PlatformAdapter) {
  const connected = isAdapterConnected(adapter);
  const defaultEligible = isDefaultPublishTarget(adapter);

  let reason = '';
  if (!connected) {
    reason = adapter.isBrowserAutomation
      ? (isBrowserAutomationEnabled() ? 'No saved browser session' : 'Browser automation disabled to avoid controlling your desktop browser')
      : 'Missing required API configuration';
  } else if (!defaultEligible && adapter.isBrowserAutomation) {
    reason = 'Login saved, but stable auto-publish selectors are not configured';
  } else {
    reason = 'Ready for default auto-publish';
  }

  return { connected, defaultEligible, reason };
}

function getDefaultPublishingPlatforms() {
  return allAdapters.filter(isDefaultPublishTarget).map(a => a.name);
}

function resolveTargetPlatforms(platforms?: unknown) {
  if (Array.isArray(platforms) && platforms.length > 0) {
    return platforms.filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  }
  return getDefaultPublishingPlatforms();
}

async function publishToPlatforms(options: {
  sourceUrl: string;
  title: string;
  content: string;
  tags?: string[];
  excerpt?: string;
  platforms?: unknown;
  publishStatus?: 'draft' | 'public';
}) {
  const targetPlatforms = resolveTargetPlatforms(options.platforms);
  const adapters = allAdapters.filter(a => targetPlatforms.includes(a.name));

  if (adapters.length === 0) {
    throw new Error('No connected or valid platforms available. Connect at least one channel in Settings first.');
  }

  const results: any[] = [];
  logger.info(`API: Starting publishing process to ${adapters.map(a => a.name).join(', ')}...`);

  const publishStatus = options.publishStatus === 'public' ? 'public' : 'draft';
  const apiAdapters = adapters.filter(a => !a.isBrowserAutomation);
  const browserAdapters = adapters.filter(a => a.isBrowserAutomation);

  if (apiAdapters.length > 0) {
    logger.info(`API: Publishing concurrently to ${apiAdapters.length} API platforms...`);
    const apiPromises = apiAdapters.map(async (adapter) => {
      try {
        const result = await adapter.publish({
          title: options.title,
          markdownContent: options.content,
          tags: options.tags,
          excerpt: options.excerpt,
          originalUrl: options.sourceUrl,
          publishStatus
        });
        if (result.success) {
          logger.success(`[${adapter.name}] Published! URL: ${result.publishedUrl}`);
        } else {
          logger.error(`[${adapter.name}] Failed: ${result.error}`);
        }
        return result;
      } catch (error: any) {
        logger.error(`[${adapter.name}] Unexpected Error`, error);
        return { platform: adapter.name, success: false, error: error.message };
      }
    });
    const apiResults = await Promise.all(apiPromises);
    results.push(...apiResults);
  }

  if (browserAdapters.length > 0) {
    logger.info(`API: Publishing sequentially to ${browserAdapters.length} Browser platforms...`);
    for (let i = 0; i < browserAdapters.length; i++) {
      const adapter = browserAdapters[i];
      logger.info(`Publishing to ${adapter.name}...`);

      try {
        const result = await adapter.publish({
          title: options.title,
          markdownContent: options.content,
          tags: options.tags,
          excerpt: options.excerpt,
          originalUrl: options.sourceUrl,
          publishStatus
        });
        results.push(result);

        if (result.success) {
          logger.success(`[${adapter.name}] Published! URL: ${result.publishedUrl}`);
        } else {
          logger.error(`[${adapter.name}] Failed: ${result.error}`);
        }
      } catch (error: any) {
        logger.error(`[${adapter.name}] Unexpected Error`, error);
        results.push({ platform: adapter.name, success: false, error: error.message });
      }

      if (i < browserAdapters.length - 1) {
        const sleepTime = Math.floor(Math.random() * (15000 - 5000 + 1)) + 5000;
        logger.info(`Sleeping for ${sleepTime}ms before next browser platform...`);
        await randomSleep(sleepTime, sleepTime);
      }
    }
  }

  logger.info('API: Syncing results to Google Sheets...');
  await appendToSheet(options.sourceUrl, options.title, results);

  logger.info('API: Saving post to local database...');
  savePost(options.sourceUrl, options.title, options.content, results);

  return { targetPlatforms, results };
}

function getMaskedEnv() {
  const mask = (val?: string) => val && val.length > 4 ? '*'.repeat(val.length - 4) + val.slice(-4) : (val ? '****' : '');
  
  // Automatically scan for what cookies exist in .auth directory
  const authStatus: Record<string, boolean> = {};
  allAdapters.forEach(a => {
    authStatus[a.name] = hasSavedBrowserSession(a);
  });

  return {
    GEMINI_API_KEY: mask(process.env.GEMINI_API_KEY),
    OPENAI_API_KEY: mask(process.env.OPENAI_API_KEY),
    DEVTO_API_KEY: mask(process.env.DEVTO_API_KEY),
    MEDIUM_INTEGRATION_TOKEN: mask(process.env.MEDIUM_INTEGRATION_TOKEN),
    GITHUB_TOKEN: mask(process.env.GITHUB_TOKEN),
    HASHNODE_TOKEN: mask(process.env.HASHNODE_TOKEN),
    HASHNODE_PUBLICATION_ID: process.env.HASHNODE_PUBLICATION_ID || '',
    BLOGGER_BLOG_ID: process.env.BLOGGER_BLOG_ID || '',
    WORDPRESS_SITE_URL: process.env.WORDPRESS_SITE_URL || '',
    WORDPRESS_USERNAME: process.env.WORDPRESS_USERNAME || '',
    WORDPRESS_APP_PASSWORD: mask(process.env.WORDPRESS_APP_PASSWORD),
    ENABLE_BROWSER_AUTOMATION: process.env.ENABLE_BROWSER_AUTOMATION || '',
    BROWSER_AUTH_MODE: getBrowserAuthMode(),
    BROWSER_AUTH_CHROME_USER_DATA_DIR: getChromeUserDataDir(),
    BROWSER_AUTH_CHROME_PROFILE: getChromeProfileDir(),
    GOOGLE_APPLICATION_CREDENTIALS_JSON: process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ? '{"masked": true}' : '',
    GOOGLE_SHEET_ID: process.env.GOOGLE_SHEET_ID || '',
    AUTH_STATUS: authStatus
  };
}

function updateEnv(newConfig: Record<string, string>) {
  let envContent = '';
  if (fs.existsSync(ENV_PATH)) {
    envContent = fs.readFileSync(ENV_PATH, 'utf8');
  }

  for (const [key, value] of Object.entries(newConfig)) {
    if (value && value.trim() !== '') {
      process.env[key] = value.trim();
      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${key}=${value.trim()}`);
      } else {
        envContent += `\n${key}=${value.trim()}`;
      }
    }
  }
  fs.writeFileSync(ENV_PATH, envContent.trim() + '\n', 'utf8');
}

app.get('/api/settings', (req, res) => {
  res.json(getMaskedEnv());
});

app.get('/api/models', async (req, res) => {
  try {
    const models: { id: string, name: string, provider: string }[] = [];
    
    if (process.env.GEMINI_API_KEY) {
      try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`);
        if (response.ok) {
          const data = await response.json();
          data.models?.forEach((m: any) => {
            if (m.supportedGenerationMethods?.includes('generateContent') && m.name.includes('gemini')) {
              models.push({ id: m.name.replace('models/', ''), name: m.displayName, provider: 'Gemini' });
            }
          });
        }
      } catch (e) { logger.warn('Failed to fetch Gemini models'); }
    }
    
    if (process.env.OPENAI_API_KEY) {
      try {
        const response = await fetch('https://api.openai.com/v1/models', {
          headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` }
        });
        if (response.ok) {
          const data = await response.json();
          const chatModels = data.data?.filter((m: any) => m.id.startsWith('gpt-4') || m.id.startsWith('gpt-3.5') || m.id.startsWith('o1') || m.id.startsWith('o3'));
          chatModels?.forEach((m: any) => {
            models.push({ id: m.id, name: m.id, provider: 'OpenAI' });
          });
        }
      } catch (e) { logger.warn('Failed to fetch OpenAI models'); }
    }

    let recommended = '';
    // Recommendation logic: fast, cheap, smart models first
    if (models.find(m => m.id === 'gemini-1.5-flash')) recommended = 'gemini-1.5-flash';
    else if (models.find(m => m.id === 'gpt-4o-mini')) recommended = 'gpt-4o-mini';
    else if (models.find(m => m.id === 'gemini-1.5-pro')) recommended = 'gemini-1.5-pro';
    else if (models.find(m => m.id === 'gpt-4o')) recommended = 'gpt-4o';
    else if (models.length > 0) recommended = models[0].id;

    res.json({ models, recommended, selected: process.env.SELECTED_MODEL || recommended });
  } catch (error: any) {
    logger.error('API /api/models Error', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/settings', (req, res) => {
  try {
    const { 
      GEMINI_API_KEY, OPENAI_API_KEY, DEVTO_API_KEY, MEDIUM_INTEGRATION_TOKEN, 
      GOOGLE_APPLICATION_CREDENTIALS_JSON, GOOGLE_SHEET_ID, SELECTED_MODEL,
      GITHUB_TOKEN, HASHNODE_TOKEN, HASHNODE_PUBLICATION_ID, BLOGGER_BLOG_ID,
      WORDPRESS_SITE_URL, WORDPRESS_USERNAME, WORDPRESS_APP_PASSWORD,
      ENABLE_BROWSER_AUTOMATION, BROWSER_AUTH_MODE, BROWSER_AUTH_CHROME_USER_DATA_DIR, BROWSER_AUTH_CHROME_PROFILE
    } = req.body;
    updateEnv({ 
      GEMINI_API_KEY, OPENAI_API_KEY, DEVTO_API_KEY, MEDIUM_INTEGRATION_TOKEN, 
      GOOGLE_APPLICATION_CREDENTIALS_JSON, GOOGLE_SHEET_ID, SELECTED_MODEL,
      GITHUB_TOKEN, HASHNODE_TOKEN, HASHNODE_PUBLICATION_ID, BLOGGER_BLOG_ID,
      WORDPRESS_SITE_URL, WORDPRESS_USERNAME, WORDPRESS_APP_PASSWORD,
      ENABLE_BROWSER_AUTOMATION, BROWSER_AUTH_MODE, BROWSER_AUTH_CHROME_USER_DATA_DIR, BROWSER_AUTH_CHROME_PROFILE
    });
    logger.success('Settings updated successfully via Web UI.');
    res.json({ success: true, message: 'Settings saved' });
  } catch (error: any) {
    logger.error('Failed to save settings', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/prompts', (req, res) => {
  try {
    res.json(getRawPrompts());
  } catch (error: any) {
    logger.error('API /api/prompts Error', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/prompts', (req, res) => {
  try {
    const { mainPrompt, promoPrompt } = req.body;
    saveRawPrompts(mainPrompt, promoPrompt);
    res.json({ success: true, message: 'Custom prompts saved successfully' });
  } catch (error: any) {
    logger.error('Failed to save custom prompts', error);
    res.status(500).json({ error: error.message });
  }
});

// NEW: Endpoint to launch Playwright for Browser Auth (OAuth flow interception)
app.post('/api/auth/browser', async (req, res) => {
  if (!isBrowserAutomationEnabled()) {
    return res.status(403).json({
      error: 'Browser automation is disabled. Set ENABLE_BROWSER_AUTOMATION=true in .env only when you intentionally want to open controlled browser login windows.'
    });
  }

  const { platform } = req.body;
  
  // Find the adapter to get the composeUrl
  const adapter: any = allAdapters.find(a => a.name.toLowerCase().replace(/[^a-z0-9]/g, '') === platform);
  
  let loginUrl = '';
  if (platform === 'medium') loginUrl = 'https://medium.com/m/signin';
  else if (platform === 'devto') loginUrl = 'https://dev.to/enter';
  else if (platform === 'google' || platform === 'blogger') loginUrl = 'https://accounts.google.com/';
  else if (adapter && adapter.config && adapter.config.composeUrl) {
    loginUrl = adapter.config.composeUrl; // Just navigate to compose URL and let user log in
  } else {
    const platformName = adapter?.name || platform;
    return res.status(400).json({
      error: `${platformName} does not support browser OAuth in this app. Configure it in Publishing Platforms with its API token/application password instead.`
    });
  }

  try {
    const authSession = await createBrowserAuthContext(platform);
    const context = authSession.context;
    const page = await context.newPage();
    
    // Respond immediately to not block UI
    res.json({ success: true, message: `Opened ${authSession.mode} for ${platform}. Please log in and close the window to save your session.` });

    await page.goto(loginUrl);

    // Instead of waiting for page close (which might destroy context before saving), 
    // we poll and save the cookies periodically while the browser is open.
    const authFilePath = path.join(AUTH_DIR, `${platform}.json`);
    const saveInterval = setInterval(async () => {
      try {
        if (context && authSession.isConnected()) {
          await context.storageState({ path: authFilePath });
        } else {
          clearInterval(saveInterval);
        }
      } catch(e) {
        // Ignore errors during polling (e.g. if browser just closed)
        clearInterval(saveInterval);
      }
    }, 2000);

    context.on('close', () => {
      clearInterval(saveInterval);
      logger.success(`Browser closed for ${platform}. Cookies were saved periodically.`);
    });

  } catch (error: any) {
    logger.error('Browser Auth Error', error);
    const message = error?.message || 'Browser auth failed';
    const profileHint = getBrowserAuthMode() === 'chrome-profile'
      ? ' If you selected common Chrome profile mode, close all Chrome windows first or switch to Installed Chrome, separate profile.'
      : '';
    if (!res.headersSent) res.status(500).json({ error: `${message}${profileHint}` });
  }
});

// NEW: Endpoint to test saved cookies
app.post('/api/auth/test', async (req, res) => {
  if (!isBrowserAutomationEnabled()) {
    return res.status(403).json({
      error: 'Browser automation is disabled. Set ENABLE_BROWSER_AUTOMATION=true in .env only when you intentionally want to test saved browser sessions.'
    });
  }

  const { platform } = req.body;
  const authFile = path.join(AUTH_DIR, `${platform}.json`);

  if (!fs.existsSync(authFile)) {
    return res.status(400).json({ error: `No saved session found for ${platform}. Please Connect first.` });
  }

  const adapter: any = allAdapters.find(a => a.name.toLowerCase().replace(/[^a-z0-9]/g, '') === platform);
  const testUrl = adapter?.config?.composeUrl || 'https://google.com';

  try {
    const authSession = await createBrowserAuthContext(platform);
    const context = authSession.context;
    const page = await context.newPage();
    
    res.json({ success: true, message: `Testing ${platform} session in ${authSession.mode}. If you see the editor/dashboard, your cookies are valid!` });

    await page.goto(testUrl);

    page.on('close', async () => {
      // Optionally update the cookies when testing just in case they refreshed
      try {
        await context.storageState({ path: authFile });
      } catch(e) {}
      await authSession.close();
    });
  } catch (error: any) {
    logger.error('Browser Test Auth Error', error);
    const message = error?.message || 'Browser test failed';
    const profileHint = getBrowserAuthMode() === 'chrome-profile'
      ? ' If you selected common Chrome profile mode, close all Chrome windows first or switch to Installed Chrome, separate profile.'
      : '';
    if (!res.headersSent) res.status(500).json({ error: `${message}${profileHint}` });
  }
});

// =============================================================================
// v0.2 routes — third-party-voice syndicator (Plan Unit 3 onward)
// =============================================================================

app.get('/api/v2/brand-profile', (req, res) => {
  try {
    const profile = getProfile(db);
    const dispatch = isReadyForDispatch(db);
    res.json({ profile, dispatchReady: dispatch.ready, dispatchReport: dispatch.report });
  } catch (error: any) {
    logger.error('GET /api/v2/brand-profile error', error);
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/v2/brand-profile', (req, res) => {
  try {
    const body = req.body ?? {};
    if (typeof body !== 'object' || body === null) {
      return res.status(400).json({ error: 'JSON body required' });
    }
    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      return res.status(422).json({
        errors: [{ field: 'name', message: '品牌主名不能为空' }],
      });
    }
    const result = saveProfile(db, body);
    if (!result.ok) {
      return res.status(422).json({ errors: result.errors });
    }
    const dispatch = isReadyForDispatch(db);
    res.json({
      profile: result.profile,
      dispatchReady: dispatch.ready,
      dispatchReport: dispatch.report,
    });
  } catch (error: any) {
    logger.error('PUT /api/v2/brand-profile error', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/platforms', (req, res) => {
  try {
    const platforms = allAdapters.map(a => ({
      name: a.name,
      id: getAdapterId(a),
      ...getPlatformStatus(a),
      browserAutomation: Boolean(a.isBrowserAutomation),
      browserAuthSupported: Boolean(a.isBrowserAutomation),
      canPublishAutomatically: Boolean(a.canPublishAutomatically || !a.isBrowserAutomation)
    }));
    res.json({ platforms, defaults: getDefaultPublishingPlatforms() });
  } catch (error: any) {
    logger.error('API /api/platforms Error', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/generate', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    logger.info(`API: Starting scrape for URL: ${url}`);
    const scrapedData = await scrapeUrl(url);
    
    logger.info('API: Calling LLM to generate Markdown content...');
    const { title, content, tags, excerpt } = await generateMarkdown(scrapedData);

    res.json({ title, content, originalUrl: url, tags, excerpt });
  } catch (error: any) {
    logger.error('API /api/generate Error', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/generate-manual', async (req, res) => {
  try {
    const { rawContent, originalUrl } = req.body;
    if (!rawContent) return res.status(400).json({ error: 'rawContent is required' });

    logger.info('API: Calling LLM to rewrite Manual Markdown content...');
    
    // Create a mock ScrapedData object to feed into the existing generateMarkdown pipeline
    const mockScrapedData = {
      title: "Manual Content",
      content: rawContent,
      originalUrl: originalUrl || ''
    };
    
    const { title, content, tags, excerpt } = await generateMarkdown(mockScrapedData);

    res.json({ title, content, originalUrl, tags, excerpt });
  } catch (error: any) {
    logger.error('API /api/generate-manual Error', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/generate-promo', async (req, res) => {
  try {
    const { title, content, urls } = req.body;
    if (!title || !content || !urls || !Array.isArray(urls)) {
      return res.status(400).json({ error: 'Missing required fields: title, content, urls' });
    }

    logger.info('API: Calling LLM to generate Promotional Markdown content...');
    const promo = await generatePromoMarkdown(title, content, urls);

    res.json({ title: promo.title, content: promo.content, tags: promo.tags, excerpt: promo.excerpt });
  } catch (error: any) {
    logger.error('API /api/generate-promo Error', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/publish', async (req, res) => {
  try {
    const { url, title, content, tags, excerpt, platforms, publishStatus } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'Missing required fields' });

    const sourceUrl = url || 'manual-content';
    const { targetPlatforms, results } = await publishToPlatforms({
      sourceUrl,
      title,
      content,
      tags,
      excerpt,
      platforms,
      publishStatus: publishStatus === 'public' ? 'public' : 'draft'
    });

    res.json({ success: true, platforms: targetPlatforms, results });
  } catch (error: any) {
    logger.error('API /api/publish Error', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auto-publish', async (req, res) => {
  try {
    const { mode, url, rawContent, originalUrl, platforms, publishStatus } = req.body;
    const normalizedStatus = publishStatus === 'public' ? 'public' : 'draft';

    let sourceUrl = '';
    let generated;

    if (mode === 'manual') {
      if (!rawContent) return res.status(400).json({ error: 'rawContent is required for manual auto-publish' });

      sourceUrl = originalUrl || 'manual-content';
      logger.info('API: Auto-publish manual content. Generating markdown...');
      generated = await generateMarkdown({
        title: 'Manual Content',
        content: rawContent,
        originalUrl: sourceUrl
      });
    } else {
      if (!url) return res.status(400).json({ error: 'url is required for URL auto-publish' });

      sourceUrl = url;
      logger.info(`API: Auto-publish URL. Starting scrape for URL: ${url}`);
      const scrapedData = await scrapeUrl(url);

      logger.info('API: Auto-publish URL. Generating markdown...');
      generated = await generateMarkdown(scrapedData);
    }

    const { targetPlatforms, results } = await publishToPlatforms({
      sourceUrl,
      title: generated.title,
      content: generated.content,
      tags: generated.tags,
      excerpt: generated.excerpt,
      platforms,
      publishStatus: normalizedStatus
    });

    res.json({
      success: true,
      mode: mode === 'manual' ? 'manual' : 'url',
      platforms: targetPlatforms,
      title: generated.title,
      content: generated.content,
      tags: generated.tags,
      excerpt: generated.excerpt,
      originalUrl: sourceUrl,
      results
    });
  } catch (error: any) {
    logger.error('API /api/auto-publish Error', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/history', (req, res) => {
  try {
    const history = getPostsHistory();
    res.json(history);
  } catch (error: any) {
    logger.error('API /api/history Error', error);
    res.status(500).json({ error: error.message });
  }
});

// Bulk process queue function
async function processBulkQueue(urls: string[], targetPlatforms: string[], publishStatus: 'draft' | 'public') {
  logger.info(`Starting bulk queue processing for ${urls.length} URLs...`);
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    logger.info(`[Bulk ${i+1}/${urls.length}] Processing URL: ${url}`);
    
    try {
      logger.info(`[Bulk ${i+1}/${urls.length}] Scraping...`);
      const scrapedData = await scrapeUrl(url);
      
      logger.info(`[Bulk ${i+1}/${urls.length}] Generating markdown...`);
      const { title, content, tags, excerpt } = await generateMarkdown(scrapedData);

      logger.info(`[Bulk ${i+1}/${urls.length}] Publishing and saving results...`);
      await publishToPlatforms({
        sourceUrl: url,
        title,
        content,
        tags,
        excerpt,
        platforms: targetPlatforms,
        publishStatus
      });
      
      logger.success(`[Bulk ${i+1}/${urls.length}] Finished processing URL.`);
    } catch(err: any) {
      logger.error(`[Bulk ${i+1}/${urls.length}] Failed processing URL ${url}`, err);
    }

    // Sleep between articles to prevent overwhelming everything (30-60 seconds)
    if (i < urls.length - 1) {
      const sleepTime = Math.floor(Math.random() * (60000 - 30000 + 1)) + 30000;
      logger.info(`[Bulk] Sleeping for ${sleepTime/1000}s before next article...`);
      await randomSleep(sleepTime, sleepTime);
    }
  }
  logger.success('Bulk queue processing completed entirely.');
}

app.post('/api/bulk-publish', upload.single('file'), (req, res) => {
  try {
    const { platforms, publishStatus } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    let parsedPlatforms = platforms;
    try {
      if (typeof platforms === 'string') parsedPlatforms = JSON.parse(platforms);
    } catch(e) {}

    const targetPlatforms = resolveTargetPlatforms(parsedPlatforms);
    if (targetPlatforms.length === 0) {
      return res.status(400).json({ error: 'No connected platforms available. Connect at least one channel in Settings first.' });
    }

    const urls: string[] = [];

    // Parse CSV
    fs.createReadStream(req.file.path)
      .pipe(csv(['url'])) // Assumes first column or header is url
      .on('data', (data) => {
        const url = data.url || data[Object.keys(data)[0]]; // Grab the first column
        if (url && typeof url === 'string' && url.startsWith('http')) {
          urls.push(url.trim());
        }
      })
      .on('end', () => {
        // Remove uploaded file
        try { fs.unlinkSync(req.file!.path); } catch(e) {}

        if (urls.length === 0) {
          return res.status(400).json({ error: 'No valid URLs found in the CSV file.' });
        }

        // Start background processing
        processBulkQueue(urls, targetPlatforms, publishStatus === 'public' ? 'public' : 'draft');
        
        res.json({ success: true, message: `Bulk process started for ${urls.length} URLs in the background. You can safely close this page.` });
      });

  } catch (error: any) {
    logger.error('API /api/bulk-publish Error', error);
    res.status(500).json({ error: error.message });
  }
});
