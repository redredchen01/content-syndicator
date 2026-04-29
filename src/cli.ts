import inquirer from 'inquirer';
import { scrapeUrl } from './scraper';
import { generateMarkdown } from './llm';
import { PlatformAdapter } from './adapters/base';
import { DevToAdapter } from './adapters/devto';
import { TelegraphAdapter } from './adapters/telegraph';
import { MediumAdapter } from './adapters/medium';
import { appendToSheet } from './sheets';
import { logger, randomSleep } from './utils/logger';

export async function runCLI() {
  const { url } = await inquirer.prompt([
    {
      type: 'input',
      name: 'url',
      message: 'Please paste the source URL:',
      validate: (input) => {
        try {
          new URL(input);
          return true;
        } catch {
          return 'Please enter a valid URL.';
        }
      }
    }
  ]);

  logger.info(`Starting scrape for URL: ${url}`);
  const scrapedData = await scrapeUrl(url);
  logger.success(`Extracted: ${scrapedData.title}`);

  logger.info('Calling LLM to generate Markdown content...');
  const { title, content } = await generateMarkdown(scrapedData);

  console.log('\n--- PREVIEW ---');
  console.log(`Title: ${title}\n`);
  console.log(content.substring(0, 500) + '...\n[Content Truncated]');
  console.log('---------------\n');

  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Approve to publish to configured platforms?',
      default: false
    }
  ]);

  if (!confirm) {
    logger.warn('Publishing cancelled by user.');
    return;
  }

  const adapters: PlatformAdapter[] = [
    new TelegraphAdapter(),
    new DevToAdapter(),
    new MediumAdapter()
  ];

  const results = [];

  logger.info('Starting publishing process...');

  for (let i = 0; i < adapters.length; i++) {
    const adapter = adapters[i];
    logger.info(`Publishing to ${adapter.name}...`);
    
    const result = await adapter.publish({
      title,
      markdownContent: content,
      originalUrl: url,
      publishStatus: 'draft'
    });
    results.push(result);
    
    if (result.success) {
      logger.success(`[${adapter.name}] Published! URL: ${result.publishedUrl}`);
    } else {
      logger.error(`[${adapter.name}] Failed: ${result.error}`);
    }

    // Apply brake/damping: Random sleep between platforms
    if (i < adapters.length - 1) {
      const sleepTime = Math.floor(Math.random() * (15000 - 5000 + 1)) + 5000;
      logger.info(`Sleeping for ${sleepTime}ms before next platform...`);
      await randomSleep(sleepTime, sleepTime);
    }
  }

  logger.info('Syncing results to Google Sheets...');
  await appendToSheet(url, title, results);

  logger.success('Process completed.');
}
