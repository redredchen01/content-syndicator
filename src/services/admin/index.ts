/**
 * services/admin/* barrel — public re-exports for admin domain services.
 *
 * Plan 2026-05-07-002 progress:
 *   - Unit 1 (this PR): platforms / brand / roi-config
 *   - Unit 3 (PR #19):  credential-store
 *   - Unit 2 / 4 / 5+:  pending (browser-auth, slim controller, publish/*)
 */

// credential-store (PR #19)
export {
  ENV_KEY_MAP,
  testCredentialAgainstAdapter,
  updateApiKey,
  batchValidateApiKeys,
} from './credential-store';

export type {
  TestCredentialResult,
  UpdateApiKeyResult,
  BatchCredentialInput,
  BatchValidationItem,
} from './credential-store';

// platforms (Unit 1)
export {
  API_CONNECTED,
  hasStoredApiKey,
  isAdapterConnected,
  isDefaultPublishTarget,
  getPlatformStatus,
  getDefaultPublishingPlatforms,
  resolveTargetPlatforms,
  getAllPlatformStatuses,
  getAdapterId,
  hasSavedBrowserSession,
} from './platforms';

export type { PlatformStatus } from './platforms';

// brand (Unit 1)
export {
  getBrandProfileWithDispatch,
  saveBrandProfileFromInput,
  runPrecheckForDispatch,
  updatePreferredPlatformsForBrand,
  getPreferredPlatformsForBrand,
} from './brand';

export type {
  BrandProfileWithDispatch,
  SaveBrandProfileResult,
  RunPrecheckResult,
  UpdatePreferredPlatformsResult,
} from './brand';

// roi-config (Unit 1)
export {
  getPlatformHealth,
  updateRoiConfig,
} from './roi-config';

export type {
  UpdateRoiConfigInput,
  UpdateRoiConfigResult,
} from './roi-config';

// browser-auth (Unit 2)
export {
  MIN_AUTH_COOKIES,
  getBrowserSessionStatus,
  prepareBrowserLogin,
  beginBrowserLoginSession,
  prepareBrowserTest,
  beginBrowserTestSession,
} from './browser-auth';

export type {
  BrowserSessionStatus,
  PreparedSession,
  PrepareResult,
} from './browser-auth';
