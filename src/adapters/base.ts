export interface PublishResult {
  platform: string;
  success: boolean;
  publishedUrl?: string;
  error?: string;
}

export interface PublishOptions {
  title: string;
  markdownContent: string;
  originalUrl?: string;
  publishStatus?: 'draft' | 'public';
  tags?: string[];
  excerpt?: string;
}

export interface PlatformAdapter {
  name: string;
  isBrowserAutomation?: boolean;
  canPublishAutomatically?: boolean;
  publish(options: PublishOptions): Promise<PublishResult>;
}
