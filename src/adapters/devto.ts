import { BaseAdapter, PublishResult, PublishOptions } from './base';

export class DevToAdapter extends BaseAdapter {
  name = 'Dev.to';

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { title, markdownContent, originalUrl, publishStatus = 'draft', tags, excerpt } = options;
    const apiKey = process.env.DEVTO_API_KEY;
    if (!apiKey) return this.missingEnv('DEVTO_API_KEY');

    try {
      const response = await fetch('https://dev.to/api/articles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
        body: JSON.stringify({
          article: {
            title,
            body_markdown: this.withAttribution(markdownContent, originalUrl),
            published: publishStatus === 'public',
            tags: tags ? tags.join(', ') : undefined,
            description: excerpt,
          },
        }),
      });

      const data = await response.json();
      if (response.ok) return this.ok(data.url);
      throw new Error(data.error || 'Failed to publish to Dev.to');
    } catch (error: any) {
      return this.fail(error);
    }
  }
}
