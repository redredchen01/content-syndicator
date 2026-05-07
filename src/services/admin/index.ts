/**
 * services/admin/* barrel — public re-exports for admin domain services.
 *
 * Currently scoped to credential-store (Plan 2026-05-07-002 Unit 3 — minimum
 * viable PR). Future units (platforms, brand, browser-auth, roi-config) will
 * extend this barrel as they are extracted.
 */

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
