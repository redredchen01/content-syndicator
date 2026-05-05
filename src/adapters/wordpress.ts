import { BaseAdapter, PublishResult, PublishOptions } from './base';

function escapeHtml(input: string) {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function markdownToHtml(markdown: string, originalUrl?: string): string {
  const html: string[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    const text = paragraph.join(' ').trim();
    if (text) html.push(`<p>${escapeHtml(text)}</p>`);
    paragraph = [];
  };

  for (const line of markdown.split('\n')) {
    const t = line.trim();
    if (!t) { flush(); continue; }

    const image = t.match(/^!\[([^\]]*)]\((https?:\/\/[^)]+)\)$/);
    if (image) { flush(); html.push(`<figure><img src="${escapeHtml(image[2])}" alt="${escapeHtml(image[1])}" /></figure>`); continue; }

    const heading = t.match(/^(#{1,4})\s+(.+)$/);
    if (heading) { flush(); const lvl = Math.min(heading[1].length + 1, 4); html.push(`<h${lvl}>${escapeHtml(heading[2])}</h${lvl}>`); continue; }

    const quote = t.match(/^>\s*(.+)$/);
    if (quote) { flush(); html.push(`<blockquote>${escapeHtml(quote[1])}</blockquote>`); continue; }

    const li = t.match(/^[-*]\s+(.+)$/);
    if (li) { flush(); html.push(`<p>&bull; ${escapeHtml(li[1])}</p>`); continue; }

    paragraph.push(t);
  }
  flush();

  if (originalUrl) {
    html.push(`<hr /><p><em>Originally published at: <a href="${escapeHtml(originalUrl)}">${escapeHtml(originalUrl)}</a></em></p>`);
  }

  return html.join('\n');
}

export class WordPressAdapter extends BaseAdapter {
  name = 'WordPress';
  canPublishAutomatically = true;

  async publish(options: PublishOptions): Promise<PublishResult> {
    const siteUrl = process.env.WORDPRESS_SITE_URL?.replace(/\/+$/, '');
    const username = process.env.WORDPRESS_USERNAME;
    const appPassword = process.env.WORDPRESS_APP_PASSWORD;
    if (!siteUrl || !username || !appPassword) {
      return this.missingEnv('WORDPRESS_SITE_URL', 'WORDPRESS_USERNAME', 'WORDPRESS_APP_PASSWORD');
    }

    try {
      const auth = Buffer.from(`${username}:${appPassword}`).toString('base64');
      const response = await fetch(`${siteUrl}/wp-json/wp/v2/posts`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: options.title,
          content: markdownToHtml(options.markdownContent, options.originalUrl),
          status: options.publishStatus === 'public' ? 'publish' : 'draft',
          excerpt: options.excerpt || undefined,
        }),
      });

      const text = await response.text();
      let data: any = {};
      try { data = text ? JSON.parse(text) : {}; } catch {
        throw new Error(`WordPress returned non-JSON (${response.status}): ${text.substring(0, 160)}`);
      }

      if (!response.ok) throw new Error(data.message || `WordPress API returned HTTP ${response.status}`);
      return this.ok(data.link || `${siteUrl}/wp-admin/post.php?post=${data.id}&action=edit`);
    } catch (error: any) {
      return this.fail(error);
    }
  }
}
