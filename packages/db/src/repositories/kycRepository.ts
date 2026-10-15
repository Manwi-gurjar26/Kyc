import { assertTransition, type KycDecision, type KycStatus, type KycThresholds } from "@kilowattx/core";
import { eq } from "drizzle-orm";
import type { Transaction } from "../client.js";
import { auditLog, kycChecks, kycRecords, outboxEvents } from "../schema.js";

/**
 * Writing a KYC decision.
 *
 * Five tables change together: the record's status, one row per check
 * performed, the outbox event that notifies the customer, and the audit row
 * that explains the decision. Either all of it lands or none of it does.
 *
 * A partial write is the worst failure this module has. A status with no audit
 * row is a decision nobody can account for; a status with no outbox event is a
 * customer who is verified and never told, who then contacts support about a
 * button that should be working. Both are invisible until someone complains.
 *
 * So this function takes a transaction rather than a database: it cannot be
 * called in a way that writes four of the five.
 */

export type CheckType =
  | "AADHAAR"
  | "PAN"
  | "LIVENESS"
  | "FACE_MATCH"
  | "GST"
  | "CIN"
  | "LLPIN"
  | "LAND_DOCUMENTS"
  | "NAME_MATCH";

export type CheckStatus = "PENDING" | "PASSED" | "FAILED" | "ERRORED";

export interface CheckRecord {
  checkType: CheckType;
  status: CheckStatus;
  score?: number;
  detail?: string;
  rawResponseKey?: string;
  attemptNumber?: number;
}

export interface ApplyKycDecisionInput {
  kycRecordId: string;
  /** Exactly what core.decideKyc() returned. Not re-derived here. */
  decision: KycDecision;
  /** Stored alongside, so the decision can be reproduced later. */
  thresholds: KycThresholds;
  now: Date;

  vendor?: string;
  vendorVersion?: string;

  /** The only Aadhaar data we may keep. */
  aadhaarLast4?: string;
  aadhaarRefToken?: string;

  /** Envelope ciphertext; never the plaintext PAN. */
  panEncrypted?: string;
  panBlindIndex?: string;
  panLast4?: string;

  livenessPassed?: boolean;
  faceMatchScore?: number;
  nameMatchScore?: number;

  /** One row per check attempted, including the ones that failed. */
  checks: CheckRecord[];

  actorType: "SYSTEM" | "STAFF" | "CUSTOMER";
  actorUserId?: string;
  reasonCode?: string;
  note?: string;
  traceId?: string;
}

/** The outbox event each outcome emits. */
const EVENT_BY_STATUS: Record<string, string> = {
  VERIFIED: "kyc.verified",
  MANUAL_REVIEW: "kyc.review_required",
  REJECTED: "kyc.rejected",
};

/**
 * Applies a decision and returns the new status.
 *
 * Throws, and so rolls back, when the record does not exist, when the
 * transition is not legal, or when any constraint rejects the write — the
 * duplicate-PAN index being the one that fires in practice.
 */
export async function applyKycDecision(
  tx: Transaction,
  input: ApplyKycDecisionInput,
): Promise<KycStatus> {
  /**
   * Locked for the duration. Two webhook deliveries for the same session can
   * reach two tasks at once; without the lock both would read IN_PROGRESS,
   * both would find the transition legal, and both would write. The replay
   * guard is the first defence against that and this is the second, because
   * the first one depends on the vendor sending a usable event id.
   */
  const existing = await tx
    .select({ id: kycRecords.id, status: kycRecords.status })
    .from(kycRecords)
    .where(eq(kycRecords.id, input.kycRecordId))
    .for("update")
    .limit(1);

  const current = existing[0];
  if (!current) {
    throw new Error(`applyKycDecision: kyc_record ${input.kycRecordId} not found`);
  }

  /**
   * Consulted before anything is written, so an illegal move costs nothing.
   * This is what makes REJECTED -> VERIFIED impossible even if a caller asks
   * for it.
   */
  const nextStatus = assertTransition(current.status as KycStatus, input.decision.status);

  /* ---- 1. the record itself ---- */
  await tx
    .update(kycRecords)
    .set({
      status: nextStatus,
      vendor: input.vendor,
      vendorVersion: input.vendorVersion,
      aadhaarLast4: input.aadhaarLast4,
      aadhaarRefToken: input.aadhaarRefToken,
      panEncrypted: input.panEncrypted,
      panBlindIndex: input.panBlindIndex,
      panLast4: input.panLast4,
      livenessPassed: input.livenessPassed,
      faceMatchScore:
        input.faceMatchScore === undefined ? null : String(input.faceMatchScore),
      nameMatchScore:
        input.nameMatchScore === undefined ? null : String(input.nameMatchScore),
      decisionReasons: input.decision.reasons,
      thresholdsUsed: input.thresholds as unknown as Record<string, number>,
      /** Set only on a pass, so "when were they cleared" has one answer. */
      verifiedAt: nextStatus === "VERIFIED" ? input.now : null,
      reviewedBy: input.actorType === "STAFF" ? input.actorUserId : undefined,
      reviewedAt: input.actorType === "STAFF" ? input.now : undefined,
      reviewReasonCode: input.reasonCode,
    })
    .where(eq(kycRecords.id, input.kycRecordId));

  /* ---- 2. every check attempted, append-only ---- */
  if (input.checks.length > 0) {
    await tx.insert(kycChecks).values(
      input.checks.map((check) => ({
        kycRecordId: input.kycRecordId,
        checkType: check.checkType,
        status: check.status,
        score: check.score === undefined ? null : String(check.score),
        vendor: input.vendor,
        vendorVersion: input.vendorVersion,
        rawResponseKey: check.rawResponseKey,
        detail: check.detail,
        attemptNumber: check.attemptNumber ?? 1,
      })),
    );
  }

  /* ---- 3. the outbox event the worker picks up ---- */
  const eventType = EVENT_BY_STATUS[nextStatus];
  if (!eventType) {
    throw new Error(
      `applyKycDecision: no outbox event defined for status ${nextStatus}. ` +
        "A status change nobody is told about is a bug, not a default.",
    );
  }

  await tx.insert(outboxEvents).values({
    eventType,
    aggregateType: "kyc_record",
    aggregateId: input.kycRecordId,
    /**
     * Reason codes only — never a reason's detail text, which quotes names and
     * scores. The outbox feeds notifications, and a payload is the easiest
     * place for personal data to escape into a log.
     */
    payload: {
      kycRecordId: input.kycRecordId,
      status: nextStatus,
      reasonCodes: input.decision.reasons.map((r) => r.code),
      occurredAt: input.now.toISOString(),
    },
  });

  /* ---- 4. the audit row, append-only ---- */
  await tx.insert(auditLog).values({
    actorUserId: input.actorUserId,
    actorType: input.actorType,
    action: "kyc.decided",
    resourceType: "kyc_record",
    resourceId: input.kycRecordId,
    changes: {
      from: current.status,
      to: nextStatus,
      reasons: input.decision.reasons,
      thresholds: input.thresholds,
    },
    reasonCode: input.reasonCode,
    note: input.note,
    traceId: input.traceId,
  });

  return nextStatus;
}
