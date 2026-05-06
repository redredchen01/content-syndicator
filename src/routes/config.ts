import express from 'express';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { resetLLMClients } from '../llm/client';
import { getRawPrompts, saveRawPrompts } from '../llm';
import { allAdapters } from '../adapters/index';
import { asyncRoute, syncRoute } from './_helpers';
import {
  AUTH_DIR,
  getBrowserAuthMode,
  getChromeUserDataDir,
  getChromeProfileDir,
  hasSavedBrowserSession,
} from '../services/browser-session';

export const router = express.Router();

let ENV_PATH = path.join(process.cwd(), '.env');
/** For tests only — redirect which file updateEnv reads/writes. */
export function _setEnvPath(p: string) { ENV_PATH = p; }

// ── Concurrency-safe .env writer ───────────────────────
// Promise-chain mutex: each caller queues behind the previous write.
// Atomic write (tmp → rename) prevents partial files on crash.
let _envWriteLock: Promise<void> = Promise.resolve();

function withEnvLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = _envWriteLock.then(fn);
  // Update lock to current op; swallow outcome so queue never stalls on error.
  _envWriteLock = result.then(() => undefined, () => undefined);
  return result;
}

function getMaskedEnv() {
  const mask = (val?: string) => val && val.length > 4 ? '*'.repeat(val.length - 4) + val.slice(-4) : (val ? '****' : '');

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

async function updateEnv(newConfig: Record<string, string>): Promise<void> {
  return withEnvLock(async () => {
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

    // Atomic write: tmp file → rename so a mid-write crash never corrupts .env
    const tmpPath = `${ENV_PATH}.tmp`;
    fs.writeFileSync(tmpPath, envContent.trim() + '\n', 'utf8');
    fs.renameSync(tmpPath, ENV_PATH);

    const llmKeys = ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'SELECTED_MODEL'];
    if (Object.keys(newConfig).some(k => llmKeys.includes(k))) {
      resetLLMClients();
    }
  });
}

router.get('/api/settings', (req, res) => {
  res.json(getMaskedEnv());
});

router.post('/api/settings', asyncRoute(async (req, res) => {
  const KEYS = [
    'GEMINI_API_KEY', 'OPENAI_API_KEY', 'DEVTO_API_KEY', 'MEDIUM_INTEGRATION_TOKEN',
    'GOOGLE_APPLICATION_CREDENTIALS_JSON', 'GOOGLE_SHEET_ID', 'SELECTED_MODEL',
    'GITHUB_TOKEN', 'HASHNODE_TOKEN', 'HASHNODE_PUBLICATION_ID', 'BLOGGER_BLOG_ID',
    'WORDPRESS_SITE_URL', 'WORDPRESS_USERNAME', 'WORDPRESS_APP_PASSWORD',
    'ENABLE_BROWSER_AUTOMATION', 'BROWSER_AUTH_MODE',
    'BROWSER_AUTH_CHROME_USER_DATA_DIR', 'BROWSER_AUTH_CHROME_PROFILE',
  ] as const;
  await updateEnv(Object.fromEntries(KEYS.map(k => [k, req.body[k]])));
  logger.success('Settings updated successfully via Web UI.');
  res.json({ success: true, message: 'Settings saved' });
}));

router.get('/api/models', asyncRoute(async (_, res) => {
  const models: { id: string; name: string; provider: string }[] = [];

  if (process.env.GEMINI_API_KEY) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`);
      if (r.ok) {
        const data = await r.json();
        data.models?.forEach((m: any) => {
          if (m.supportedGenerationMethods?.includes('generateContent') && m.name.includes('gemini')) {
            models.push({ id: m.name.replace('models/', ''), name: m.displayName, provider: 'Gemini' });
          }
        });
      }
    } catch { logger.warn('Failed to fetch Gemini models'); }
  }

  if (process.env.OPENAI_API_KEY) {
    try {
      const r = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      });
      if (r.ok) {
        const data = await r.json();
        data.data
          ?.filter((m: any) => ['gpt-4', 'gpt-3.5', 'o1', 'o3'].some(p => m.id.startsWith(p)))
          .forEach((m: any) => models.push({ id: m.id, name: m.id, provider: 'OpenAI' }));
      }
    } catch { logger.warn('Failed to fetch OpenAI models'); }
  }

  const PREFERRED = ['gemini-1.5-flash', 'gpt-4o-mini', 'gemini-1.5-pro', 'gpt-4o'];
  const recommended =
    PREFERRED.find(id => models.some(m => m.id === id)) ?? models[0]?.id ?? '';

  res.json({ models, recommended, selected: process.env.SELECTED_MODEL || recommended });
}));

router.get('/api/prompts', syncRoute((_, res) => res.json(getRawPrompts())));

router.post('/api/prompts', syncRoute((req, res) => {
  const { mainPrompt, promoPrompt } = req.body;
  saveRawPrompts(mainPrompt, promoPrompt);
  res.json({ success: true, message: 'Custom prompts saved successfully' });
}));
