import {
  decideKyc,
  panBlindIndex,
  type KycDecision,
  type KycLevel,
  type KycStatus,
  type KycThresholds,
} from "@kilowattx/core";
import {
  applyKycDecision,
  kycRecords,
  type CheckRecord,
  type Transaction,
} from "@kilowattx/db";
import type { VendorKycResult } from "@kilowattx/integrations";
import { and, eq, ne } from "drizzle-orm";
import type { PanEncryptor } from "./panEncryption.js";

/**
 * The one path from "the vendor said something" to "the record has a status".
 *
 * Two callers need it: the API, when a webhook arrives, and the worker, when
 * reconciliation finds a session whose webhook never came. Before this
 * existed it lived in the API as a private method, and the worker was about
 * to grow its own copy — of the duplicate-PAN check, the encryption and the
 * five-table transaction. Two copies of that would have drifted, silently, in
 * the part of the system where being wrong matters most.
 *
 * It composes rather than decides: `decideKyc()` in packages/core settles the
 * status, `applyKycDecision` in packages/db writes it, and this function's
 * only judgement is how to turn a vendor's shape into their inputs.
 */

export interface ApplyVendorResultParams {
  result: VendorKycResult;
  thresholds: KycThresholds;
  /** 32+ bytes from the secret store. Keys the duplicate-PAN index. */
  blindIndexKey: Buffer;
  encryptor: PanEncryptor;
  now: Date;
  /** Falls back to the vendor's event id, which is what the webhook carries. */
  traceId?: string;
}

export interface ApplyVendorResultOutcome {
  kycRecordId: string;
  status: KycStatus;
  decision: KycDecision;
}

export async function applyVendorResult(
  tx: Transaction,
  params: ApplyVendorResultParams,
): Promise<ApplyVendorResultOutcome> {
  const { result, thresholds, blindIndexKey, encryptor, now } = params;

  const records = await tx
    .select({ id: kycRecords.id, level: kycRecords.level })
    .from(kycRecords)
    .where(eq(kycRecords.vendorSessionId, result.vendorSessionId))
    .limit(1);

  const record = records[0];
  if (!record) {
    throw new Error(
      `applyVendorResult: no kyc_record matches vendor session ${result.vendorSessionId}`,
    );
  }

  const pan = result.pan?.pan;
  const blindIndex = pan ? panBlindIndex(pan, blindIndexKey) : undefined;

  const decision = decideKyc(
    {
      level: record.level as KycLevel,
      now,
      aadhaar: result.aadhaar,
      pan: result.pan,
      selfie: result.selfie,
      duplicatePan: blindIndex
        ? await isDuplicatePan(tx, blindIndex, record.id)
        : false,
    },
    thresholds,
  );

  return {
    kycRecordId: record.id,
    status: await applyKycDecision(tx, {
      kycRecordId: record.id,
      decision,
      thresholds,
      now,
      vendor: result.vendor,
      vendorVersion: result.vendorVersion,
      aadhaarLast4: result.aadhaar?.last4,
      aadhaarRefToken: result.aadhaar?.refToken,
      panEncrypted: pan ? await encryptor.encrypt(pan) : undefined,
      panBlindIndex: blindIndex,
      panLast4: pan?.slice(-4),
      livenessPassed: result.selfie?.livenessPassed,
      faceMatchScore: result.selfie?.faceMatchScore,
      checks: buildChecks(result, thresholds),
      actorType: "SYSTEM",
      traceId: params.traceId ?? result.eventId,
    }),
    decision,
  };
}

/**
 * Whether this PAN already belongs to somebody else.
 *
 * The `ne(id, ownRecordId)` is the part that is easy to leave out and painful
 * to debug. Reconciliation reprocesses a session whose record may already
 * carry the PAN from an earlier partial run; without excluding itself, the
 * query finds the subject's own PAN and reports them as a duplicate of
 * themselves. A lost webhook then becomes a manual review in which the
 * reviewer can see nothing wrong.
 *
 * Answered against the blind index, so no stored PAN is ever decrypted to
 * find out.
 */
async function isDuplicatePan(
  tx: Transaction,
  blindIndex: string,
  ownRecordId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: kycRecords.id })
    .from(kycRecords)
    .where(
      and(
        eq(kycRecords.panBlindIndex, blindIndex),
        ne(kycRecords.id, ownRecordId),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

/**
 * One kyc_checks row per check the vendor performed, including failures.
 *
 * FACE_MATCH is judged against the threshold here rather than taken from the
 * vendor, because the threshold is ours and lives in the settings table — the
 * vendor returns a score, not a verdict.
 */
function buildChecks(
  result: VendorKycResult,
  thresholds: KycThresholds,
): CheckRecord[] {
  const checks: CheckRecord[] = [];

  if (result.aadhaar) {
    checks.push({
      checkType: "AADHAAR",
      status: result.aadhaar.status === "SUCCESS" ? "PASSED" : "FAILED",
      rawResponseKey: result.rawResponseKey,
    });
  }

  if (result.pan) {
    checks.push({
      checkType: "PAN",
      status: result.pan.status === "VALID" ? "PASSED" : "FAILED",
      /** No PAN in the detail text — this column is read by reviewers. */
      detail:
        `status=${result.pan.status} nameMatch=${result.pan.nameMatch} ` +
        `dobMatch=${result.pan.dobMatch} aadhaarLinked=${result.pan.linkedToAadhaar}`,
      rawResponseKey: result.rawResponseKey,
    });
  }

  if (result.selfie) {
    checks.push({
      checkType: "LIVENESS",
      status: result.selfie.livenessPassed ? "PASSED" : "FAILED",
    });
    checks.push({
      checkType: "FACE_MATCH",
      status:
        result.selfie.faceMatchScore >= thresholds.faceMatch ? "PASSED" : "FAILED",
      score: result.selfie.faceMatchScore,
      detail: `scored against a pass mark of ${thresholds.faceMatch}`,
    });
  }

  return checks;
}
