import { Database } from 'better-sqlite3';
import { logger } from './logger';
import { LLM_BUDGET } from '../constants';
import { llmCalls } from '../db/repositories/index';

export type BudgetStatus = 'ok' | 'warn' | 'critical';

export interface BudgetCheckResult {
  status: BudgetStatus;
  spent: number; // USD
  limit: number; // DAILY_USD
  ratio: number; // spent / limit
}

/**
 * Check daily LLM budget status by querying past 24 hours of llm_calls.
 * Returns budget status, spent amount, limit, and ratio.
 *
 * Status enumeration:
 * - 'ok': spent < DAILY_USD
 * - 'warn': DAILY_USD <= spent < 2 * DAILY_USD
 * - 'critical': spent >= 2 * DAILY_USD
 */
export function checkBudgetStatus(db: Database.Database): BudgetCheckResult {
  const now = new Date().toISOString();
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const spent = llmCalls.spendBetween(db, oneDayAgo, now);
  const limit = LLM_BUDGET.DAILY_USD;

  let status: BudgetStatus;
  if (spent >= 2 * limit) {
    status = 'critical';
  } else if (spent >= limit) {
    status = 'warn';
  } else {
    status = 'ok';
  }

  const ratio = limit > 0 ? spent / limit : 0;

  if (status === 'warn' || status === 'critical') {
    logger.warn(
      `[Budget] ${status}: spent $${spent.toFixed(2)} / limit $${limit} (ratio: ${ratio.toFixed(2)})`
    );
  } else {
    logger.info(
      `[Budget] ${status}: spent $${spent.toFixed(2)} / limit $${limit} (ratio: ${ratio.toFixed(2)})`
    );
  }

  return { status, spent, limit, ratio };
}
