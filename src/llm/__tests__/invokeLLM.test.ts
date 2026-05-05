import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the LLM client singleton so no real API keys are needed
vi.mock('../client', () => ({
  getOpenAIClient: vi.fn(),
  getGeminiClient: vi.fn(),
  safetySettings: [],
  resetLLMClients: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('fs', () => ({
  default: { existsSync: vi.fn().mockReturnValue(false), readFileSync: vi.fn(), writeFileSync: vi.fn() },
  existsSync: vi.fn().mockReturnValue(false),
}));

import { getOpenAIClient, getGeminiClient } from '../client';

const mockOpenAI = {
  chat: {
    completions: {
      create: vi.fn(),
    },
  },
};

const mockGemini = {
  getGenerativeModel: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getOpenAIClient).mockReturnValue(mockOpenAI as any);
  vi.mocked(getGeminiClient).mockReturnValue(mockGemini as any);
  process.env.SELECTED_MODEL = 'gpt-4o-mini';
  process.env.OPENAI_API_KEY = 'test-key';
  delete process.env.GEMINI_API_KEY;
});

describe('invokeLLM', () => {
  it('calls OpenAI and returns parsed JSON', async () => {
    mockOpenAI.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: '{"title":"Test","content":"Hello","tags":[],"excerpt":""}' } }],
    });

    const { invokeLLM } = await import('../index');
    const result = await invokeLLM('test prompt');

    expect(mockOpenAI.chat.completions.create).toHaveBeenCalledOnce();
    expect(result.title).toBe('Test');
  });

  it('falls back to Gemini when OpenAI fails and GEMINI_API_KEY is set', async () => {
    process.env.SELECTED_MODEL = 'gemini-1.5-flash';
    process.env.GEMINI_API_KEY = 'gemini-key';

    const mockModel = {
      generateContent: vi.fn().mockResolvedValue({
        response: { text: () => '{"title":"Gemini","content":"OK","tags":[],"excerpt":""}' },
      }),
    };
    mockGemini.getGenerativeModel.mockReturnValue(mockModel);

    const { invokeLLM } = await import('../index');
    const result = await invokeLLM('test prompt');

    expect(mockModel.generateContent).toHaveBeenCalledOnce();
    expect(result.title).toBe('Gemini');
  });

  it('returns fallback when Gemini fails with no OpenAI key configured', async () => {
    // Fallback is only used in Gemini branch when no OpenAI key is available
    process.env.SELECTED_MODEL = 'gemini-1.5-flash';
    process.env.GEMINI_API_KEY = 'gemini-key';
    delete process.env.OPENAI_API_KEY;

    const mockModel = {
      generateContent: vi.fn().mockRejectedValue(new Error('Gemini down')),
    };
    mockGemini.getGenerativeModel.mockReturnValue(mockModel);

    const { invokeLLM } = await import('../index');
    const result = await invokeLLM('test prompt', 'fallback content', 'Fallback Title');

    expect(result.title).toBe('Fallback Title');
    expect(result.content).toBe('fallback content');
  });
});
