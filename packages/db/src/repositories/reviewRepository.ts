import { assertTransition, type KycStatus } from "@kilowattx/core";
import { eq } from "drizzle-orm";
import type { Transaction } from "../client.js";
import { auditLog, kycRecords, outboxEvents } from "../schema.js";

/**
 * Recording a human decision.
 *
 * This is not applyKycDecision. That function turns vendor facts into a status
 * by running decideKyc(); this one records a judgement a person has already
 * formed by looking at two photographs and a scanned deed. There is no
 * decision logic here on purpose — inventing some would mean the reviewer's
 * click and the system's conclusion could disagree.
 *
 * What it does guarantee: the status, the reviewer, the reason, the audit row
 * and the notification all land together or not at all.
 */

export type ReviewAction = "APPROVE" | "REJECT" | "REQUEST_RESUBMISSION";

export interface ApplyReviewDecisionInput {
  kycRecordId: string;
  action: ReviewAction;
  /**
   * Mandatory. A status change with no stated reason is what makes an audit
   * log worthless six months later, when the person who clicked has left and
   * the customer is disputing a 25-year agreement.
   */
  reasonCode: string;
  note?: string;
  reviewerUserId: string;
  now: Date;
  traceId?: string;
}

/** Where each action leaves the record, and what the customer is told. */
const OUTCOME: Record<
  ReviewAction,
  { status: Extract<KycStatus, "VERIFIED" | "REJECTED" | "IN_PROGRESS">; event: string }
> = {
  APPROVE: { status: "VERIFIED", event: "kyc.verified" },
  REJECT: { status: "REJECTED", event: "kyc.rejected" },
  REQUEST_RESUBMISSION: {
    status: "IN_PROGRESS",
    event: "kyc.resubmission_requested",
  },
};

export async function applyReviewDecision(
  tx: Transaction,
  input: ApplyReviewDecisionInput,
): Promise<KycStatus> {
  const reasonCode = input.reasonCode.trim();
  if (reasonCode.length === 0) {
    throw new Error(
      "applyReviewDecision: a reason code is required. An approval nobody can account for is not an approval.",
    );
  }

  /**
   * Locked, so two reviewers working the same queue cannot both decide. The
   * second one's transition then fails against the status the first one wrote,
   * which is the correct outcome — a stale queue page should not be able to
   * overwrite a fresh decision.
   */
  const existing = await tx
    .select({
      id: kycRecords.id,
      status: kycRecords.status,
      subjectUserId: kycRecords.userId,
    })
    .from(kycRecords)
    .where(eq(kycRecords.id, input.kycRecordId))
    .for("update")
    .limit(1);

  const current = existing[0];
  if (!current) {
    throw new Error(
      `applyReviewDecision: kyc_record ${input.kycRecordId} not found`,
    );
  }

  /**
   * Nobody decides their own case.
   *
   * Staff are customers too — an engineer can lease out their own land, and
   * somebody holding the compliance permission can be the subject of a case.
   * This is the cheapest control against the most obvious abuse, and it sits
   * inside the transaction rather than in a UI that merely hides a button.
   */
  if (current.subjectUserId && current.subjectUserId === input.reviewerUserId) {
    throw new Error(
      "applyReviewDecision: a reviewer cannot decide their own KYC case. Reassign it to a colleague.",
    );
  }

  const outcome = OUTCOME[input.action];
  const nextStatus = assertTransition(current.status as KycStatus, outcome.status);

  await tx
    .update(kycRecords)
    .set({
      status: nextStatus,
      reviewedBy: input.reviewerUserId,
      reviewedAt: input.now,
      reviewReasonCode: reasonCode,
      verifiedAt: nextStatus === "VERIFIED" ? input.now : null,
    })
    .where(eq(kycRecords.id, input.kycRecordId));

  await tx.insert(outboxEvents).values({
    eventType: outcome.event,
    aggregateType: "kyc_record",
    aggregateId: input.kycRecordId,
    /**
     * The reason code travels, because the message the customer receives has
     * to say what to do next — "retake your selfie in daylight" is useful,
     * "your verification needs attention" is not. The note does not travel:
     * it is written for colleagues and may discuss the person.
     */
    payload: {
      kycRecordId: input.kycRecordId,
      status: nextStatus,
      reasonCode,
      reviewedBy: input.reviewerUserId,
      occurredAt: input.now.toISOString(),
    },
  });

  await tx.insert(auditLog).values({
    actorUserId: input.reviewerUserId,
    actorType: "STAFF",
    action: "kyc.reviewed",
    resourceType: "kyc_record",
    resourceId: input.kycRecordId,
    changes: {
      from: current.status,
      to: nextStatus,
      action: input.action,
    },
    reasonCode,
    note: input.note,
    traceId: input.traceId,
  });

  return nextStatus;
}
