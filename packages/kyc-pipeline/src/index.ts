/**
 * @kilowattx/kyc-pipeline
 *
 * The application service that turns a vendor result into a persisted
 * decision. Composes packages/core (what the status should be),
 * packages/db (writing it) and packages/integrations (the vendor's shape).
 *
 * It exists as its own package because two apps need it — the API on a
 * webhook, the worker on reconciliation — and a copy in each would drift in
 * the duplicate-PAN check and the five-table transaction. The stack doc's
 * package list has no slot for an application service, but its stated
 * principle is that rules live in one place, which is exactly what this
 * serves.
 */

export {
  applyVendorResult,
  type ApplyVendorResultOutcome,
  type ApplyVendorResultParams,
} from "./applyVendorResult.js";

export {
  EXTRACTION_CONFIDENCE_FLOOR,
  LOW_CONFIDENCE_REVIEW_THRESHOLD,
  RETENTION_YEARS,
  approveDocument,
  documentIsUsable,
  processUploadedDocument,
  registerUpload,
  type ProcessDocumentOutcome,
  type RegisterUploadResult,
} from "./documents.js";

export {
  confirmCoOwnerConsent,
  evaluateParcel,
  landIsLeasable,
  registerParcelFromDocument,
  type ParcelEvaluation,
  type RegisterParcelResult,
} from "./land.js";

export {
  applyKybDecision,
  linkSignatory,
  recordCompanyLookup,
  startKyb,
  type KybDecisionOutcome,
  type StartKybResult,
} from "./kyb.js";

export {
  THRESHOLD_SETTING_PREFIX,
  loadThresholds,
  loadThresholdsLogging,
  type LoadedThresholds,
  type RejectedThreshold,
} from "./thresholds.js";

export {
  PlaceholderPanEncryptor,
  type PanEncryptor,
} from "./panEncryption.js";
