import { PlatformAdapter } from './base';
import { DevToAdapter } from './devto';
import { TelegraphAdapter } from './telegraph';
import { MediumAdapter } from './medium';
import { HashnodeAdapter } from './hashnode';
import { GitHubAdapter } from './github';
import { BloggerAdapter } from './blogger';
import { WordPressAdapter } from './wordpress';
import { BrowserAutomationAdapter } from './browser';

export const allAdapters: PlatformAdapter[] = [
  new TelegraphAdapter(),
  new DevToAdapter(),
  new MediumAdapter(),
  new HashnodeAdapter(),
  new GitHubAdapter(),
  new BloggerAdapter(),
  new WordPressAdapter(),
  // Browser Automation Adapters for complex/obscure sites
  new BrowserAutomationAdapter({
    name: 'Substack',
    authFileName: 'substack.json',
    composeUrl: 'https://substack.com/publish/post',
    // Custom automation could be implemented here, providing a generic fallback for MVP
  }),
  new BrowserAutomationAdapter({
    name: 'Twitter',
    authFileName: 'twitter.json',
    composeUrl: 'https://twitter.com/compose/tweet',
  }),
  new BrowserAutomationAdapter({
    name: 'Indie Hackers',
    authFileName: 'indiehackers.json',
    composeUrl: 'https://www.indiehackers.com/new-post',
  }),
  new BrowserAutomationAdapter({
    name: 'Quora',
    authFileName: 'quora.json',
    composeUrl: 'https://www.quora.com/',
  }),
  new BrowserAutomationAdapter({
    name: 'Product Hunt',
    authFileName: 'producthunt.json',
    composeUrl: 'https://www.producthunt.com/discussions/new',
  }),
  new BrowserAutomationAdapter({
    name: 'Instapaper',
    authFileName: 'instapaper.json',
    composeUrl: 'https://www.instapaper.com/save',
  }),
  // Niche Web 2.0 / Directories
  new BrowserAutomationAdapter({ name: 'ztndz', authFileName: 'ztndz.json', composeUrl: 'https://ztndz.com/new' }),
  new BrowserAutomationAdapter({ name: 'zopedirectory', authFileName: 'zopedirectory.json', composeUrl: 'https://zopedirectory.com/new' }),
  new BrowserAutomationAdapter({ name: 'zed-directory', authFileName: 'zed-directory.json', composeUrl: 'https://zed-directory.com/new' }),
  new BrowserAutomationAdapter({ name: 'youslade', authFileName: 'youslade.json', composeUrl: 'https://youslade.com/new' }),
  new BrowserAutomationAdapter({ name: 'yoursocialpeople', authFileName: 'yoursocialpeople.json', composeUrl: 'https://yoursocialpeople.com/new' }),
  new BrowserAutomationAdapter({ name: 'gharbaithejob', authFileName: 'gharbaithejob.json', composeUrl: 'https://gharbaithejob.com/new' })
];
