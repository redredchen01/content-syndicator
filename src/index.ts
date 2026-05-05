import 'dotenv/config';
import { app } from './server';
import { db } from './db';
import { Scheduler } from './services/queue/scheduler';
import { handlePublishJob } from './services/queue/publish-worker';

const PORT = process.env.PORT || 3000;

// Start the job scheduler and register handlers
const scheduler = new Scheduler(db);
scheduler.registerHandler('publish', handlePublishJob);
scheduler.start();

app.listen(PORT, () => {
  console.log(`\n🚀 Web UI is running at: http://localhost:${PORT}\n`);
});
