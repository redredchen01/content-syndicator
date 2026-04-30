import { AgentTool, ToolContext, ToolResult } from '../tools';
import { scrapeUrl, ScrapedData } from '../../scraper';
import { logger } from '../../utils/logger';

export class ScrapeTool extends AgentTool {
  name = 'scrape_url';
  description = 'Scrape content from a URL and extract readable article content with metadata';
  parameters = {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to scrape content from',
      },
    },
    required: ['url'],
  };

  async execute(params: { url: string }, context: ToolContext): Promise<ToolResult> {
    try {
      logger.info(`[ScrapeTool] Scraping URL: ${params.url}`);
      const scraped: ScrapedData = await scrapeUrl(params.url);

      // Update agent context
      context.agentContext.scrapedData = scraped;
      context.agentContext.originalUrl = params.url;

      return {
        success: true,
        data: {
          title: scraped.title,
          contentLength: scraped.content.length,
          hasContent: scraped.content.length > 0,
        },
      };
    } catch (error: any) {
      logger.error('[ScrapeTool] Error:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }
}
