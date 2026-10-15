/**
 * @kilowattx/core
 *
 * Business rules. Plain TypeScript — no NestJS, no React, no database client,
 * no network, no clock of its own. The API, the worker and the web app all
 * call the same functions, which is what keeps one rule from drifting into
 * three implementations.
 *
 * The rule enforced by lint: nothing in here imports a framework, and nothing
 * outside here decides a KYC outcome.
 */

export {
  KYC_STATUSES,
  assertTransition,
  canTransition,
  isCleared,
  isTerminal,
  type KycStatus,
} from "./kycStatus.js";

export {
  DEFAULT_KYC_THRESHOLDS,
  ageInYears,
  decideKyc,
  type AadhaarResult,
  type CompanyResult,
  type DecisionReason,
  type GstResult,
  type KycDecision,
  type KycDecisionInput,
  type KycLevel,
  type KycThresholds,
  type PanResult,
  type ReasonSeverity,
  type SelfieResult,
} from "./decideKyc.js";

export {
  decideLand,
  type LandDecision,
  type LandDecisionInput,
  type LandDocumentState,
} from "./decideLand.js";

export {
  BLIND_INDEX_MIN_KEY_BYTES,
  blindIndexKeyFromEnv,
  panBlindIndex,
} from "./blindIndex.js";

export {
  KYC_ACTIONS,
  can,
  canOverrideFailedCheck,
  canReviewCase,
  type GuardResult,
  type KycAction,
  type ReviewCaseType,
  type SubjectKycState,
} from "./guards.js";
