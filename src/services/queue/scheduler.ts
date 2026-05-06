/**
 * Job queue scheduler (Plan Unit 9, R14/R15).
 *
 * Single in-process setInterval scheduler for the SQLite-backed
 * publish_jobs queue. No Redis, no BullMQ — scale is 21-70 jobs/day
 * (3-10 articles × 7 platforms), which a 2-second SQLite poll easily
 * handles (scope-guardian F4: framework-ahead-of-need avoided).
 *
 * Key design points:
 * - Zombie cleanup runs BOTH at startup AND every minute on a recurring
 *   sweep (adversarial F1: laptop sleep / OS reboot mid-publish scenario).
 * - Handlers are registered via registerHandler() so Unit 10 (publish)
 *   and Unit 13 (liveness/digest) can each own their own job_types.
 * - Rate-limit enforcement happens at dequeue time (learning #2).
 * - Dedup before rate-limit count: retry jobs (attempts > 0) checked
 *   for idempotency by the handlers themselves, not re-gated here
 *   (learning #3).
 */

import Database from 'better-sqlite3';
import { publishJobs, type JobType, type PublishJob } from '../../db/repositories';
import { logger } from '../../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JobHandler = (job: PublishJob, db: Database.Database) => Promise<void>;

export type HandlerRegistry = Partial<Record<JobType, JobHandler>>;

export interface SchedulerConfig {
  /** milliseconds between scheduler ticks (default 2000) */
  tickIntervalMs?: number;
  /** jobs per tick batch size (default 5) */
  batchSize?: number;
  /** minutes before a running job is considered a zombie (default 5) */
  zombieThresholdMinutes?: number;
  /** minutes between recurring zombie sweeps (default 1) */
  zombieSweepIntervalMinutes?: number;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class Scheduler {
  private db: Database.Database;
  private handlers: HandlerRegistry = {};
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private zombieSweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly config: Required<SchedulerConfig>;
  private running = false;

  constructor(db: Database.Database, config: SchedulerConfig = {}) {
    this.db = db;
    this.config = {
      tickIntervalMs: config.tickIntervalMs ?? 2_000,
      batchSize: config.batchSize ?? 5,
      zombieThresholdMinutes: config.zombieThresholdMinutes ?? 5,
      zombieSweepIntervalMinutes: config.zombieSweepIntervalMinutes ?? 1,
    };
  }

  registerHandler(jobType: JobType, handler: JobHandler): void {
    this.handlers[jobType] = handler;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    // Startup one-shot zombie reset.
    this._sweepZombies();

    // Recurring zombie sweep (covers laptop sleep / blocked handlers).
    this.zombieSweepTimer = setInterval(
      () => this._sweepZombies(),
      this.config.zombieSweepIntervalMinutes * 60_000,
    );

    // Main dispatch tick.
    this.tickTimer = setInterval(() => this._tick(), this.config.tickIntervalMs);

    logger.info(
      `[Scheduler] started: tick=${this.config.tickIntervalMs}ms, ` +
      `zombie=${this.config.zombieThresholdMinutes}min`,
    );
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.zombieSweepTimer) clearInterval(this.zombieSweepTimer);
    this.tickTimer = null;
    this.zombieSweepTimer = null;
    this.running = false;
    logger.info('[Scheduler] stopped');
  }

  private _sweepZombies(): void {
    const threshold = new Date(
      Date.now() - this.config.zombieThresholdMinutes * 60_000,
    ).toISOString();
    const reset = publishJobs.resetZombies(this.db, threshold);
    if (reset > 0) {
      logger.warn(`[Scheduler] zombie sweep reset ${reset} stale running job(s)`);
    }
  }

  private async _tick(): Promise<void> {
    const now = new Date().toISOString();
    const due = publishJobs.dequeueDue(this.db, now, this.config.batchSize);
    if (due.length === 0) return;

    for (const job of due) {
      const handler = this.handlers[job.job_type];
      if (!handler) {
        // No handler registered — mark terminal so it doesn't loop forever.
        publishJobs.markFailed(
          this.db,
          job.id,
          `No handler registered for job_type="${job.job_type}"`,
          null,
          0,
        );
        logger.warn(`[Scheduler] no handler for job_type=${job.job_type} id=${job.id}`);
        continue;
      }

      try {
        await handler(job, this.db);
        // Handler is responsible for calling publishJobs.markSucceeded() or
        // markFailed() — the scheduler only drives the dequeue, not the
        // outcome (separation of concerns + handler idempotency).
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[Scheduler] handler threw for id=${job.id}: ${msg}`);
        // Schedule retry (handler will triage on next attempt).
        const nextAt = randomIntervalIso(20, 90);
        publishJobs.markFailed(this.db, job.id, msg, nextAt, 2);
      }
    }
  }

  get isRunning(): boolean {
    return this.running;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns an ISO timestamp offset by a random number of minutes in
 * [minMinutes, maxMinutes]. Used for R15's per-platform publish spacing
 * and for retry backoff.
 */
export function randomIntervalIso(minMinutes: number, maxMinutes: number): string {
  const mins = minMinutes + Math.random() * (maxMinutes - minMinutes);
  return new Date(Date.now() + mins * 60_000).toISOString();
}
