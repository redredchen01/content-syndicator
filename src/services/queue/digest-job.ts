/**
 * Unit 13: Daily Digest Job Handler
 *
 * Registered as 'daily_digest' job_type.
 * Runs at 18:00 daily (scheduled by Scheduler.seedDailyDigest).
 *
 * Queries today's publish_jobs stats and sends a summary via the
 * channel configured in brand_profile (none | email | telegram).
 *
 * If digest_channel = 'none' or no activity today → skip silently.
 */

import type Database from 'better-sqlite3';
import type { PublishJob } from '../../db/repositories';
import { brandProfile } from '../../db/repositories';
import { logger } from '../../utils/logger';
import { google } from 'googleapis';

interface DailyStats {
  succeeded: number;
  failed_terminal: number;
  scheduled_pending: number;
  byPlatform: Record<string, { succeeded: number; failed: number }>;
}

// -----------------------------------------------------------------------
// Main handler
// -----------------------------------------------------------------------

export async function handleDailyDigestJob(job: PublishJob, db: Database.Database): Promise<void> {
  const profile = brandProfile.get(db);
  if (!profile || profile.digest_channel === 'none') {
    logger.info('[DigestJob] digest_channel=none — skipping');
    return;
  }

  const stats = queryDailyStats(db);
  const total = stats.succeeded + stats.failed_terminal;
  if (total === 0 && stats.scheduled_pending === 0) {
    logger.info('[DigestJob] No activity today — skipping digest');
    return;
  }

  const text = formatDigest(stats);
  logger.info('[DigestJob] digest text:\n' + text);

  if (profile.digest_channel === 'telegram' && profile.digest_destination) {
    await sendTelegramDigest(profile.digest_destination, text);
  } else if (profile.digest_channel === 'email' && profile.digest_destination) {
    await sendEmailDigest(profile.digest_destination, text);
  }
}

// -----------------------------------------------------------------------
// Stats query
// -----------------------------------------------------------------------

function queryDailyStats(db: Database.Database): DailyStats {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const rows = db.prepare(`
    SELECT platform, status, COUNT(*) AS cnt
    FROM publish_jobs
    WHERE DATE(updated_at) = ?
      AND job_type = 'publish'
    GROUP BY platform, status
  `).all(today) as Array<{ platform: string; status: string; cnt: number }>;

  const pending = db.prepare(`
    SELECT COUNT(*) AS cnt FROM publish_jobs
    WHERE status = 'scheduled' AND job_type = 'publish'
  `).get() as { cnt: number };

  const stats: DailyStats = {
    succeeded: 0,
    failed_terminal: 0,
    scheduled_pending: pending.cnt,
    byPlatform: {},
  };

  for (const row of rows) {
    if (!stats.byPlatform[row.platform]) {
      stats.byPlatform[row.platform] = { succeeded: 0, failed: 0 };
    }
    if (row.status === 'succeeded') {
      stats.succeeded += row.cnt;
      stats.byPlatform[row.platform].succeeded += row.cnt;
    } else if (row.status === 'failed_terminal') {
      stats.failed_terminal += row.cnt;
      stats.byPlatform[row.platform].failed += row.cnt;
    }
  }

  return stats;
}

// -----------------------------------------------------------------------
// Formatting
// -----------------------------------------------------------------------

function formatDigest(stats: DailyStats): string {
  const date = new Date().toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const lines = [
    `📊 外鏈發佈日報 ${date}`,
    ``,
    `✅ 成功: ${stats.succeeded}  ❌ 失敗: ${stats.failed_terminal}  ⏳ 待發: ${stats.scheduled_pending}`,
    ``,
    `平台明細:`,
    ...Object.entries(stats.byPlatform)
      .filter(([, s]) => s.succeeded + s.failed > 0)
      .map(([p, s]) => `  ${p}: ✅${s.succeeded} ❌${s.failed}`),
  ];
  return lines.join('\n');
}

// -----------------------------------------------------------------------
// Send channels
// -----------------------------------------------------------------------

async function sendTelegramDigest(token: string, text: string): Promise<void> {
  // token format: "bot<id>:<hash>:<chatId>" (full token) or "bot<id>:<chatId>" (legacy)
  // Use lastIndexOf to correctly split full tokens that contain an internal colon.
  const lastColon = token.lastIndexOf(':');
  const chatId = lastColon >= 0 ? token.slice(lastColon + 1) : '';
  const botToken = lastColon >= 0 ? token.slice(0, lastColon).replace(/^bot/, '') : '';
  if (!botToken || !chatId) {
    logger.warn('[DigestJob] Invalid Telegram token format (expected "bot<token>:<chatId>")');
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const err = await res.text();
      logger.warn(`[DigestJob] Telegram API error: ${err}`);
    } else {
      logger.info('[DigestJob] Telegram digest sent');
    }
  } catch (err: any) {
    logger.warn(`[DigestJob] Telegram send failed: ${err.message}`);
  }
}

// -----------------------------------------------------------------------
// Email via Gmail API (domain-wide delegation)
// -----------------------------------------------------------------------
//
// Prerequisites (one-time admin setup):
//   1. Enable Gmail API in the GCP project that owns the service account.
//   2. In Google Workspace Admin → Security → API controls →
//      Domain-wide delegation: add the service account client_id with
//      scope https://www.googleapis.com/auth/gmail.send
//   3. Set DIGEST_SENDER_EMAIL to the Workspace user the SA impersonates.
//
// DIGEST_SENDER_EMAIL is the "From" address and the Gmail user whose
// send-as quota is used. It can be the same address as digest_destination.

async function sendEmailDigest(toEmail: string, text: string): Promise<void> {
  const credsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  const senderEmail = process.env.DIGEST_SENDER_EMAIL;

  if (!credsJson) {
    logger.warn('[DigestJob] GOOGLE_APPLICATION_CREDENTIALS_JSON not set — skipping email');
    return;
  }
  if (!senderEmail) {
    logger.warn(
      '[DigestJob] DIGEST_SENDER_EMAIL not set — cannot send email digest. ' +
      'Set it to the Google Workspace address the service account impersonates.',
    );
    return;
  }

  try {
    const credentials = JSON.parse(credsJson);

    // JWT client with domain-wide delegation: `subject` is the Workspace user
    // whose mailbox we send from.
    const auth = new google.auth.JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/gmail.send'],
      subject: senderEmail,
    });

    const dateLabel = new Date().toLocaleDateString('zh-TW', {
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const subject = `📊 外鏈發佈日報 ${dateLabel}`;

    // Build a minimal RFC 2822 message with UTF-8 subject encoding.
    const encodedSubject = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
    const rawMessage = [
      `From: ${senderEmail}`,
      `To: ${toEmail}`,
      `Subject: ${encodedSubject}`,
      `Content-Type: text/plain; charset=utf-8`,
      `MIME-Version: 1.0`,
      '',
      text,
    ].join('\r\n');

    const gmail = google.gmail({ version: 'v1', auth });
    await gmail.users.messages.send({
      userId: senderEmail,
      requestBody: { raw: Buffer.from(rawMessage).toString('base64url') },
    });

    logger.info(`[DigestJob] Email digest sent → ${toEmail}`);
  } catch (err: any) {
    logger.warn(`[DigestJob] Email send failed: ${err.message}`);
    if (err.message?.includes('unauthorized_client') || err.status === 403) {
      logger.warn(
        '[DigestJob] Hint: The service account needs domain-wide delegation ' +
        'with scope https://www.googleapis.com/auth/gmail.send. ' +
        'See Google Workspace Admin → Security → API controls → Domain-wide delegation.',
      );
    }
  }
}

// -----------------------------------------------------------------------
// Seed helper — called by Scheduler on startup
// -----------------------------------------------------------------------

/** Insert today's 18:00 digest job if not already present. */
export function seedDailyDigest(db: Database.Database): void {
  const today = new Date().toISOString().slice(0, 10);
  const scheduled18 = `${today}T18:00:00.000Z`;

  // Only seed if no digest job exists for today
  const existing = db
    .prepare(
      `SELECT id FROM publish_jobs WHERE job_type = 'daily_digest' AND DATE(scheduled_at) = ?`,
    )
    .get(today);

  if (!existing) {
    db.prepare(`
      INSERT INTO publish_jobs (batch_id, variant_id, platform, job_type, payload_json, scheduled_at, metadata_json)
      VALUES ('system', 'digest', 'system', 'daily_digest', '{}', ?, '{}')
    `).run(scheduled18);
    logger.info(`[DigestJob] Seeded daily_digest job for ${today} 18:00 UTC`);
  }
}
