import { ToolRegistry } from './tools';
import { AgentContext } from './core';
import { logger } from '../utils/logger';

export interface Plan {
  action: string;
  params: Record<string, any>;
  reasoning?: string;
  confidence?: number;
}

export class Planner {
  private tools: ToolRegistry;

  constructor(tools: ToolRegistry) {
    this.tools = tools;
  }

  async plan(context: AgentContext, task: string): Promise<Plan> {
    logger.info('[Planner] Creating plan based on current context...');

    // Decision logic based on context state
    const plan = this.decideNextAction(context, task);

    logger.info(`[Planner] Decision: ${plan.action} (confidence: ${plan.confidence || 'N/A'})`);
    if (plan.reasoning) {
      logger.info(`[Planner] Reasoning: ${plan.reasoning}`);
    }

    return plan;
  }

  private decideNextAction(context: AgentContext, task: string): Plan {
    // Check what's missing and decide next action

    // Step 1: Need to scrape content
    if (!context.scrapedData && context.originalUrl) {
      return {
        action: 'scrape_url',
        params: { url: context.originalUrl },
        reasoning: 'Content not yet scraped from URL',
        confidence: 0.95,
      };
    }

    // Step 2: Need to generate content
    if (context.scrapedData && !context.generatedContent) {
      return {
        action: 'generate_content',
        params: { mode: 'main' },
        reasoning: 'Content scraped, now generate optimized version',
        confidence: 0.9,
      };
    }

    // Step 3: Analyze generated content
    if (context.generatedContent && !context.metadata.analyzed) {
      return {
        action: 'analyze_content',
        params: {
          content: context.generatedContent.content,
          title: context.generatedContent.title,
        },
        reasoning: 'Content generated, analyze quality before publishing',
        confidence: 0.8,
      };
    }

    // Step 4: Publish content
    if (context.generatedContent && !context.publishResults) {
      return {
        action: 'publish_content',
        params: {
          title: context.generatedContent.title,
          content: context.generatedContent.content,
          tags: context.generatedContent.tags,
          excerpt: context.generatedContent.excerpt,
          publishStatus: 'draft',
        },
        reasoning: 'Content ready, proceed to publish',
        confidence: 0.85,
      };
    }

    // Step 5: Reflect and optimize
    if (context.publishResults && context.publishResults.length > 0) {
      const hasFailures = context.publishResults.some((r: any) => !r.success);
      if (hasFailures && !context.metadata.reflected) {
        return {
          action: 'reflect_and_optimize',
          params: {
            action: 'publish_content',
            result: { success: false },
          },
          reasoning: 'Publishing had failures, reflect and optimize',
          confidence: 0.7,
        };
      }
    }

    // Task complete
    return {
      action: 'complete',
      params: {},
      reasoning: 'All steps completed successfully',
      confidence: 1.0,
    };
  }
}
