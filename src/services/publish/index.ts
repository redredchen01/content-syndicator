/**
 * services/publish/* barrel — public re-exports for publish domain services.
 *
 * Cross-domain dependency: publish service relies on services/admin/platforms.ts
 * for shared platform-resolution helpers (resolveTargetPlatforms, etc.). That
 * direction is one-way: publish → admin/platforms; admin never imports publish.
 */

// v2-dispatch (Unit 5)
export {
  runV2Generate,
  runV2Dispatch,
  runV2DispatchOverride,
  runRegenerateVariant,
} from './v2-dispatch';

export type {
  RunV2GenerateInput,
  RunV2GenerateResult,
  RunV2DispatchInput,
  RunV2DispatchResult,
  RunV2DispatchOverrideInput,
  RunV2DispatchOverrideResult,
  RunRegenerateVariantInput,
  RunRegenerateVariantResult,
  InvalidDispatchEntry,
} from './v2-dispatch';

// batch-status (Unit 5)
export { getBatchStatus, getQueueSnapshot } from './batch-status';
export type { BatchStatusSnapshot, QueueSnapshot } from './batch-status';

// generation (Unit 6)
export { runGenerate, runGenerateManual, runGeneratePromo } from './generation';
export type {
  RunGenerateInput,
  RunGenerateResult,
  RunGenerateManualInput,
  RunGenerateManualResult,
  RunGeneratePromoInput,
  RunGeneratePromoResult,
  GeneratedMarkdown,
  PromoMarkdown,
} from './generation';

// dispatch (Unit 6)
export { runPublishingTask, startSinglePublish, startAutoPublish } from './dispatch';
export type {
  PublishingTaskOptions,
  StartSinglePublishInput,
  StartSinglePublishResult,
  StartAutoPublishInput,
  StartAutoPublishResult,
  AutoPublishResult,
} from './dispatch';

// bulk-queue (Unit 6)
export { processBulkQueue, parseCsvUrls, startBulkPublishFromFile } from './bulk-queue';
export type { StartBulkPublishInput, StartBulkPublishResult } from './bulk-queue';
