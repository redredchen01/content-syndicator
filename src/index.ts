import 'dotenv/config';
import { app } from './server';
import { db } from './db';
import { Scheduler } from './services/queue/scheduler';
import { handlePublishJob } from './services/queue/publish-worker';
import { handleLivenessJob } from './services/queue/liveness-worker';
import { handleDailyDigestJob, seedDailyDigest } from './services/queue/digest-job';
import { handleAggregateSheets, handleReconciliation, seedSheetsJobs } from './services/queue/sheets-jobs';

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

app.listen(PORT, () => {
  console.log(`\n🚀 Web UI is running at: http://localhost:${PORT}\n`);
});
