import { scrapeUrl } from './src/scraper';

async function test() {
  try {
    console.log('Testing scraper...');
    const data = await scrapeUrl('https://example.com');
    console.log('Success:', data.title);
  } catch (e) {
    console.error('Test Failed:', e);
  }
  process.exit(0);
}
test();
