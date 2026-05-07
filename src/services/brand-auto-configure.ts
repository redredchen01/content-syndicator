import type { BrandProfile } from '../db/repositories';
import { scrapeUrl } from '../scraper';
import { getOpenAIClient, getGeminiClient } from '../llm/client';
import { logger } from '../utils/logger';

const UNIVERSAL_BLOCKLIST = [
  '作为我们',
  '本品牌',
  '本公司',
  '敝公司',
  '我们的产品',
  '官方推荐',
  '我们推荐',
  '我们提供',
];

export interface AutoConfigureResult {
  profile: Partial<BrandProfile>;
  warnings: string[];
  source: 'llm' | 'fallback';
}

export async function autoConfigureFromUrl(url: string): Promise<AutoConfigureResult> {
  const warnings: string[] = [];
  let source: 'llm' | 'fallback' = 'llm';

  try {
    const scraped = await scrapeUrl(url);
    logger.info(`[AutoConfig] Scraped ${url}: title="${scraped.title}"`);

    const llmResult = await extractBrandInfoWithLLM(url, scraped.title, scraped.content);
    const profile = buildProfileFromLLMResult(url, llmResult, warnings);

    return { profile, warnings, source };
  } catch (err) {
    logger.warn(`[AutoConfig] LLM extraction failed, using fallback: ${err}`);
    source = 'fallback';
    warnings.push('LLM 分析失败，使用基础信息');

    const fallbackProfile = buildFallbackProfile(url);
    return { profile: fallbackProfile, warnings, source };
  }
}

interface LLMExtractionResult {
  name?: string;
  name_variants?: string[];
  exposure_blocklist_extra?: string[];
  signature?: string;
}

async function extractBrandInfoWithLLM(
  url: string,
  title: string,
  content: string,
): Promise<LLMExtractionResult> {
  const contentExcerpt = content.substring(0, 2000);

  const prompt = `你是品牌信息提取专家。根据以下品牌网站内容，以 JSON 格式提取配置数据。

网站 URL: ${url}
网站标题: ${title}
网站内容摘要（前 2000 字）:
${contentExcerpt}

返回严格 JSON，字段如下：
{
  "name": "品牌/公司/产品名称（非空）",
  "name_variants": ["品牌名的其他写法或缩写，可为空数组"],
  "exposure_blocklist_extra": ["与品牌相关的身份暴露词，3-5 条，如品牌名本身、官方称谓等"],
  "signature": "可选的文章结尾追加文本，如版权声明，无则留空字符串"
}

只返回 JSON，不要有其他文字。`;

  // 尝试 Gemini 先
  if (process.env.GEMINI_API_KEY) {
    try {
      const gemini = getGeminiClient();
      const model = gemini.getGenerativeModel({
        model: 'gemini-1.5-flash',
        generationConfig: {
          responseMimeType: 'application/json',
        },
      });
      const response = await model.generateContent(prompt);
      const text = response.response.text();
      return JSON.parse(text);
    } catch (geminiErr) {
      logger.warn(`[AutoConfig] Gemini failed: ${geminiErr}`);
    }
  }

  // 降级到 OpenAI
  if (process.env.OPENAI_API_KEY) {
    try {
      const openai = getOpenAIClient();
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.7,
      });

      const text = response.choices[0]?.message?.content;
      if (!text) throw new Error('Empty LLM response');

      return JSON.parse(text);
    } catch (openaiErr) {
      logger.error(`[AutoConfig] OpenAI failed: ${openaiErr}`);
      throw openaiErr;
    }
  }

  throw new Error('No LLM API key configured (GEMINI_API_KEY or OPENAI_API_KEY)');
}

function buildProfileFromLLMResult(
  url: string,
  llmResult: LLMExtractionResult,
  warnings: string[],
): Partial<BrandProfile> {
  const name = llmResult.name?.trim();
  if (!name) {
    warnings.push('无法识别品牌名，请手动填写');
  }

  const nameVariants = llmResult.name_variants?.filter((v) => v?.trim()) ?? [];
  const extraBlocklist = llmResult.exposure_blocklist_extra?.filter((v) => v?.trim()) ?? [];

  // 构建禁用词列表
  const blocklist = new Set(UNIVERSAL_BLOCKLIST);
  if (name) blocklist.add(name);
  nameVariants.forEach((v) => blocklist.add(v));
  extraBlocklist.forEach((v) => blocklist.add(v));

  // 确保至少 5 条
  if (blocklist.size < 5) {
    warnings.push(`身份暴露禁用词不足 ${blocklist.size} 条，需至少 5 条。已添加默认词汇。`);
  }

  const targetUrls: Array<{ url: string; context_tag: string }> = [
    { url, context_tag: 'home' },
  ];

  return {
    name: name || '',
    target_urls: targetUrls,
    exposure_blocklist: Array.from(blocklist).slice(0, 20), // 限制数量
    name_variants: nameVariants,
    anchor_blocklist: [],
    signature: llmResult.signature?.trim() || '',
    anchor_concentration_threshold: 0.3,
    weekly_url_cap: 6,
    jaccard_threshold: 0.5,
    digest_channel: 'none',
  };
}

export function buildFallbackProfile(url: string): Partial<BrandProfile> {
  const hostname = new URL(url).hostname.replace(/^www\./, '');
  const name = hostname.split('.')[0];

  const blocklist = new Set(UNIVERSAL_BLOCKLIST);
  blocklist.add(name);

  return {
    name: name || 'Brand',
    target_urls: [{ url, context_tag: 'home' }],
    exposure_blocklist: Array.from(blocklist),
    name_variants: [],
    anchor_blocklist: [],
    signature: '',
    anchor_concentration_threshold: 0.3,
    weekly_url_cap: 6,
    jaccard_threshold: 0.5,
    digest_channel: 'none',
  };
}
