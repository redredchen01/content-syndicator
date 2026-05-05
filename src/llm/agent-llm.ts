import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { retryOperation } from '../utils/smartRetry';
import { RETRY_CONFIG } from '../constants';
import { logger } from '../utils/logger';
import type { LLMMessage, LLMResponse, LLMWithToolsOptions, ToolCall } from '../types';
import { getOpenAIClient, getGeminiClient, safetySettings } from './client';

// Re-export so existing callers (agent/core.ts) don't need to change imports
export type { LLMMessage, LLMResponse, LLMWithToolsOptions };

export async function invokeLLMWithTools(options: LLMWithToolsOptions): Promise<LLMResponse> {
  const selectedModel = options.model || process.env.SELECTED_MODEL || '';

  // Try OpenAI first if model is GPT or if it's the selected provider
  if (selectedModel.includes('gpt') || selectedModel.includes('o1') || selectedModel.includes('o3') || 
      (process.env.OPENAI_API_KEY && !selectedModel.includes('gemini'))) {
    return await invokeOpenAIWithTools(options);
  }

  // Try Gemini if model is Gemini or if it's the selected provider
  if (selectedModel.includes('gemini') || 
      (process.env.GEMINI_API_KEY && !selectedModel.includes('gpt'))) {
    try {
      return await invokeGeminiWithTools(options);
    } catch (error: any) {
      logger.warn(`[LLM] Gemini failed: ${error.message}`);
      // Fallback to OpenAI
      if (process.env.OPENAI_API_KEY) {
        logger.info('[LLM] Falling back to OpenAI...');
        return await invokeOpenAIWithTools(options);
      }
      throw error;
    }
  }

  throw new Error('No valid LLM provider configured');
}

async function invokeOpenAIWithTools(options: LLMWithToolsOptions): Promise<LLMResponse> {
  const openai = getOpenAIClient(); // throws if OPENAI_API_KEY not set

  return await retryOperation(async () => {
    const response = await openai.chat.completions.create({
      model: options.model || 'gpt-4o-mini',
      messages: options.messages as any,
      tools: options.tools as ChatCompletionTool[] | undefined,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens,
    });

    const message = response.choices[0].message;

    return {
      content: message.content || '',
      tool_calls: message.tool_calls as ToolCall[] | undefined,
      raw: response,
    };
  }, RETRY_CONFIG.MAX_ATTEMPTS);
}

async function invokeGeminiWithTools(options: LLMWithToolsOptions): Promise<LLMResponse> {
  const genAI = getGeminiClient(); // throws if GEMINI_API_KEY not set
  const model = genAI.getGenerativeModel({
    model: options.model || 'gemini-1.5-flash',
  });

  // Convert messages to Gemini format
  const contents = options.messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  // Add system message as first user message if present
  const systemMsg = options.messages.find(m => m.role === 'system');
  if (systemMsg) {
    contents.unshift({
      role: 'user',
      parts: [{ text: `[System Instruction]: ${systemMsg.content}` }],
    });
  }

  // safetySettings imported from ./client (shared with llm/index.ts)

  return await retryOperation(async () => {
    const result = await model.generateContent({
      contents,
      safetySettings,
      generationConfig: {
        temperature: options.temperature ?? 0.7,
        maxOutputTokens: options.maxTokens,
        // Note: Gemini Function Calling support would go here
        // This is a simplified version
      },
    });

    const text = result.response.text();

    logger.warn('[LLM] Gemini function calling not implemented, tool_calls will be empty');
    return {
      content: text,
      tool_calls: [],
      raw: result,
    };
  }, RETRY_CONFIG.MAX_ATTEMPTS);
}

export async function invokeLLMSimple(prompt: string, fallbackContent?: string, fallbackTitle?: string): Promise<any> {
  const messages: LLMMessage[] = [
    { role: 'system', content: 'You output strictly JSON.' },
    { role: 'user', content: prompt },
  ];

  try {
    const response = await invokeLLMWithTools({ messages });
    if (!response.content) throw new Error('No output from LLM');
    try {
      return JSON.parse(response.content);
    } catch {
      logger.warn('[LLM] invokeLLMSimple: response is not JSON, returning raw string');
      return response.content;
    }
  } catch (error: any) {
    if (fallbackContent && fallbackTitle) {
      return {
        title: fallbackTitle,
        content: fallbackContent,
      };
    }
    throw error;
  }
}
