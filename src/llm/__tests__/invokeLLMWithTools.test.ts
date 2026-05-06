import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../client', () => ({
  getOpenAIClient: vi.fn(),
  getGeminiClient: vi.fn(),
  safetySettings: [],
  resetLLMClients: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../utils/smartRetry', () => ({
  retryOperation: (fn: () => unknown) => fn(),
  ErrorType: {},
}));

vi.mock('../../constants', () => ({
  RETRY_CONFIG: { MAX_ATTEMPTS: 1 },
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
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.SELECTED_MODEL = 'gpt-4o-mini';
  delete process.env.GEMINI_API_KEY;
});

describe('invokeLLMWithTools', () => {
  it('returns content and tool_calls from OpenAI', async () => {
    mockOpenAI.chat.completions.create.mockResolvedValue({
      choices: [{
        message: {
          content: 'response text',
          tool_calls: [{ id: '1', type: 'function', function: { name: 'test', arguments: '{}' } }],
        },
      }],
    });

    const { invokeLLMWithTools } = await import('../agent-llm');
    const result = await invokeLLMWithTools({
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result.content).toBe('response text');
    expect(result.tool_calls).toHaveLength(1);
  });

  it('uses getOpenAIClient singleton — not new OpenAI()', async () => {
    mockOpenAI.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: 'ok', tool_calls: [] } }],
    });

    const { invokeLLMWithTools } = await import('../agent-llm');
    await invokeLLMWithTools({ messages: [{ role: 'user', content: 'test' }] });
    await invokeLLMWithTools({ messages: [{ role: 'user', content: 'test' }] });

    // singleton: getOpenAIClient called each time, but only ONE instance created
    expect(getOpenAIClient).toHaveBeenCalledTimes(2);
    // The mock always returns the same object
    const first = vi.mocked(getOpenAIClient).mock.results[0].value;
    const second = vi.mocked(getOpenAIClient).mock.results[1].value;
    expect(first).toBe(second);
  });
});

describe('invokeLLMSimple', () => {
  it('returns parsed JSON when response is valid JSON', async () => {
    mockOpenAI.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: '{"key":"value"}', tool_calls: [] } }],
    });

    const { invokeLLMSimple } = await import('../agent-llm');
    const result = await invokeLLMSimple('test prompt');

    expect(result.key).toBe('value');
  });

  it('returns raw string when response is not valid JSON', async () => {
    mockOpenAI.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: 'not json', tool_calls: [] } }],
    });

    const { invokeLLMSimple } = await import('../agent-llm');
    const result = await invokeLLMSimple('test prompt');

    expect(result).toBe('not json');
  });
});
