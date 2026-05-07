/**
 * services/admin/* barrel — public re-exports for admin domain services.
 */

// Shared infrastructure (re-exported so controllers stay free of direct db/* imports per Plan R2).
export { db } from '../../db';
export { isBrowserAutomationEnabled } from '../browser-session';

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
