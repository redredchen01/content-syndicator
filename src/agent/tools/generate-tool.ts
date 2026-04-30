import { AgentTool, ToolContext, ToolResult } from '../tools';
import { generateMarkdown, generatePromoMarkdown } from '../../llm';
import { ScrapedData } from '../../scraper';
import { logger } from '../../utils/logger';

export class GenerateContentTool extends AgentTool {
  name = 'generate_content';
  description = 'Generate optimized content using LLM. Creates publish-ready Markdown with SEO metadata.';
  parameters = {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['main', 'promo'],
        description: 'Generation mode: "main" for article rewriting, "promo" for promotional content',
      },
      title: {
        type: 'string',
        description: 'Title to use (for promo mode, provide the original article title)',
      },
      content: {
        type: 'string',
        description: 'Content to process (for promo mode, provide original content snippet)',
      },
      urls: {
        type: 'array',
        items: { type: 'string' },
        description: 'URLs to include as backlinks (promo mode only)',
      },
    },
    required: ['mode'],
  };

  async execute(params: any, context: ToolContext): Promise<ToolResult> {
    try {
      const scrapedData = context.agentContext.scrapedData;
      if (!scrapedData && params.mode === 'main') {
        throw new Error('No scraped data available. Run scrape_url first.');
      }

      logger.info(`[GenerateTool] Mode: ${params.mode}`);

      if (params.mode === 'promo') {
        const result = await generatePromoMarkdown(
          params.title || scrapedData?.title || 'Untitled',
          params.content || scrapedData?.content || '',
          params.urls || []
        );

        context.agentContext.generatedPromo = result;
        return {
          success: true,
          data: {
            title: result.title,
            contentLength: result.content.length,
            tags: result.tags,
            excerpt: result.excerpt,
          },
        };
      } else {
        const result = await generateMarkdown(scrapedData as ScrapedData);

        context.agentContext.generatedContent = result;
        context.agentContext.metadata.generatedTitle = result.title;
        context.agentContext.metadata.generatedTags = result.tags;

        return {
          success: true,
          data: {
            title: result.title,
            contentLength: result.content.length,
            tags: result.tags,
            excerpt: result.excerpt,
          },
        };
      }
    } catch (error: any) {
      logger.error('[GenerateTool] Error:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }
}
