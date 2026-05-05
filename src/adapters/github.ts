import { BaseAdapter, PublishResult, PublishOptions } from './base';

export class GitHubAdapter extends BaseAdapter {
  name = 'GitHub';

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { title, markdownContent, originalUrl } = options;
    const token = process.env.GITHUB_TOKEN;
    if (!token) return this.missingEnv('GITHUB_TOKEN');

    try {
      const filename = `${title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.md`;
      const response = await fetch('https://api.github.com/gists', {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github.v3+json',
          Authorization: `token ${token}`,
        },
        body: JSON.stringify({
          description: title,
          public: true,
          files: { [filename]: { content: this.withAttribution(markdownContent, originalUrl) } },
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Failed to create GitHub Gist');
      return this.ok(data.html_url);
    } catch (error: any) {
      return this.fail(error);
    }
  }
}
