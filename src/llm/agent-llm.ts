import { OpenAI } from 'openai';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import { ChatCompletionTool } from 'openai/resources/chat/completions';
import { retryOperation } from '../utils/retry';
import { RETRY_CONFIG } from '../constants';
import { logger } from '../utils/logger';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}

export interface LLMResponse {
  content: string;
  tool_calls?: any[];
  raw?: any;
}

export interface LLMWithToolsOptions {
  model?: string;
  messages: LLMMessage[];
  tools?: ChatCompletionTool[];
  temperature?: number;
  maxTokens?: number;
}

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
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  return await retryOperation(async () => {
    const response = await openai.chat.completions.create({
      model: options.model || 'gpt-4o-mini',
      messages: options.messages as any,
      tools: options.tools,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens,
    });

    const message = response.choices[0].message;

    return {
      content: message.content || '',
      tool_calls: message.tool_calls,
      raw: response,
    };
  }, RETRY_CONFIG.MAX_ATTEMPTS, RETRY_CONFIG.BASE_DELAY_MS, RETRY_CONFIG.MAX_DELAY_MS);
}

async function invokeGeminiWithTools(options: LLMWithToolsOptions): Promise<LLMResponse> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
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

  const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  ];

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

    return {
      content: text,
      tool_calls: [], // Simplified - full tool support would parse function calls from response
      raw: result,
    };
  }, RETRY_CONFIG.MAX_ATTEMPTS, RETRY_CONFIG.BASE_DELAY_MS, RETRY_CONFIG.MAX_DELAY_MS);
}

export async function invokeLLMSimple(prompt: string, fallbackContent?: string, fallbackTitle?: string): Promise<any> {
  const messages: LLMMessage[] = [
    { role: 'system', content: 'You output strictly JSON.' },
    { role: 'user', content: prompt },
  ];

  try {
    const response = await invokeLLMWithTools({ messages });
    if (!response.content) throw new Error('No output from LLM');
    return JSON.parse(response.content);
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
