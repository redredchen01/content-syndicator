import path from 'path';
import fs from 'fs';
import { Readable } from 'stream';
import { chromium } from 'playwright';
import { Extract } from 'unzipper';
import { acquirePage } from '../utils/browserManager';
import { PlatformAdapter } from '../adapters/base';
import { allAdapters } from '../adapters';

export const AUTH_DIR = path.join(process.cwd(), '.auth');
const DEFAULT_CHROME_USER_DATA_DIR = path.join(process.env.HOME || '', 'Library', 'Application Support', 'Google', 'Chrome');

export type BrowserAuthMode = 'chromium' | 'chrome-isolated' | 'chrome-profile';

export function getBrowserAuthMode(): BrowserAuthMode {
  const mode = process.env.BROWSER_AUTH_MODE;
  if (mode === 'chrome-isolated' || mode === 'chrome-profile') return mode;
  return 'chromium';
}

export function isBrowserAutomationEnabled() {
  return process.env.ENABLE_BROWSER_AUTOMATION === 'true';
}

export function getChromeProfileDir() {
  return process.env.BROWSER_AUTH_CHROME_PROFILE || 'Default';
}

export function getChromeUserDataDir() {
  return process.env.BROWSER_AUTH_CHROME_USER_DATA_DIR || DEFAULT_CHROME_USER_DATA_DIR;
}

export function getAdapterId(adapter: PlatformAdapter) {
  return adapter.name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function hasSavedBrowserSession(adapter: PlatformAdapter) {
  return fs.existsSync(path.join(AUTH_DIR, `${getAdapterId(adapter)}.json`));
}

export async function createBrowserAuthContext(platform: string) {
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

// Ensure auth directory exists on module load
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

export interface ImportSessionsResult {
  imported: string[];
  failed: Array<{ platform: string; error: string }>;
  tested: Record<string, { ok: boolean; error?: string }>;
}

export async function importSessions(zipBuffer: Buffer): Promise<ImportSessionsResult> {
  const result: ImportSessionsResult = { imported: [], failed: [], tested: {} };

  // Build a map of valid platform IDs
  const validPlatformIds = new Set(allAdapters.map(adapter => getAdapterId(adapter)));

  return new Promise((resolve, reject) => {
    const entries: Array<{ fileName: string; content: string }> = [];
    let processingError: Error | null = null;

    Readable.from([zipBuffer])
      .pipe(Extract({ path: AUTH_DIR }))
      .on('entry', (entry) => {
        const fileName = entry.path;

        // Only process files in .auth/ directory with .json extension
        if (!fileName.startsWith('.auth/') || !fileName.endsWith('.json')) {
          entry.autodrain();
          return;
        }

        let content = '';
        entry.on('data', (chunk) => {
          content += chunk.toString();
        });

        entry.on('end', () => {
          entries.push({ fileName, content });
        });

        entry.on('error', (err) => {
          if (!processingError) processingError = err;
        });
      })
      .on('error', (err) => {
        if (!processingError) processingError = err;
      })
      .on('finish', async () => {
        // Process all entries after extraction is done
        if (processingError) {
          reject(processingError);
          return;
        }

        try {
          for (const { fileName, content } of entries) {
            const platformId = fileName.replace('.auth/', '').replace('.json', '');

            // Validate platform ID
            if (!validPlatformIds.has(platformId)) {
              result.failed.push({ platform: platformId, error: 'Unknown platform' });
              continue;
            }

            try {
              const json = JSON.parse(content);

              // Validate basic structure (cookies and origins arrays)
              if (!Array.isArray(json.cookies) || !Array.isArray(json.origins)) {
                result.failed.push({ platform: platformId, error: 'Invalid session format: missing cookies or origins' });
                continue;
              }

              // Write to .auth directory
              const outputPath = path.join(AUTH_DIR, `${platformId}.json`);
              fs.writeFileSync(outputPath, content, 'utf-8');
              result.imported.push(platformId);

              // Test connection for imported platform
              const adapter = allAdapters.find(a => getAdapterId(a) === platformId);
              if (adapter) {
                const testResult = await adapter.testConnection();
                result.tested[platformId] = testResult;
              }
            } catch (e: any) {
              result.failed.push({ platform: platformId, error: `Invalid JSON: ${e.message}` });
            }
          }

          resolve(result);
        } catch (e) {
          reject(e);
        }
      });
  });
}
