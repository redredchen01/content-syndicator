import { AgentTool, ToolContext, ToolResult } from '../tools';
import { logger } from '../../utils/logger';

export class ReflectTool extends AgentTool {
  name = 'reflect_and_optimize';
  description = 'Reflect on previous actions and optimize strategy. Learns from successes and failures.';
  parameters = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'The action that was just performed',
      },
      result: {
        type: 'object',
        description: 'The result of the action',
      },
      error: {
        type: 'string',
        description: 'Any error that occurred',
      },
    },
    required: ['action'],
  };

  async execute(params: any, context: ToolContext): Promise<ToolResult> {
    try {
      logger.info(`[ReflectTool] Reflecting on action: ${params.action}`);

      const reflections: string[] = [];
      const optimizations: string[] = [];

      // Analyze result
      if (params.result?.success === false) {
        reflections.push(`Action ${params.action} failed: ${params.result.error}`);
        optimizations.push(`Consider alternative approach for ${params.action}`);
      } else if (params.result?.success) {
        reflections.push(`Action ${params.action} succeeded`);
      }

      // Check context for patterns
      const errors = context.agentContext.errors || [];
      if (errors.length > 0) {
        reflections.push(`Encountered ${errors.length} errors so far`);
        optimizations.push('Review error patterns and adjust strategy');
      }

      // Suggest next steps
      const suggestions = this.generateSuggestions(context.agentContext);

      return {
        success: true,
        data: {
          reflections,
          optimizations,
          suggestions,
          shouldContinue: suggestions.length > 0,
        },
      };
    } catch (error: any) {
      logger.error('[ReflectTool] Error:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  private generateSuggestions(agentContext: any): string[] {
    const suggestions: string[] = [];

    if (!agentContext.scrapedData) {
      suggestions.push('Run scrape_url to gather content');
    }

    if (!agentContext.generatedContent && agentContext.scrapedData) {
      suggestions.push('Run generate_content to create optimized content');
    }

    if (!agentContext.publishResults && agentContext.generatedContent) {
      suggestions.push('Run publish_content to distribute to platforms');
    }

    return suggestions;
  }
}
