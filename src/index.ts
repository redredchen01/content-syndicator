import 'dotenv/config';
import { app } from './server';
import { db } from './db';
import { Scheduler } from './services/queue/scheduler';
import { handlePublishJob } from './services/queue/publish-worker';
import { handleLivenessJob } from './services/queue/liveness-worker';
import { handleDailyDigestJob, seedDailyDigest } from './services/queue/digest-job';
import { handleAggregateSheets, handleReconciliation, seedSheetsJobs } from './services/queue/sheets-jobs';
import { validateAllCredentials } from './services/credential-validator';
import { logger } from './utils/logger';

const PORT = process.env.PORT || 3000;

// Start the job scheduler and register all handlers
const scheduler = new Scheduler(db);
scheduler.registerHandler('publish', handlePublishJob);
scheduler.registerHandler('health_check_t24h', handleLivenessJob);
scheduler.registerHandler('health_check_t7d', handleLivenessJob);
scheduler.registerHandler('health_check_t30d', handleLivenessJob);
scheduler.registerHandler('daily_digest', handleDailyDigestJob);
scheduler.registerHandler('aggregate_sheets', handleAggregateSheets);
scheduler.registerHandler('reconciliation', handleReconciliation);
scheduler.start();

// Seed today's daily digest job at 18:00 if not already present
seedDailyDigest(db);
// Seed today's Sheets maintenance jobs (aggregate 04:00, reconcile 04:30)
seedSheetsJobs(db);

// Background credential validation task (runs every 24 hours)
let credentialValidationInterval: ReturnType<typeof setInterval> | null = null;
async function runCredentialValidation() {
  try {
    const results = await validateAllCredentials(db);
    if (results.length > 0) {
      const successes = results.filter(r => r.ok).length;
      const failures = results.filter(r => !r.ok).length;
      if (failures > 0) {
        logger.warn(`[Credential Validator] ${successes} OK, ${failures} FAILED`);
      } else {
        logger.info(`[Credential Validator] All ${successes} credentials valid`);
      }
    }
  } catch (err: any) {
    logger.error('[Credential Validator] Task failed', err);
  }
}

// Delay initial validation by 10 seconds to not block startup, then every 24 hours
setTimeout(() => {
  runCredentialValidation().catch(e => logger.error('[Credential Validator] Initial run failed', e));
  credentialValidationInterval = setInterval(
    () => runCredentialValidation().catch(e => logger.error('[Credential Validator] Task failed', e)),
    24 * 60 * 60 * 1000,
  );
}, 10000);

const server = app.listen(PORT, () => {
  console.log(`\n🚀 Web UI is running at: http://localhost:${PORT}\n`);
});

// ── Graceful shutdown ──────────────────────────────────────────────────────
// Without this, SIGTERM from pm2 / Docker / launchd leaves the scheduler's
// setInterval and the credential-validation timer running until force-kill.
// In-flight 'running' jobs also stay zombie until the next startup sweep.
function shutdown(signal: string): void {
  logger.info(`[Server] ${signal} received — shutting down`);
  scheduler.stop(); // clears tick + zombie-sweep timers
  if (credentialValidationInterval) {
    clearInterval(credentialValidationInterval);
    credentialValidationInterval = null;
  }
  // Force exit if HTTP server doesn't drain within 10 s (in-flight requests)
  const forceExitTimer = setTimeout(() => {
    logger.warn('[Server] Forcing exit after 10 s drain timeout');
    process.exit(1);
  }, 10_000).unref();
  server.close(() => {
    clearTimeout(forceExitTimer);
    logger.info('[Server] HTTP server closed — exiting');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
