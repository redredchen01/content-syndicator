// ToolDefinition is defined here since we don't want circular dependencies
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: any;
}

export interface ToolContext {
  agentContext: any;
  [key: string]: any;
}

export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
  shouldStop?: boolean;
}

export abstract class AgentTool {
  abstract name: string;
  abstract description: string;
  abstract parameters: any;

  abstract execute(params: any, context: ToolContext): Promise<ToolResult>;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters,
    };
  }
}

import { logger } from '../utils/logger';

export class ToolRegistry {
  private tools: Map<string, AgentTool> = new Map();

  register(tool: AgentTool): void {
    this.tools.set(tool.name, tool);
    logger.info(`[ToolRegistry] Registered tool: ${tool.name}`);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  getAll(): AgentTool[] {
    return Array.from(this.tools.values());
  }

  getToolDefinitions(): ToolDefinition[] {
    return this.getAll().map(tool => tool.getDefinition());
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
}

// Import and register all tools
import { ScrapeTool } from './tools/scrape-tool';
import { GenerateContentTool } from './tools/generate-tool';
import { PublishTool } from './tools/publish-tool';
import { AnalyzeTool } from './tools/analyze-tool';
import { ReflectTool } from './tools/reflect-tool';

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new ScrapeTool());
  registry.register(new GenerateContentTool());
  registry.register(new PublishTool());
  registry.register(new AnalyzeTool());
  registry.register(new ReflectTool());
  return registry;
}
