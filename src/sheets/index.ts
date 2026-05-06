/**
 * Google Sheets integration — v0.2 canonical view (Plan Unit 12).
 *
 * Exports:
 *   1. GoogleSheetsClient — full SheetsClient implementation. Uses
 *      googleapis with service-account auth (same credentials as v0.1).
 *      Internal token-bucket throttle: ≤50 writes/min (buffer below
 *      Sheets v4 limit of 60/min to avoid burst-429 adversarial F3).
 *   2. appendToSheet() — v0.1 back-compat shim. Still works unchanged.
 *   3. createSheetsClient() — factory that returns GoogleSheetsClient
 *      when env is configured, NopSheetsClient otherwise.
 *
 * Posts sheet canonical 12-column layout (Plan R19):
 *   timestamp | brand_id | batch_id | platform | persona_group |
 *   anchor_words | target_url | published_url | status |
 *   t24h_alive | t7d_alive | t30d_alive
 */

import { google, type sheets_v4 } from 'googleapis';
import { logger } from '../utils/logger';
import {
  NopSheetsClient,
  type LivenessColumn,
  type PostRow,
  type SheetsClient,
} from './types';

export { NopSheetsClient } from './types';
export type { SheetsClient, PostRow, LivenessColumn } from './types';

const POSTS_SHEET = 'Posts';
const AGGREGATES_SHEET = 'Aggregates';
const POST_COLS_RANGE = 'Posts!A:L';
const POSTS_HEADER = [
  'timestamp', 'brand_id', 'batch_id', 'platform', 'persona_group',
  'anchor_words', 'target_url', 'published_url', 'status',
  't24h_alive', 't7d_alive', 't30d_alive',
];

// ---------------------------------------------------------------------------
// Token-bucket throttle (in-process, per-instance)
// ---------------------------------------------------------------------------

class TokenBucket {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private lastRefill: number;

  constructor(capacityPerMinute: number) {
    this.capacity = capacityPerMinute;
    this.tokens = capacityPerMinute;
    this.refillPerMs = capacityPerMinute / 60_000;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;
  }

  consume(tokens = 1): boolean {
    this.refill();
    if (this.tokens < tokens) return false;
    this.tokens -= tokens;
    return true;
  }

  /** Waits until a token is available (up to maxWaitMs). */
  async waitAndConsume(tokens = 1, maxWaitMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + maxWaitMs;
    while (!this.consume(tokens)) {
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 200));
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// GoogleSheetsClient
// ---------------------------------------------------------------------------

export class GoogleSheetsClient implements SheetsClient {
  private sheets: sheets_v4.Sheets;
  private sheetId: string;
  private bucket = new TokenBucket(50); // 50 writes/min budget

  constructor(sheets: sheets_v4.Sheets, sheetId: string) {
    this.sheets = sheets;
    this.sheetId = sheetId;
  }

  private async throttledAppend(values: string[][]): Promise<void> {
    const ok = await this.bucket.waitAndConsume(1, 15_000);
    if (!ok) {
      logger.warn('[Sheets] token bucket exhausted — skipping append (will reconcile later)');
      return;
    }
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.sheetId,
      range: POST_COLS_RANGE,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });
  }

  async appendRow(range: string, values: string[]): Promise<void> {
    const ok = await this.bucket.waitAndConsume(1, 15_000);
    if (!ok) {
      logger.warn('[Sheets] token bucket exhausted — skipping appendRow');
      return;
    }
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.sheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [values] },
    });
  }

  async appendPost(row: PostRow): Promise<void> {
    try {
      const values = [[
        row.timestamp,
        row.brand_id,
        row.batch_id,
        row.platform,
        row.persona_group,
        row.anchor_words,
        row.target_url,
        row.published_url,
        row.status,
        row.t24h_alive ?? '',
        row.t7d_alive ?? '',
        row.t30d_alive ?? '',
      ]];
      await this.throttledAppend(values);
      logger.info(`[Sheets] appended post: batch=${row.batch_id} platform=${row.platform}`);
    } catch (err: any) {
      logger.error('[Sheets] appendPost failed', err);
      // Non-fatal: publish pipeline must not block on Sheets failure.
    }
  }

  async updateLiveness(
    batchId: string,
    platform: string,
    column: LivenessColumn,
    value: string,
  ): Promise<void> {
    try {
      // Find the row by scanning batch_id + platform columns (C + D).
      const readRes = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.sheetId,
        range: `${POSTS_SHEET}!A:D`,
      });

      const rows = readRes.data.values ?? [];
      // Column indices in 12-col layout (0-based):
      //   0=timestamp, 1=brand_id, 2=batch_id, 3=platform, ...
      //   9=t24h, 10=t7d, 11=t30d
      const colIndex = { t24h_alive: 9, t7d_alive: 10, t30d_alive: 11 }[column];
      // +2 = 1-based rows in Sheets + skip header row
      let targetRow = -1;
      for (let i = 1; i < rows.length; i++) {
        if (rows[i][2] === batchId && rows[i][3] === platform) {
          targetRow = i + 1;
          break;
        }
      }

      if (targetRow === -1) {
        logger.warn(`[Sheets] updateLiveness: row not found for batch=${batchId} platform=${platform}`);
        return;
      }

      const colLetter = String.fromCharCode(65 + colIndex); // A=65
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.sheetId,
        range: `${POSTS_SHEET}!${colLetter}${targetRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[value]] },
      });
    } catch (err: any) {
      logger.error('[Sheets] updateLiveness failed', err);
      // Non-fatal.
    }
  }

  async refreshAggregates(): Promise<void> {
    // Not yet implemented — pending aggregate tab format decision and sufficient post volume (>50).
    logger.warn('[Sheets] refreshAggregates: not yet implemented — sheet aggregates will not be updated');
  }

  async reconcileWithSqlite(
    sqliteRows: Array<{ batch_id: string; platform: string; published_url: string }>,
  ): Promise<void> {
    if (sqliteRows.length === 0) return;
    try {
      const readRes = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.sheetId,
        range: `${POSTS_SHEET}!B:D`, // brand_id, batch_id, platform
      });

      const existing = new Set<string>();
      for (const row of readRes.data.values ?? []) {
        existing.add(`${row[1]}__${row[2]}`); // batch_id__platform
      }

      const missing = sqliteRows.filter(
        (r) => !existing.has(`${r.batch_id}__${r.platform}`),
      );

      if (missing.length > 0) {
        logger.warn(`[Sheets] reconcile: ${missing.length} row(s) missing, appending`);
        const values = missing.map((r) => [
          new Date().toISOString(), // timestamp
          'main',
          r.batch_id,
          r.platform,
          '', '', '', // persona, anchors, target_url
          r.published_url,
          'reconciled',
          '', '', '', // liveness fields
        ]);
        await this.throttledAppend(values);
      }
    } catch (err: any) {
      logger.error('[Sheets] reconcile failed', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Returns a GoogleSheetsClient when credentials are configured,
 * NopSheetsClient otherwise (useful for local dev without creds).
 */
export function createSheetsClient(): SheetsClient {
  const credsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!credsJson || !sheetId) {
    logger.warn('[Sheets] credentials not configured — using NopSheetsClient');
    return new NopSheetsClient();
  }
  const credentials = JSON.parse(credsJson);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  return new GoogleSheetsClient(sheets, sheetId);
}

// ---------------------------------------------------------------------------
// Module-level singleton — all callers share one TokenBucket instance.
// ---------------------------------------------------------------------------

let _sheetsClient: SheetsClient | null = null;

export function getSheetsClient(): SheetsClient {
  if (!_sheetsClient) {
    _sheetsClient = createSheetsClient();
  }
  return _sheetsClient;
}

// ---------------------------------------------------------------------------
// v0.1 back-compat (unchanged interface, kept so server.ts compiles)
// ---------------------------------------------------------------------------

export async function appendToSheet(
  originalUrl: string,
  generatedTitle: string,
  publishResults: Array<{
    platform: string;
    success: boolean;
    publishedUrl?: string;
    error?: string;
  }>,
): Promise<void> {
  try {
    const client = getSheetsClient();
    const timestamp = new Date().toISOString();
    const find = (platform: string) => publishResults.find((r) => r.platform === platform);
    const cell = (r?: (typeof publishResults)[0]) =>
      r?.success ? (r.publishedUrl ?? 'N/A') : (r?.error ?? 'N/A');
    await client.appendRow('Sheet1!A:F', [
      timestamp, originalUrl, generatedTitle,
      cell(find('Telegra.ph')), cell(find('Dev.to')), cell(find('Medium')),
    ]);
    logger.success?.('Successfully appended record to Google Sheets');
  } catch (error: any) {
    logger.error('Failed to append to Google Sheets', error);
  }
}
