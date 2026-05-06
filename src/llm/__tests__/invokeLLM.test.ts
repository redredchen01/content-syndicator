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

  it('throws when model is not configured', async () => {
    delete process.env.SELECTED_MODEL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    const { invokeLLM } = await import('../index');
    await expect(invokeLLM('test')).rejects.toThrow(/not configured/);
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

describe('generateMarkdown — empty content guard', () => {
  function mockOpenAIResponse(title: string, content: string) {
    mockOpenAI.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ title, content, tags: [], excerpt: '' }) } }],
    });
  }

  it('returns result when title and content are non-empty', async () => {
    mockOpenAIResponse('Good Title', 'Good content here');
    const { generateMarkdown } = await import('../index');
    const result = await generateMarkdown({ title: 'src', content: 'src content', url: 'http://x' });
    expect(result.title).toBe('Good Title');
    expect(result.content).toBe('Good content here');
  });

  it('throws when LLM returns empty title', async () => {
    mockOpenAIResponse('', 'Some content');
    const { generateMarkdown } = await import('../index');
    await expect(
      generateMarkdown({ title: 'src', content: 'src content', url: 'http://x' }),
    ).rejects.toThrow('LLM returned empty title or content');
  });

  it('throws when LLM returns whitespace-only content', async () => {
    mockOpenAIResponse('Title', '   ');
    const { generateMarkdown } = await import('../index');
    await expect(
      generateMarkdown({ title: 'src', content: 'src content', url: 'http://x' }),
    ).rejects.toThrow('LLM returned empty title or content');
  });

  it('throws when LLM returns null title', async () => {
    mockOpenAI.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ title: null, content: 'Content', tags: [], excerpt: '' }) } }],
    });
    const { generateMarkdown } = await import('../index');
    await expect(
      generateMarkdown({ title: 'src', content: 'src content', url: 'http://x' }),
    ).rejects.toThrow('LLM returned empty title or content');
  });
});

describe('generatePromoMarkdown — empty content guard', () => {
  it('throws when LLM returns empty title', async () => {
    mockOpenAI.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ title: '', content: 'Promo content', tags: [], excerpt: '' }) } }],
    });
    const { generatePromoMarkdown } = await import('../index');
    await expect(
      generatePromoMarkdown('Primary Title', 'Primary content', ['http://x']),
    ).rejects.toThrow('LLM returned empty title or content');
  });

  it('returns result when both title and content are non-empty', async () => {
    mockOpenAI.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ title: 'Promo', content: 'Promo body', tags: [], excerpt: '' }) } }],
    });
    const { generatePromoMarkdown } = await import('../index');
    const result = await generatePromoMarkdown('Primary Title', 'Primary content', ['http://x']);
    expect(result.title).toBe('Promo');
  });
});
