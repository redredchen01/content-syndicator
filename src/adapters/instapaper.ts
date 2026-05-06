import { BaseAdapter, PublishResult, PublishOptions, TestConnectionResult } from './base';

/**
 * Instapaper Simple API — saves a URL to the user's reading list.
 * Auth: HTTP Basic (username + password). No OAuth needed.
 * Doc: https://www.instapaper.com/api/simple
 */
export class InstapaperAdapter extends BaseAdapter {
  name = 'Instapaper';
  canPublishAutomatically = true;

  private basicAuth(): string | null {
    const u = process.env.INSTAPAPER_USERNAME;
    const p = process.env.INSTAPAPER_PASSWORD;
    if (!u || !p) return null;
    return `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
  }

  async testConnection(): Promise<TestConnectionResult> {
    if (!this.basicAuth()) {
      return { ok: false, error: 'INSTAPAPER_USERNAME and INSTAPAPER_PASSWORD not configured' };
    }
    return { ok: true };
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const auth = this.basicAuth();
    if (!auth) return this.missingEnv('INSTAPAPER_USERNAME', 'INSTAPAPER_PASSWORD');

    const url = options.originalUrl;
    if (!url) {
      return { platform: this.name, success: false, error: 'Instapaper requires originalUrl to save a bookmark' };
    }

    try {
      const body = new URLSearchParams({ url, title: options.title });
      if (options.excerpt) body.set('selection', options.excerpt);

      const res = await fetch('https://www.instapaper.com/api/add', {
        method: 'POST',
        headers: {
          Authorization: auth,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });

      // Simple API returns 201 on success, 200 if already saved
      if (res.status === 201 || res.status === 200) {
        return this.ok(`https://www.instapaper.com/u`);
      }
      throw new Error(`Instapaper returned HTTP ${res.status}`);
    } catch (err: any) {
      return this.fail(err);
    }
  }
}
