import { BaseAdapter, PublishResult, PublishOptions, TestConnectionResult } from './base';

export class HashnodeAdapter extends BaseAdapter {
  name = 'Hashnode';

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { title, markdownContent, originalUrl, tags } = options;
    const token = process.env.HASHNODE_TOKEN;
    const publicationId = process.env.HASHNODE_PUBLICATION_ID;
    if (!token || !publicationId) return this.missingEnv('HASHNODE_TOKEN', 'HASHNODE_PUBLICATION_ID');

    try {
      const query = `
        mutation PublishPost($input: PublishPostInput!) {
          publishPost(input: $input) { post { url } }
        }
      `;

      const formattedTags = tags?.length
        ? tags.map(t => {
            const slug = t.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
            return { slug: slug || 'general', name: t };
          })
        : [{ slug: 'general', name: 'General' }];

      const response = await fetch('https://gql.hashnode.com/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: token },
        body: JSON.stringify({
          query,
          variables: {
            input: {
              title,
              contentMarkdown: this.withAttribution(markdownContent, originalUrl),
              publicationId,
              tags: formattedTags,
              originalArticleURL: originalUrl,
            },
          },
        }),
      });

      const data = await response.json();
      if (data.errors) throw new Error(data.errors[0].message);
      return this.ok(data.data.publishPost.post.url);
    } catch (error: any) {
      return this.fail(error);
    }
  }

  async testConnection(): Promise<TestConnectionResult> {
    const token = process.env.HASHNODE_TOKEN;
    if (!token) return { ok: false, error: 'API key not configured' };

    try {
      const query = 'query { me { id name } }';
      const response = await fetch('https://gql.hashnode.com/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: token },
        body: JSON.stringify({ query }),
      });

      const data = await response.json();
      if (data.errors) return { ok: false, error: data.errors[0].message };
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: `Network error: ${error.message}` };
    }
  }
}
