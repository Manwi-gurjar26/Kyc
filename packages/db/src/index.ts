/**
 * @kilowattx/db
 *
 * Drizzle schema, migrations and repository functions.
 *
 * Repository functions take a transaction rather than a database wherever more
 * than one table changes, so a caller cannot write half of a decision.
 */

export * from "./schema.js";

export {
  createClient,
  withContext,
  type CreateClientOptions,
  type Database,
  type DatabaseHandle,
  type RequestContext,
  type Transaction,
} from "./client.js";

export {
  applyKycDecision,
  type ApplyKycDecisionInput,
  type CheckRecord,
  type CheckStatus,
  type CheckType,
} from "./repositories/kycRepository.js";

export {
  applyReviewDecision,
  type ApplyReviewDecisionInput,
  type ReviewAction,
} from "./repositories/reviewRepository.js";

export {
  BACKOFF_SECONDS,
  MAX_ATTEMPTS,
  claimOutboxBatch,
  completeOutboxEvent,
  failOutboxEvent,
  outboxStats,
  releaseStuckEvents,
  type ClaimedEvent,
  type OutboxStats,
} from "./repositories/outboxRepository.js";

export { PostgresSeenEventStore } from "./repositories/seenEventStore.js";
