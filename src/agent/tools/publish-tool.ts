import { AgentTool, ToolContext, ToolResult } from '../tools';
import { publishToPlatforms } from '../../services/publish-service';
import { logger } from '../../utils/logger';

export class PublishTool extends AgentTool {
  name = 'publish_content';
  description = 'Publish generated content to configured platforms. Supports selective platform targeting.';
  parameters = {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Title of the content to publish',
      },
      content: {
        type: 'string',
        description: 'Markdown content to publish',
      },
      platforms: {
        type: 'array',
        items: { type: 'string' },
        description: 'Target platforms (e.g., ["Dev.to", "Medium"]). Empty = use defaults',
      },
      publishStatus: {
        type: 'string',
        enum: ['draft', 'public'],
        description: 'Publish status: "draft" or "public"',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tags for the content',
      },
      excerpt: {
        type: 'string',
        description: 'SEO excerpt/summary',
      },
    },
    required: ['title', 'content'],
  };

  async execute(params: any, context: ToolContext): Promise<ToolResult> {
    try {
      const { title, content, platforms, publishStatus, tags, excerpt } = params;

      if (!title || !content) {
        throw new Error('Title and content are required');
      }

      logger.info(`[PublishTool] Publishing to platforms: ${platforms?.join(', ') || 'defaults'}`);

      const result = await publishToPlatforms({
        sourceUrl: context.agentContext.originalUrl || 'agent-generated',
        title,
        content,
        tags: tags || context.agentContext.metadata.generatedTags || [],
        excerpt: excerpt || '',
        platforms: platforms || [],
        publishStatus: publishStatus || 'draft',
      });

      context.agentContext.publishResults = result.results;

      const successCount = result.results.filter((r: any) => r.success).length;
      const totalCount = result.results.length;

      return {
        success: successCount > 0,
        data: {
          successCount,
          totalCount,
          platforms: result.targetPlatforms,
          results: result.results,
        },
        shouldStop: successCount === 0,
      };
    } catch (error: any) {
      logger.error('[PublishTool] Error:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }
}
