import { chromium, Browser } from 'playwright';
import { logger } from './logger';

let globalBrowser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!globalBrowser || !globalBrowser.isConnected()) {
    logger.info('Initializing shared headless browser pool...');
    globalBrowser = await chromium.launch({ 
      headless: true,
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled' // Prevent Cloudflare/Google blocks
      ]
    });
  }
  return globalBrowser;
}

export async function closeBrowser(): Promise<void> {
  if (globalBrowser) {
    logger.info('Closing shared headless browser pool...');
    await globalBrowser.close();
    globalBrowser = null;
  }
}
