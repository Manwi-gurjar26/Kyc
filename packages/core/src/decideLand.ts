import { nameMatchScore } from "@kilowattx/validation";
import type { DecisionReason, KycThresholds } from "./decideKyc.js";

/**
 * Whether a plot of land is ours to put panels on.
 *
 * This is the question behind ESIGN_LEASE, and it is emphatically not the same
 * question as "is this person verified". A perfectly verified person can hand
 * us the record for land they share with four siblings, or land their
 * neighbour already registered with us. Knowing who somebody is says nothing
 * about what they own.
 *
 * Pure, like decideKyc. No database, no clock. These rules have to be arguable
 * in a room with the legal team, which is far easier when they are a readable
 * list than when they are spread across a query and three services.
 */

export interface LandDocumentState {
  docType: string;
  scanStatus: "PENDING" | "CLEAN" | "INFECTED" | "ERRORED";
  lowConfidenceFieldCount: number;
  /** Legal's decision. null means nobody has looked yet. */
  approved: boolean | null;
}

export interface LandDecisionInput {
  /** The holder's name as the registry record reads it. */
  ownerNameOnRecord: string;
  /** The name we actually verified, from the KYC record. */
  verifiedName: string;
  /** Anybody else the record lists as holding a share. */
  coOwnerNames: string[];
  /** Legal has confirmed the co-owners agreed to the lease. */
  coOwnerConsentConfirmed: boolean;
  documents: LandDocumentState[];
  /** True when this khasra is also held by a different subject. */
  duplicateKhasra: boolean;
  /**
   * True when this parcel was registered before the other claim.
   *
   * It decides which side of a dispute is held up, and it is the difference
   * between a fraud check and a way to attack strangers — see the rule below.
   */
  claimedFirst: boolean;
  thresholds: KycThresholds;
}

export interface LandDecision {
  status: "VERIFIED" | "MANUAL_REVIEW" | "REJECTED";
  reasons: DecisionReason[];
  /** Reported as well as applied, so a reviewer sees how close it came. */
  ownerNameMatchScore: number;
  /**
   * True whenever the record names more than one holder.
   *
   * Carried on the decision rather than recomputed downstream: the lease
   * itself needs every co-owner's signature, and that fact must travel with
   * the verdict rather than be rediscovered by whatever generates the
   * document.
   */
  requiresAllCoOwners: boolean;
}

/**
 * The documents that establish who holds the land *now*.
 *
 * A sale deed is not on this list, and that is the point: a deed from 2019
 * records that the land changed hands then. The record of rights is the only
 * document that speaks to the present position, which is the only position a
 * lease can rest on.
 */
const RECORD_OF_RIGHTS_TYPES = new Set([
  "JAMABANDI",
  "KHASRA_KHATAUNI",
  "MUTATION_RECORD",
]);

export function decideLand(input: LandDecisionInput): LandDecision {
  const reasons: DecisionReason[] = [];

  const ownerNameMatchScore = nameMatchScore(
    input.ownerNameOnRecord,
    input.verifiedName,
  );

  /* ---------------- documents ---------------- */

  /**
   * Checked first and hardest. An infected document is not weak evidence, it
   * is no evidence: nobody has read it and nobody may. HARD_FAIL means no
   * reviewer waves it through without an explicit, logged override.
   */
  if (input.documents.some((d) => d.scanStatus === "INFECTED")) {
    reasons.push({
      code: "LAND_DOCUMENT_INFECTED",
      severity: "HARD_FAIL",
      detail:
        "One of the uploaded land documents failed a virus scan. It has been quarantined and cannot be used as evidence of anything.",
    });
  }

  if (input.documents.some((d) => d.approved === false)) {
    reasons.push({
      code: "LAND_DOCUMENT_REJECTED",
      severity: "HARD_FAIL",
      detail:
        "Legal rejected one of the land documents. A replacement has to be uploaded before this parcel can be used.",
    });
  }

  /**
   * Absence is never treated as success. A parcel with no record of rights has
   * not failed a check — it has skipped one, and the two must not collapse
   * into the same answer.
   */
  const hasRecordOfRights = input.documents.some(
    (d) => RECORD_OF_RIGHTS_TYPES.has(d.docType) && d.scanStatus === "CLEAN",
  );

  if (!hasRecordOfRights) {
    reasons.push({
      code: "LAND_RECORD_OF_RIGHTS_MISSING",
      severity: "REVIEW",
      detail:
        "We need a current record of rights — a Jamabandi or Khasra Khatauni — showing who holds this plot today. A sale deed on its own does not show the present position.",
    });
  }

  if (
    input.documents.some(
      (d) => d.scanStatus === "PENDING" || d.scanStatus === "ERRORED",
    )
  ) {
    reasons.push({
      code: "LAND_DOCUMENT_NOT_SCANNED",
      severity: "REVIEW",
      detail:
        "One of the land documents has not finished its virus scan. Nothing is approved on an unscanned file.",
    });
  }

  if (
    input.documents.some(
      (d) => d.lowConfidenceFieldCount >= input.thresholds.maxLowConfidenceFields + 1,
    )
  ) {
    reasons.push({
      code: "LAND_DOCUMENT_ILLEGIBLE",
      severity: "REVIEW",
      detail:
        "Too much of one document could not be read reliably. Somebody will check it against the original.",
    });
  }

  /**
   * Legal's approval is what the review queue is for. A parcel verified on
   * documents nobody signed off would make the whole review step decorative.
   */
  if (
    input.documents.length === 0 ||
    input.documents.some((d) => d.approved === null)
  ) {
    reasons.push({
      code: "LAND_DOCUMENTS_AWAITING_LEGAL",
      severity: "REVIEW",
      detail: "Our legal team is still reviewing the land documents.",
    });
  }

  /* ---------------- the name on the record ---------------- */

  if (ownerNameMatchScore < input.thresholds.nameMatch) {
    /**
     * A review, not a rejection. Land records are routinely decades old and
     * still carry a maiden name, or a father's name in place of the current
     * holder's — the commonest cause of a low score here is history, not
     * fraud.
     */
    reasons.push({
      code: "LAND_OWNER_NAME_MISMATCH",
      severity: "REVIEW",
      detail:
        "The name on the land record is not close enough to the name we verified. This is usually an old record rather than a problem, and a person will check it.",
    });
  }

  /* ---------------- jointly held land ---------------- */

  const requiresAllCoOwners = input.coOwnerNames.length > 0;

  /**
   * The single most expensive thing to get wrong here.
   *
   * Inherited agricultural land is routinely held by several siblings, and a
   * lease signed by one of them is a lease the others can have set aside —
   * after the panels are already on the ground. So it is not a refusal:
   * jointly held land is leasable, it simply cannot be leased on one
   * signature, and Legal confirms the others have agreed.
   */
  if (requiresAllCoOwners && !input.coOwnerConsentConfirmed) {
    reasons.push({
      code: "LAND_CO_OWNER_CONSENT_REQUIRED",
      severity: "REVIEW",
      detail: `This record names ${input.coOwnerNames.length + 1} holders. Every co-owner has to agree before a lease can be signed, so we will confirm that with each of them.`,
    });
  }

  /* ---------------- the same plot, twice ---------------- */

  if (input.duplicateKhasra) {
    /**
     * The land equivalent of the duplicate-PAN check, and it catches a real
     * fraud: registering a neighbour's plot, or the same plot through two
     * accounts to collect two sets of rent.
     *
     * Whoever registered first is not blocked, and that asymmetry is the whole
     * point. Holding up both sides would mean anybody could take a verified
     * owner's land out of service by registering their khasra number — the
     * real owner's lease would stop working the moment anything re-decided
     * their parcel. A fraud check that can be pointed at strangers is a
     * weapon, not a check.
     *
     * Found by running the walkthrough twice. The first claimant appeared
     * protected on the first run only because nothing had re-decided their
     * parcel yet; on the second run they lost their lease to the other
     * account's claim. The protection is now the rule rather than an artifact
     * of stale state.
     *
     * Neither side is ever auto-rejected. Two claims on one plot means at
     * least one is wrong and we do not know which.
     */
    if (input.claimedFirst) {
      reasons.push({
        code: "LAND_KHASRA_DISPUTED",
        severity: "FLAG",
        detail:
          "Another account has registered this khasra number since you did. Your own registration stands; we are establishing what the other claim is.",
      });
    } else {
      reasons.push({
        code: "LAND_KHASRA_ALREADY_CLAIMED",
        severity: "REVIEW",
        detail:
          "This khasra number is already registered against another account. We have to establish who holds it before this one can proceed.",
      });
    }
  }

  /* ---------------- precedence ---------------- */

  const status = reasons.some((r) => r.severity === "HARD_FAIL")
    ? "REJECTED"
    : reasons.some((r) => r.severity === "REVIEW")
      ? "MANUAL_REVIEW"
      : "VERIFIED";

  return { status, reasons, ownerNameMatchScore, requiresAllCoOwners };
}
