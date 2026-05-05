import { getOpenAIClient, getGeminiClient, safetySettings } from './client';
import { ScrapedData } from '../scraper';
import fs from 'fs';
import path from 'path';

const defaultMainPrompt = `You are a professional content editor and SEO expert.
You are given an extracted article in Markdown format (converted by markitdown).
Your task is to refine, re-write, and format this article into a high-quality Markdown format suitable for publishing on blogs (like Dev.to, Medium).
Keep the original images (Markdown format: ![alt](url)).
Ensure the output is well-structured, engaging, and maintains the core message.

CRITICAL REQUIREMENT: 
You MUST use the EXACT original language of the text. Do not translate. 
If the original text is in Simplified Chinese (简体中文), the output MUST be in Simplified Chinese (简体中文). 
If it is in English, output in English.

Also, generate up to 4 highly relevant tags (single words or short phrases, lowercase, no spaces preferred, e.g. "javascript", "ai", "web-dev") and a short SEO excerpt/summary (1-2 sentences).

Only output the JSON format below:
{
  "title": "A highly engaging title based on the original",
  "content": "The generated markdown content...",
  "tags": ["tag1", "tag2", "tag3", "tag4"],
  "excerpt": "A compelling 1-2 sentence SEO meta description summary of the article."
}

Original Title: {{title}}
Original Content:
{{content}}`;

const defaultPromoPrompt = `You are a content marketer and tech blogger.
Your task is to write a promotional "backlink" article that highly recommends a primary article you just read.
The promotional article should act as an independent review, summary, or teaser that naturally links back to the original article.
You must naturally include these URLs as backlinks within your markdown content. Here are the links you MUST promote:
{{urls}}

Ensure the output is engaging, well-structured, and significantly shorter than the original (around 300-500 words).
CRITICAL REQUIREMENT: You MUST use the EXACT original language of the text provided below.

Also, generate up to 4 highly relevant tags (single words or short phrases, lowercase, no spaces preferred) and a short SEO excerpt/summary (1-2 sentences) for this promotional article.

Original Primary Title: {{title}}
Original Primary Content snippet (first 3000 chars):
{{content}}

Only output the JSON format below:
{
  "title": "A catchy promotional title",
  "content": "The generated markdown promotional content with the required backlinks incorporated naturally...",
  "tags": ["tag1", "tag2", "tag3", "tag4"],
  "excerpt": "A compelling 1-2 sentence SEO meta description summary of the promo article."
}`;

export function getRawPrompts() {
  const pMain = path.join(process.cwd(), '.data', 'prompt_main.txt');
  const pPromo = path.join(process.cwd(), '.data', 'prompt_promo.txt');
  return {
    mainPrompt: fs.existsSync(pMain) ? fs.readFileSync(pMain, 'utf8') : defaultMainPrompt,
    promoPrompt: fs.existsSync(pPromo) ? fs.readFileSync(pPromo, 'utf8') : defaultPromoPrompt
  };
}

export function saveRawPrompts(main: string, promo: string) {
  const dataDir = path.join(process.cwd(), '.data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (main) fs.writeFileSync(path.join(dataDir, 'prompt_main.txt'), main, 'utf8');
  if (promo) fs.writeFileSync(path.join(dataDir, 'prompt_promo.txt'), promo, 'utf8');
}

export function getMainPrompt(title: string, content: string) {
  return getRawPrompts().mainPrompt.replace('{{title}}', title).replace('{{content}}', content);
}

export function getPromoPrompt(title: string, content: string, urls: string[]) {
  const urlStr = urls.map(u => `- ${u}`).join('\n');
  return getRawPrompts().promoPrompt.replace('{{title}}', title).replace('{{content}}', content).replace('{{urls}}', urlStr);
}

export async function invokeLLM(prompt: string, fallbackContent?: string, fallbackTitle?: string): Promise<any> {
  const selectedModel = process.env.SELECTED_MODEL || '';

  const runOpenAI = async (modelName: string) => {
    const openai = getOpenAIClient();
    const response = await openai.chat.completions.create({
      model: modelName,
      messages: [
        { role: "system", content: "You output strictly JSON." },
        { role: "user", content: prompt }
      ],
      response_format: { type: "json_object" }
    });

    const resultString = response.choices[0].message.content;
    if (!resultString) throw new Error("No output from OpenAI LLM");
    return JSON.parse(resultString);
  };

  if (selectedModel.includes('gemini') && process.env.GEMINI_API_KEY) {
    try {
      const genAI = getGeminiClient();
      const model = genAI.getGenerativeModel({ model: selectedModel });

      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        safetySettings,
        generationConfig: { responseMimeType: "application/json" }
      });
      
      const text = result.response.text();
      if (!text) throw new Error("No output from Gemini");
      return JSON.parse(text);
    } catch (error: any) {
      console.warn(`[LLM Warn] Gemini generation failed: ${error.message}`);
      if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim() !== '') {
        console.info(`[LLM Info] Falling back to OpenAI (gpt-4o-mini)...`);
        return await runOpenAI("gpt-4o-mini");
      }
      
      if (fallbackContent && fallbackTitle) {
        console.warn(`[LLM Warn] No OpenAI API Key available for fallback. Bypassing LLM and returning raw markdown.`);
        return {
          title: fallbackTitle,
          content: fallbackContent
        };
      }
      throw error;
    }
  } else if ((selectedModel.includes('gpt') || selectedModel.includes('o1') || selectedModel.includes('o3')) && process.env.OPENAI_API_KEY) {
    return await runOpenAI(selectedModel);
  } else {
    throw new Error('The selected model is not configured properly in your environment settings.');
  }
}

export async function generateMarkdown(scraped: ScrapedData): Promise<{ title: string, content: string, tags?: string[], excerpt?: string }> {
  const prompt = getMainPrompt(scraped.title, scraped.content);

  const fallbackTitle = scraped.title || "Extracted Article";
  const fallbackContent = `> **🛡️ 智能绕过系统提示 (Bypass System):**\n> 您的这篇内容由于触发了 Google Gemini 无法关闭的底层最高级别强制安全审核 (\`PROHIBITED_CONTENT\`) 而被大模型拒绝处理。\n> \n> 由于您没有绑定 OpenAI 作为备用模型，为了保证您的工作流不被中断，**系统已自动绕过大模型，直接为您提取并展示了原文的原始 Markdown 代码！**\n> \n> 您可以直接在下方手动编辑，然后点击发布。\n\n---\n\n${scraped.content}`;

  return invokeLLM(prompt, fallbackContent, fallbackTitle);
}

export async function generatePromoMarkdown(primaryTitle: string, primaryContent: string, urls: string[]): Promise<{ title: string, content: string, tags?: string[], excerpt?: string }> {
  const prompt = getPromoPrompt(primaryTitle, primaryContent.substring(0, 3000), urls);

  const fallbackTitle = `Promo for: ${primaryTitle}`;
  const fallbackContent = `> **⚠️ Promo LLM Warning:** LLM Generation Failed. \n\nPlease manually write the promotional content. Here are the links to include:\n${urls.map(url => `- ${url}`).join('\n')}`;

  return invokeLLM(prompt, fallbackContent, fallbackTitle);
}

export async function analyzeDOMForSelectors(domSnapshot: string, platformName: string): Promise<{ titleSelector: string, contentSelector: string, publishButtonSelector: string }> {
  const prompt = `
You are an expert web automation engineer. Your task is to analyze the provided simplified DOM snapshot of a posting/composing page on the platform "${platformName}" and identify the exact CSS selectors for three key elements.

You must find the optimal CSS selector for:
1. "titleSelector": The input field or textarea for the article's Title.
2. "contentSelector": The main editor area (textarea, contenteditable div, or generic editor element like [data-placeholder="Story..."]) for the Body/Content of the article.
3. "publishButtonSelector": The button used to submit or publish the post.

Only output the JSON format below:
{
  "titleSelector": "css selector string",
  "contentSelector": "css selector string",
  "publishButtonSelector": "css selector string"
}

Simplified DOM Snapshot:
${domSnapshot}
`;
  return invokeLLM(prompt);
}
