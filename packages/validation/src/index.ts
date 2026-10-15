/**
 * @kilowattx/validation
 *
 * Zod schemas and offline validators, shared by the browser forms, the API
 * validation pipe and the database boundary. No framework imports, no I/O —
 * everything here is a pure function.
 */

export {
  AADHAAR_REGEX,
  aadhaarLast4,
  isValidAadhaarNumber,
} from "./aadhaar.js";

export {
  PAN_REGEX,
  isValidPan,
  normalisePan,
  panHolderType,
  panLast4,
  type PanHolderType,
} from "./pan.js";

export {
  GSTIN_REGEX,
  businessPanFromGstin,
  gstinCheckDigit,
  isValidGstin,
  normaliseGstin,
  stateCodeFromGstin,
} from "./gstin.js";

export {
  CIN_REGEX,
  LLPIN_REGEX,
  cinOwnershipLabel,
  cinParts,
  isValidCin,
  isValidLlpin,
  type CinOwnership,
  type CinParts,
} from "./identifiers.js";

export { nameMatchScore, normaliseName } from "./name.js";

export {
  AadhaarNumberSchema,
  AadhaarOtpRequestSchema,
  AadhaarOtpVerifySchema,
  CONSENT_PURPOSES,
  CinSchema,
  ALLOWED_UPLOAD_TYPES,
  CoOwnerConsentInputSchema,
  CoOwnersInputSchema,
  DOCUMENT_TEST_MARKERS,
  CompanyRegisterInputSchema,
  ConfirmUploadInputSchema,
  DOCUMENT_TYPES,
  DocumentReviewInputSchema,
  MAX_UPLOAD_BYTES,
  UploadUrlInputSchema,
  CreateOrganisationInputSchema,
  ConsentInputSchema,
  CreateKycSessionInputSchema,
  GstinInputSchema,
  GstinSchema,
  KYC_LEVELS,
  KYC_SUBJECT_TYPES,
  LlpinSchema,
  PanCheckInputSchema,
  PanSchema,
  REVIEW_ACTIONS,
  ReviewActionInputSchema,
  SignatoryInputSchema,
  type AadhaarOtpRequest,
  type AadhaarOtpVerify,
  type CoOwnerConsentInput,
  type CoOwnersInput,
  type ConfirmUploadInput,
  type DocumentTestMarker,
  type DocumentReviewInput,
  type UploadUrlInput,
  type CompanyRegisterInput,
  type ConsentInput,
  type CreateOrganisationInput,
  type CreateKycSessionInput,
  type GstinInput,
  type PanCheckInput,
  type ReviewActionInput,
  type SignatoryInput,
} from "./schemas.js";
