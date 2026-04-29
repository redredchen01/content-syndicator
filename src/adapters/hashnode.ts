import { PlatformAdapter, PublishResult, PublishOptions } from './base';
import { logger } from '../utils/logger';

export class HashnodeAdapter implements PlatformAdapter {
  name = 'Hashnode';

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { title, markdownContent, originalUrl, publishStatus = 'draft', tags } = options;
    const token = process.env.HASHNODE_TOKEN;
    const publicationId = process.env.HASHNODE_PUBLICATION_ID;

    if (!token || !publicationId) {
      return {
        platform: this.name,
        success: false,
        error: 'HASHNODE_TOKEN or HASHNODE_PUBLICATION_ID is not configured in .env'
      };
    }

    try {
      const query = `
        mutation PublishPost($input: PublishPostInput!) {
          publishPost(input: $input) {
            post {
              url
            }
          }
        }
      `;

      let formattedTags = [{ slug: 'general', name: 'General' }];
      if (tags && tags.length > 0) {
        formattedTags = tags.map(t => {
           const cleaned = t.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
           return { slug: cleaned || 'general', name: t };
        });
      }

      const input = {
        title,
        contentMarkdown: markdownContent + (originalUrl ? `\n\n> Originally published at: ${originalUrl}` : ''),
        publicationId: publicationId,
        tags: formattedTags,
        originalArticleURL: originalUrl || undefined
      };

      const response = await fetch('https://gql.hashnode.com/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': token
        },
        body: JSON.stringify({ query, variables: { input } })
      });

      const data = await response.json();

      if (data.errors) {
        throw new Error(data.errors[0].message);
      }

      return {
        platform: this.name,
        success: true,
        publishedUrl: data.data.publishPost.post.url
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
