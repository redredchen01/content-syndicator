import { ChatCompletionTool } from 'openai/resources/chat/completions';
import { invokeLLMWithTools, LLMMessage } from '../llm/agent-llm';
import { ToolRegistry } from './tools';
import { AgentMemory } from './memory';
import { Planner } from './planner';
import { logger } from '../utils/logger';

export type AgentState = 'idle' | 'observing' | 'thinking' | 'acting' | 'reflecting' | 'completed' | 'error';

export interface AgentContext {
  taskId: string;
  originalUrl?: string;
  rawContent?: string;
  scrapedData?: any;
  generatedContent?: any;
  publishResults?: any[];
  errors: string[];
  metadata: Record<string, any>;
}

export interface AgentConfig {
  maxIterations?: number;
  enableReflection?: boolean;
  enableLearning?: boolean;
  verbose?: boolean;
}

export class ContentAgent {
  private state: AgentState = 'idle';
  private context: AgentContext;
  private tools: ToolRegistry;
  private memory: AgentMemory;
  private planner: Planner;
  private config: Required<AgentConfig>;
  private iterationCount = 0;

  constructor(config: AgentConfig = {}) {
    this.config = {
      maxIterations: config.maxIterations ?? 10,
      enableReflection: config.enableReflection ?? true,
      enableLearning: config.enableLearning ?? true,
      verbose: config.verbose ?? false,
    };

    this.context = {
      taskId: `task_${Date.now()}`,
      errors: [],
      metadata: {},
    };

    this.tools = new ToolRegistry();
    this.memory = new AgentMemory();
    this.planner = new Planner(this.tools);
  }

  setState(newState: AgentState) {
    const oldState = this.state;
    this.state = newState;
    if (this.config.verbose) {
      logger.info(`[Agent] State: ${oldState} → ${newState}`);
    }
  }

  async run(task: string, inputs: Record<string, any> = {}): Promise<AgentContext> {
    this.setState('observing');
    logger.info(`[Agent] Starting task: ${task}`);

    try {
      // Phase 1: Observe - Gather information
      await this.observe(task, inputs);

      // Phase 2: Think-Act loop with reflection
      while (this.iterationCount < this.config.maxIterations) {
        this.iterationCount++;
        logger.info(`[Agent] Iteration ${this.iterationCount}/${this.config.maxIterations}`);

        // Think: Plan next action
        this.setState('thinking');
        const plan = await this.planner.plan(this.context, task);

        if (plan.action === 'complete') {
          logger.success('[Agent] Task completed successfully');
          break;
        }

        // Act: Execute the planned action
        this.setState('acting');
        const result = await this.executeAction(plan);

        // Update context with result
        this.context.metadata.lastAction = plan.action;
        this.context.metadata.lastResult = result;

        // Reflect: Learn from the result
        if (this.config.enableReflection) {
          this.setState('reflecting');
          await this.reflect(plan, result);
        }

        // Check if we should stop
        if (plan.action === 'error' || result?.shouldStop) {
          break;
        }
      }

      if (this.iterationCount >= this.config.maxIterations) {
        logger.warn('[Agent] Max iterations reached');
      }

      this.setState('completed');
      return this.context;
    } catch (error: any) {
      this.setState('error');
      logger.error('[Agent] Fatal error:', error);
      this.context.errors.push(error.message);
      throw error;
    }
  }

  private async observe(task: string, inputs: Record<string, any>): Promise<void> {
    logger.info('[Agent] Observing inputs and gathering context...');

    // Store initial inputs
    if (inputs.url) this.context.originalUrl = inputs.url;
    if (inputs.rawContent) this.context.rawContent = inputs.rawContent;
    if (inputs.metadata) {
      this.context.metadata = { ...this.context.metadata, ...inputs.metadata };
    }

    // Load relevant memories
    const relevantMemories = await this.memory.recall(task, this.context);
    if (relevantMemories.length > 0) {
      logger.info(`[Agent] Recalled ${relevantMemories.length} relevant memories`);
      this.context.metadata.relevantMemories = relevantMemories;
    }
  }

  private async executeAction(plan: any): Promise<any> {
    const { action, params } = plan;
    logger.info(`[Agent] Executing action: ${action}`);

    try {
      const tool = this.tools.get(action);
      if (!tool) {
        throw new Error(`Tool not found: ${action}`);
      }

      // Create ToolContext wrapper
      const toolContext = { agentContext: this.context };
      const result = await tool.execute(params, toolContext);
      logger.success(`[Agent] Action ${action} completed`);
      return result;
    } catch (error: any) {
      logger.error(`[Agent] Action ${action} failed:`, error);
      this.context.errors.push(`Action ${action}: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  private async reflect(plan: any, result: any): Promise<void> {
    logger.info('[Agent] Reflecting on results...');

    // Store successful patterns in memory
    if (result?.success && this.config.enableLearning) {
      await this.memory.remember({
        type: 'success',
        action: plan.action,
        context: this.context,
        result,
      });
    }

    // Analyze errors and adjust strategy
    if (!result?.success && this.context.errors.length > 0) {
      logger.warn('[Agent] Analyzing failure and adjusting strategy...');
      // Could implement strategy adjustment here
    }
  }

  getContext(): AgentContext {
    return { ...this.context };
  }

  getState(): AgentState {
    return this.state;
  }

  getIterationCount(): number {
    return this.iterationCount;
  }
}
