import { OpenAI } from 'openai';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import { logger } from '../utils/logger';

let _openai: OpenAI | null = null;
let _gemini: GoogleGenerativeAI | null = null;

export const safetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

export function getOpenAIClient(): OpenAI {
  if (!_openai) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY is not configured');
    _openai = new OpenAI({ apiKey: key });
    logger.info('[LLM] OpenAI client initialized');
  }
  return _openai;
}

export function getGeminiClient(): GoogleGenerativeAI {
  if (!_gemini) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY is not configured');
    _gemini = new GoogleGenerativeAI(key);
    logger.info('[LLM] Gemini client initialized');
  }
  return _gemini;
}

/** Invalidates cached clients — call after API key changes via /api/settings. */
export function resetLLMClients(): void {
  _openai = null;
  _gemini = null;
  logger.info('[LLM] Clients reset — will reinitialize on next call');
}
