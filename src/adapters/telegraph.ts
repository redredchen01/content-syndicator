import { BaseAdapter, PublishResult, PublishOptions, TestConnectionResult } from './base';

export class TelegraphAdapter extends BaseAdapter {
  name = 'Telegra.ph';
  canPublishAutomatically = true;
  private accessToken?: string;

  async testConnection(): Promise<TestConnectionResult> {
    try {
      const response = await fetch('https://api.telegra.ph/getPageList?access_token=test&limit=1');
      const data = await response.json();
      if (response.ok || data.ok === false) return { ok: true };
      return { ok: false, error: 'Failed to connect to Telegraph API' };
    } catch (error: any) {
      return { ok: false, error: `Network error: ${error.message}` };
    }
  }

  private safeTitle(title: string) {
    const cleaned = title.replace(/\s+/g, ' ').trim();
    return cleaned.substring(0, 240) || 'Published Article';
  }

  private markdownToNodes(markdown: string, originalUrl?: string) {
    const maxChars = 52000;
    const source = markdown.length > maxChars
      ? `${markdown.substring(0, maxChars)}\n\n[Content truncated for Telegra.ph size limits.]`
      : markdown;

    const nodes: any[] = [];
    if (originalUrl) {
      nodes.push({
        tag: 'p',
        children: [
          'Original source: ',
          { tag: 'a', attrs: { href: originalUrl }, children: [originalUrl] }
        ]
      });
    }

    const lines = source.split('\n');
    let paragraph: string[] = [];

    const flushParagraph = () => {
      const text = paragraph.join(' ').replace(/\s+/g, ' ').trim();
      if (text) nodes.push({ tag: 'p', children: [text] });
      paragraph = [];
    };

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        flushParagraph();
        continue;
      }

      const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        flushParagraph();
        nodes.push({ tag: heading[1].length === 1 ? 'h3' : 'h4', children: [heading[2].trim()] });
        continue;
      }

      const listItem = trimmed.match(/^[-*]\s+(.+)$/);
      if (listItem) {
        flushParagraph();
        nodes.push({ tag: 'p', children: [`• ${listItem[1].trim()}`] });
        continue;
      }

      const quote = trimmed.match(/^>\s*(.+)$/);
      if (quote) {
        flushParagraph();
        nodes.push({ tag: 'blockquote', children: [quote[1].trim()] });
        continue;
      }

      const image = trimmed.match(/^!\[[^\]]*]\((https?:\/\/[^)]+)\)$/);
      if (image) {
        flushParagraph();
        nodes.push({ tag: 'img', attrs: { src: image[1] } });
        continue;
      }

      paragraph.push(trimmed.replace(/\[([^\]]+)]\((https?:\/\/[^)]+)\)/g, '$1 ($2)'));
    }

    flushParagraph();
    return nodes.length > 0 ? nodes : [{ tag: 'p', children: ['No content provided.'] }];
  }

  private async parseTelegraphResponse(response: Response) {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Telegra.ph returned a non-JSON response (${response.status}). ${text.substring(0, 160).replace(/\s+/g, ' ')}`);
    }
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;

    const response = await fetch('https://api.telegra.ph/createAccount?short_name=SyndicatorAgent&author_name=ContentAgent');
    const data = await this.parseTelegraphResponse(response);
    
    if (data.ok) {
      this.accessToken = data.result.access_token;
      return this.accessToken!;
    }
    throw new Error('Failed to create Telegraph account');
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { title, markdownContent, originalUrl } = options;
    try {
      const token = await this.getAccessToken();
      const nodes = this.markdownToNodes(markdownContent, originalUrl);
      const body = new URLSearchParams({
        access_token: token,
        title: this.safeTitle(title),
        content: JSON.stringify(nodes),
        return_content: 'false'
      });

      const response = await fetch('https://api.telegra.ph/createPage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });
      const data = await this.parseTelegraphResponse(response);

      if (data.ok) return this.ok(data.result.url);
      throw new Error(data.error || 'Failed to publish to Telegraph');
    } catch (error: any) {
      return this.fail(error);
    }
  }
}
