/**
 * @kilowattx/integrations
 *
 * One interface per vendor type, one adapter per vendor. Business code calls
 * the interface and never a vendor SDK, which is what makes swapping vendors,
 * testing against a fake, and failing over all ordinary work rather than a
 * rewrite.
 */

export {
  DEFAULT_TOLERANCE_SECONDS,
  verifyWebhook,
  type VerifyWebhookOptions,
  type VerifyWebhookResult,
  type WebhookRejection,
  type WebhookScheme,
} from "./webhookVerifier.js";

export {
  DEFAULT_RETENTION_DAYS,
  InMemorySeenEventStore,
  ReplayGuard,
  type ReplayCheckResult,
  type SeenEventStore,
} from "./replayGuard.js";

export {
  FAKE_SCENARIOS,
  KYC_PROVIDERS,
  VendorError,
  VendorRequestError,
  VendorTimeoutError,
  type AadhaarOtpChallenge,
  type AadhaarOtpResult,
  type CinLookupResult,
  type CreateSessionRequest,
  type FakeScenario,
  type GstLookupResult,
  type KybProvider,
  type KycProvider,
  type KycProviderName,
  type KycRole,
  type KycSession,
  type PanVerifyRequest,
  type DocumentExtractor,
  type DocumentScanner,
  type DocumentType,
  type ExtractedField,
  type ExtractionResult,
  type ScanResult,
  type VendorKycResult,
} from "./providers.js";

export {
  DEV_DOCUMENT_EXAMPLES,
  EXTRACTION_HIGH_CONFIDENCE,
  FakeDocumentExtractor,
  FakeDocumentScanner,
  documentKeyMarkers,
  type DocumentKeyMarkers,
} from "./fakeDocumentProvider.js";

export {
  DEFAULT_DOWNLOAD_SECONDS,
  KYC_DOCS_PREFIX,
  MAX_URL_SECONDS,
  SignedUrlFileStore,
  type DownloadUrl,
  type FileStore,
  type FileUrlRejection,
  type FileUrlVerdict,
  type SignedUrlFileStoreOptions,
  type UploadUrl,
} from "./fileStore.js";

export {
  LocalDiskBucket,
  type LocalDiskBucketOptions,
  type StoredObject,
} from "./localBucket.js";

export {
  SandboxClient,
  expiryOf,
  isoDate,
  type Envelope,
  type SandboxClientOptions,
} from "./sandboxClient.js";

export { SandboxKybProvider } from "./sandboxKybProvider.js";

export {
  SandboxKycProvider,
  type SandboxKycProviderOptions,
} from "./sandboxKycProvider.js";

export { FakeKybProvider } from "./fakeKybProvider.js";

export {
  FakeKycProvider,
  type FakeKycProviderOptions,
  type FakeWebhook,
} from "./fakeKycProvider.js";
