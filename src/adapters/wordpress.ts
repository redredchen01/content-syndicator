import { PlatformAdapter, PublishResult, PublishOptions } from './base';
import { logger } from '../utils/logger';

function escapeHtml(input: string) {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function markdownToHtml(markdown: string, originalUrl?: string) {
  const html: string[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    const text = paragraph.join(' ').trim();
    if (text) html.push(`<p>${escapeHtml(text)}</p>`);
    paragraph = [];
  };

  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      continue;
    }

    const image = trimmed.match(/^!\[([^\]]*)]\((https?:\/\/[^)]+)\)$/);
    if (image) {
      flushParagraph();
      html.push(`<figure><img src="${escapeHtml(image[2])}" alt="${escapeHtml(image[1])}" /></figure>`);
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      const level = Math.min(heading[1].length + 1, 4);
      html.push(`<h${level}>${escapeHtml(heading[2])}</h${level}>`);
      continue;
    }

    const quote = trimmed.match(/^>\s*(.+)$/);
    if (quote) {
      flushParagraph();
      html.push(`<blockquote>${escapeHtml(quote[1])}</blockquote>`);
      continue;
    }

    const listItem = trimmed.match(/^[-*]\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      html.push(`<p>&bull; ${escapeHtml(listItem[1])}</p>`);
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();

  if (originalUrl) {
    html.push(`<hr /><p><em>Originally published at: <a href="${escapeHtml(originalUrl)}">${escapeHtml(originalUrl)}</a></em></p>`);
  }

  return html.join('\n');
}

export class WordPressAdapter implements PlatformAdapter {
  name = 'WordPress';
  canPublishAutomatically = true;

  async publish(options: PublishOptions): Promise<PublishResult> {
    const siteUrl = process.env.WORDPRESS_SITE_URL?.replace(/\/+$/, '');
    const username = process.env.WORDPRESS_USERNAME;
    const appPassword = process.env.WORDPRESS_APP_PASSWORD;

    if (!siteUrl || !username || !appPassword) {
      return {
        platform: this.name,
        success: false,
        error: 'WORDPRESS_SITE_URL, WORDPRESS_USERNAME, or WORDPRESS_APP_PASSWORD is not configured in .env'
      };
    }

    try {
      const auth = Buffer.from(`${username}:${appPassword}`).toString('base64');
      const response = await fetch(`${siteUrl}/wp-json/wp/v2/posts`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          title: options.title,
          content: markdownToHtml(options.markdownContent, options.originalUrl),
          status: options.publishStatus === 'public' ? 'publish' : 'draft',
          excerpt: options.excerpt || undefined
        })
      });

      const text = await response.text();
      let data: any = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`WordPress returned a non-JSON response (${response.status}): ${text.substring(0, 160)}`);
      }

      if (!response.ok) {
        throw new Error(data.message || `WordPress API returned HTTP ${response.status}`);
      }

      return {
        platform: this.name,
        success: true,
        publishedUrl: data.link || `${siteUrl}/wp-admin/post.php?post=${data.id}&action=edit`
      };
    } catch (error: any) {
      logger.error(`[${this.name}] Publish failed`, error);
      return {
        platform: this.name,
        success: false,
        error: error.message
      };
    }
  }
}
