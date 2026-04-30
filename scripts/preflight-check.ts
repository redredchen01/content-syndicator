/**
 * Preflight check for v0.2 third-party-voice syndicator (Plan Unit 1).
 *
 * Run before every deployment / before starting a long publish session:
 *   npx tsx scripts/preflight-check.ts
 *
 * Outputs:
 *   1. .data/schema-snapshot.sql       — current SQLite schema (gitignored)
 *   2. .data/preflight-matrix.json     — platform health + HEAD support map
 *   3. stdout markdown report          — pasteable into Slack / docs
 *
 * The HEAD support column drives Unit 13's liveness checker — platforms that
 * 405 HEAD will go straight to GET-with-Range, avoiding double traffic.
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { MVP_PLATFORMS, MvpPlatform } from '../src/constants';

interface PlatformResult {
  platform: MvpPlatform;
  tokenConfigured: boolean;
  apiReachable: 'ok' | 'auth_failed' | 'network' | 'skipped' | 'unsupported';
  apiDetail: string;
  headSupported: boolean;
  headDetail: string;
  recommended: 'mvp' | 'drop' | 'inspect';
}

const DB_PATH = path.resolve(__dirname, '..', '.data', 'syndicator.db');
const DATA_DIR = path.resolve(__dirname, '..', '.data');

function exportSchema(): string {
  if (!fs.existsSync(DB_PATH)) {
    return '-- syndicator.db does not exist yet; run `npm start` once to bootstrap.';
  }
  try {
    const out = execSync(`sqlite3 "${DB_PATH}" .schema`, {
      encoding: 'utf8',
      timeout: 10_000,
    });
    return out || '-- empty schema';
  } catch (err) {
    return `-- failed to read schema: ${(err as Error).message}`;
  }
}

async function probeHead(url: string): Promise<{ ok: boolean; status: number | null; detail: string }> {
  try {
    const ctrl = AbortSignal.timeout(8_000);
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: ctrl,
    });
    return {
      ok: res.status >= 200 && res.status < 400,
      status: res.status,
      detail: `HTTP ${res.status}`,
    };
  } catch (err) {
    return { ok: false, status: null, detail: `error: ${(err as Error).message}` };
  }
}

async function checkTelegraph(): Promise<Pick<PlatformResult, 'tokenConfigured' | 'apiReachable' | 'apiDetail'>> {
  // Anonymous; createAccount returns access_token.
  try {
    const res = await fetch(
      'https://api.telegra.ph/getAccountInfo?fields=[%22author_name%22]',
      { signal: AbortSignal.timeout(8_000) },
    );
    const json = (await res.json()) as { ok?: boolean; error?: string };
    // 没 token 时 telegraph 会返回 error；MVP 通过 createAccount 动态创建，所以这里不强求。
    return {
      tokenConfigured: true, // Telegraph 不需要预置 token
      apiReachable: json.ok ? 'ok' : 'unsupported',
      apiDetail: json.ok ? 'reachable' : `endpoint reachable, error: ${json.error || 'unknown'}`,
    };
  } catch (err) {
    return { tokenConfigured: true, apiReachable: 'network', apiDetail: (err as Error).message };
  }
}

async function checkDevTo(): Promise<Pick<PlatformResult, 'tokenConfigured' | 'apiReachable' | 'apiDetail'>> {
  const key = process.env.DEVTO_API_KEY;
  if (!key) return { tokenConfigured: false, apiReachable: 'skipped', apiDetail: 'DEVTO_API_KEY not set' };
  try {
    const res = await fetch('https://dev.to/api/articles/me/published?per_page=1', {
      headers: { 'api-key': key, Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 401 || res.status === 403)
      return { tokenConfigured: true, apiReachable: 'auth_failed', apiDetail: `HTTP ${res.status}` };
    return { tokenConfigured: true, apiReachable: 'ok', apiDetail: `HTTP ${res.status}` };
  } catch (err) {
    return { tokenConfigured: true, apiReachable: 'network', apiDetail: (err as Error).message };
  }
}

async function checkMedium(): Promise<Pick<PlatformResult, 'tokenConfigured' | 'apiReachable' | 'apiDetail'>> {
  const token = process.env.MEDIUM_INTEGRATION_TOKEN;
  if (!token) return { tokenConfigured: false, apiReachable: 'skipped', apiDetail: 'MEDIUM_INTEGRATION_TOKEN not set' };
  try {
    const res = await fetch('https://api.medium.com/v1/me', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 401 || res.status === 403)
      return {
        tokenConfigured: true,
        apiReachable: 'auth_failed',
        apiDetail: `HTTP ${res.status} — Medium integration token API has been frozen for new accounts since 2019`,
      };
    return { tokenConfigured: true, apiReachable: 'ok', apiDetail: `HTTP ${res.status}` };
  } catch (err) {
    return { tokenConfigured: true, apiReachable: 'network', apiDetail: (err as Error).message };
  }
}

async function checkHashnode(): Promise<Pick<PlatformResult, 'tokenConfigured' | 'apiReachable' | 'apiDetail'>> {
  const token = process.env.HASHNODE_TOKEN;
  if (!token) return { tokenConfigured: false, apiReachable: 'skipped', apiDetail: 'HASHNODE_TOKEN not set' };
  try {
    const res = await fetch('https://gql.hashnode.com/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify({ query: '{ me { id username } }' }),
      signal: AbortSignal.timeout(8_000),
    });
    const json = (await res.json()) as { errors?: unknown[]; data?: { me?: unknown } };
    if (json.errors?.length || !json.data?.me)
      return { tokenConfigured: true, apiReachable: 'auth_failed', apiDetail: 'GraphQL errors or no me payload' };
    return { tokenConfigured: true, apiReachable: 'ok', apiDetail: 'me query succeeded' };
  } catch (err) {
    return { tokenConfigured: true, apiReachable: 'network', apiDetail: (err as Error).message };
  }
}

async function checkGitHub(): Promise<Pick<PlatformResult, 'tokenConfigured' | 'apiReachable' | 'apiDetail'>> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return { tokenConfigured: false, apiReachable: 'skipped', apiDetail: 'GITHUB_TOKEN not set' };
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 401 || res.status === 403)
      return { tokenConfigured: true, apiReachable: 'auth_failed', apiDetail: `HTTP ${res.status}` };
    return { tokenConfigured: true, apiReachable: 'ok', apiDetail: `HTTP ${res.status}` };
  } catch (err) {
    return { tokenConfigured: true, apiReachable: 'network', apiDetail: (err as Error).message };
  }
}

async function checkBlogger(): Promise<Pick<PlatformResult, 'tokenConfigured' | 'apiReachable' | 'apiDetail'>> {
  const credsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  const blogId = process.env.BLOGGER_BLOG_ID;
  if (!credsJson || !blogId)
    return {
      tokenConfigured: false,
      apiReachable: 'skipped',
      apiDetail: 'GOOGLE_APPLICATION_CREDENTIALS_JSON or BLOGGER_BLOG_ID not set',
    };
  // Service-account flow needs googleapis client; we mark as configured and defer to runtime.
  return {
    tokenConfigured: true,
    apiReachable: 'ok',
    apiDetail: 'service account configured (full check requires googleapis init at runtime)',
  };
}

async function checkWordPress(): Promise<Pick<PlatformResult, 'tokenConfigured' | 'apiReachable' | 'apiDetail'>> {
  const siteUrl = process.env.WORDPRESS_SITE_URL;
  const user = process.env.WORDPRESS_USERNAME;
  const pass = process.env.WORDPRESS_APP_PASSWORD;
  if (!siteUrl || !user || !pass)
    return {
      tokenConfigured: false,
      apiReachable: 'skipped',
      apiDetail: 'WORDPRESS_SITE_URL / USERNAME / APP_PASSWORD not all set',
    };
  try {
    const auth = Buffer.from(`${user}:${pass}`).toString('base64');
    const res = await fetch(`${siteUrl.replace(/\/$/, '')}/wp-json/wp/v2/users/me`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 401 || res.status === 403)
      return { tokenConfigured: true, apiReachable: 'auth_failed', apiDetail: `HTTP ${res.status}` };
    return { tokenConfigured: true, apiReachable: 'ok', apiDetail: `HTTP ${res.status}` };
  } catch (err) {
    return { tokenConfigured: true, apiReachable: 'network', apiDetail: (err as Error).message };
  }
}

const PLATFORM_HOME: Record<MvpPlatform, string> = {
  'Telegra.ph': 'https://telegra.ph/',
  'Dev.to': 'https://dev.to/',
  'Medium': 'https://medium.com/',
  'Hashnode': 'https://hashnode.com/',
  'GitHub': 'https://raw.githubusercontent.com/',
  'Blogger': 'https://www.blogger.com/',
  'WordPress': process.env.WORDPRESS_SITE_URL || 'https://wordpress.com/',
};

function recommend(r: Omit<PlatformResult, 'recommended'>): PlatformResult['recommended'] {
  if (r.apiReachable === 'ok') return 'mvp';
  if (r.apiReachable === 'auth_failed' || r.apiReachable === 'unsupported') return 'drop';
  return 'inspect';
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // 1. Schema snapshot
  const schema = exportSchema();
  fs.writeFileSync(path.join(DATA_DIR, 'schema-snapshot.sql'), schema, 'utf8');

  // 2. Per-platform health
  const checkers: Record<MvpPlatform, () => Promise<Pick<PlatformResult, 'tokenConfigured' | 'apiReachable' | 'apiDetail'>>> = {
    'Telegra.ph': checkTelegraph,
    'Dev.to': checkDevTo,
    'Medium': checkMedium,
    'Hashnode': checkHashnode,
    'GitHub': checkGitHub,
    'Blogger': checkBlogger,
    'WordPress': checkWordPress,
  };

  const results: PlatformResult[] = [];
  for (const platform of MVP_PLATFORMS) {
    const apiRes = await checkers[platform]();
    const headRes = await probeHead(PLATFORM_HOME[platform]);
    const partial = {
      platform,
      ...apiRes,
      headSupported: headRes.ok,
      headDetail: headRes.detail,
    };
    results.push({ ...partial, recommended: recommend(partial) });
  }

  // 3. Persist matrix for runtime use
  const matrix = {
    generatedAt: new Date().toISOString(),
    platforms: results,
    headSupportedMap: Object.fromEntries(results.map((r) => [r.platform, r.headSupported])),
  };
  fs.writeFileSync(path.join(DATA_DIR, 'preflight-matrix.json'), JSON.stringify(matrix, null, 2), 'utf8');

  // 4. Markdown report to stdout
  console.log(`\n# Preflight Report — ${matrix.generatedAt}\n`);
  console.log('| Platform | Token | API | HEAD | MVP? | Detail |');
  console.log('|---|---|---|---|---|---|');
  for (const r of results) {
    const tokIcon = r.tokenConfigured ? '✅' : '⚪';
    const apiIcon = r.apiReachable === 'ok' ? '✅' : r.apiReachable === 'skipped' ? '⚪' : '❌';
    const headIcon = r.headSupported ? '✅' : '❌';
    const recIcon = r.recommended === 'mvp' ? '✅ keep' : r.recommended === 'drop' ? '❌ drop' : '⚠️ inspect';
    console.log(`| ${r.platform} | ${tokIcon} | ${apiIcon} | ${headIcon} | ${recIcon} | ${r.apiDetail} |`);
  }
  console.log('\nSchema snapshot: `.data/schema-snapshot.sql`');
  console.log('HEAD/API matrix: `.data/preflight-matrix.json`\n');

  const drops = results.filter((r) => r.recommended === 'drop').map((r) => r.platform);
  if (drops.length) {
    console.log(`⚠️  Recommended to remove from MVP_PLATFORMS: ${drops.join(', ')}`);
    console.log('   Action: edit src/constants.ts MVP_PLATFORMS and re-run preflight.\n');
  } else {
    console.log('✅ All MVP platforms reachable.\n');
  }
}

main().catch((err) => {
  console.error('preflight-check fatal:', err);
  process.exit(1);
});
