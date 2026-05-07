import { logger } from '../utils/logger';
import type { LLMWithToolsOptions, LLMResponse } from '../llm/agent-llm';

const MODEL_CASCADE = ['gpt-4o', 'gpt-4o-mini', 'gemini-1.5-flash'] as const;

/**
 * Get the next model in the downgrade cascade.
 * Returns the next cheaper/available model, or null if already at the end.
 *
 * Cascade order (cost + availability):
 * - gpt-4o (premium quality)
 * - gpt-4o-mini (cost-effective OpenAI)
 * - gemini-1.5-flash (budget fallback)
 */
export function getNextModel(currentModel: string): string | null {
  const idx = MODEL_CASCADE.indexOf(currentModel as any);
  if (idx < 0 || idx >= MODEL_CASCADE.length - 1) {
    return null;
  }
  return MODEL_CASCADE[idx + 1];
}

/**
 * Check whether a model can be downgraded.
 * Returns false if the model is already the last in cascade or not recognized.
 */
export function canDowngrade(currentModel: string): boolean {
  return getNextModel(currentModel) !== null;
}

/**
 * Internal type for the result of invokeDirectly (wrapper around LLMWithTools).
 * Used to avoid circular dependency with agent-llm module.
 */
export type DirectInvokeFunction = (options: LLMWithToolsOptions) => Promise<LLMResponse>;

/**
 * Attempt model downgrade and retry.
 *
 * If the current model has a cheaper alternative in the cascade,
 * try downgrading and retrying once. Otherwise, reject with the original error.
 *
 * The retry is direct (no smartRetry delay), since downgrade is a cost-driven decision,
 * not a transient error recovery.
 */
export async function tryDowngradeAndRetry(
  options: LLMWithToolsOptions,
  originalError: Error,
  invokeDirectly: DirectInvokeFunction,
): Promise<LLMResponse> {
  const currentModel = options.model;
  const nextModel = getNextModel(currentModel);

  if (!nextModel) {
    logger.warn(
      `[Downgrade] No model to downgrade to from ${currentModel}. Failing with original error.`,
    );
    throw originalError;
  }

  logger.info(
    `[Downgrade] Retrying with ${nextModel} (was ${currentModel}). Original error: ${originalError.message}`,
  );

  const newOptions = { ...options, model: nextModel };
  return await invokeDirectly(newOptions);
}
