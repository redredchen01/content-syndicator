const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('https://example.com');
  
  context.on('close', () => console.log('context closed'));
  page.on('close', () => console.log('page closed'));
  browser.on('disconnected', () => console.log('browser disconnected'));
})();
