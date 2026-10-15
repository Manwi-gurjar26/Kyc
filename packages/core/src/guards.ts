import type { KycStatus } from "./kycStatus.js";

/**
 * KYC guards: which action unlocks when.
 *
 * The API's permission guard calls these. Hiding a button in the UI is a
 * courtesy; this is the block. Without it, anyone could call the endpoint
 * directly and sign a lease.
 */

export const KYC_ACTIONS = [
  "START_TRIAL",
  "INVEST",
  "ESIGN_PPA",
  "ESIGN_LEASE",
  "LIST_ON_MARKETPLACE",
] as const;

export type KycAction = (typeof KYC_ACTIONS)[number];

export interface SubjectKycState {
  /** The person's own KYC. */
  personalKycStatus: KycStatus;
  phoneVerified: boolean;
  /** The light PAN check used for the trial. */
  panCheckPassed: boolean;
  /** This PAN already exists on another subject. */
  panAlreadyUsed: boolean;
  /** The business's KYB, for a Commercial User. */
  kybStatus?: KycStatus;
  /** The KYC of the person who will sign on the business's behalf. */
  signatoryKycStatus?: KycStatus;
  /**
   * Whether Legal has approved this person's authority to bind the business.
   *
   * A separate question from their KYC, and the one that is easier to forget.
   * A finance clerk can be perfectly verified as a person and still have no
   * authority to commit their employer to a 25-year agreement — that comes
   * from a board resolution or an authorisation letter a human reads, recorded
   * as `org_members.authority_approved_at`.
   *
   * Optional in the type and treated as false when absent: a caller that did
   * not read the column is precisely the caller that would otherwise let an
   * unauthorised person sign.
   */
  signatoryAuthorityApproved?: boolean;
  /** Legal has approved the registry papers. */
  landDocumentsApproved?: boolean;
}

export interface GuardResult {
  allowed: boolean;
  /** Returned to the client as the error `code`. Always set on a denial. */
  code?: string;
  /** Written for the user, not the developer. */
  message?: string;
}

const ALLOW: GuardResult = { allowed: true };

function deny(code: string, message: string): GuardResult {
  return { allowed: false, code, message };
}

/**
 * Turns a KYC status into the denial that best explains it.
 *
 * The codes are distinct on purpose: "we have not started" and "we are looking
 * at it" need different screens, and a user told to re-submit something that
 * is already in a queue will simply submit it again.
 */
function denialForStatus(status: KycStatus, subject: "KYC" | "KYB"): GuardResult | null {
  switch (status) {
    case "VERIFIED":
      return null;
    case "BLOCKED":
      return deny(
        "ACCOUNT_BLOCKED",
        "This account is on hold. Please contact support.",
      );
    case "MANUAL_REVIEW":
      return subject === "KYB"
        ? deny("KYB_REQUIRED", "We are still checking your business details.")
        : deny("KYC_IN_REVIEW", "A colleague is reviewing your details.");
    case "REJECTED":
      return subject === "KYB"
        ? deny("KYB_REQUIRED", "Your business could not be verified.")
        : deny("KYC_REJECTED", "We could not verify your details.");
    case "NOT_STARTED":
    case "IN_PROGRESS":
      return subject === "KYB"
        ? deny("KYB_REQUIRED", "Please verify your business first.")
        : deny("KYC_REQUIRED", "Please complete verification first.");
  }
}

/** A blocked subject does nothing, whatever else is true of their record. */
function blockedEverywhere(state: SubjectKycState): GuardResult | null {
  if (state.personalKycStatus === "BLOCKED") {
    return deny("ACCOUNT_BLOCKED", "This account is on hold. Please contact support.");
  }
  return null;
}

/**
 * Whether a subject may take an action.
 *
 * Every branch returns an explicit decision. There is no fall-through default,
 * so adding a member to KYC_ACTIONS without writing its guard is a type error
 * rather than a silently permitted action.
 */
export function can(action: KycAction, state: SubjectKycState): GuardResult {
  const blocked = blockedEverywhere(state);
  if (blocked) return blocked;

  switch (action) {
    /**
     * The trial deliberately does NOT require full KYC. It costs one PAN
     * lookup, which is most of why the KYC bill stays manageable.
     */
    case "START_TRIAL": {
      if (!state.phoneVerified) {
        return deny(
          "PHONE_VERIFICATION_REQUIRED",
          "Please verify your mobile number first.",
        );
      }
      if (state.panAlreadyUsed) {
        return deny(
          "PAN_ALREADY_USED",
          "This PAN has already been used for a free trial.",
        );
      }
      if (!state.panCheckPassed) {
        return deny("KYC_REQUIRED", "Please complete the PAN check first.");
      }
      return ALLOW;
    }

    case "INVEST": {
      return denialForStatus(state.personalKycStatus, "KYC") ?? ALLOW;
    }

    /** Two gates: the business is real, and this person may bind it. */
    case "ESIGN_PPA": {
      const kyb = denialForStatus(state.kybStatus ?? "NOT_STARTED", "KYB");
      if (kyb) return kyb;

      if (state.signatoryKycStatus !== "VERIFIED") {
        return deny(
          "SIGNATORY_KYC_REQUIRED",
          "The person signing still needs to complete their own verification.",
        );
      }

      /**
       * Verified is not the same as authorised, and this is the gate that was
       * missing. The column recording it existed and was shown in the KYB
       * view; nothing enforced it, so a verified employee who had never been
       * named on a board resolution would have passed.
       *
       * Checked last of the three because it is the most specific: an
       * unverified company or an unverified person is a bigger and earlier
       * problem, and reporting those first gives whoever is stuck the step
       * they actually need next.
       */
      if (state.signatoryAuthorityApproved !== true) {
        return deny(
          "SIGNATORY_AUTHORITY_REQUIRED",
          "We still need the board resolution or authorisation letter naming this person as a signatory.",
        );
      }

      return ALLOW;
    }

    /** Personal KYC plus Legal's approval of the registry papers. */
    case "ESIGN_LEASE": {
      const kyc = denialForStatus(state.personalKycStatus, "KYC");
      if (kyc) return kyc;
      if (!state.landDocumentsApproved) {
        return deny(
          "LAND_DOCUMENTS_REQUIRED",
          "We are still reviewing your land ownership documents.",
        );
      }
      return ALLOW;
    }

    /**
     * Listing is full personal KYC and nothing else.
     *
     * It used to additionally require a validated bank account, which was the
     * one place this module knew anything about money. Payouts are not part of
     * this service, so the extra gate went with them — and leaving a
     * `bankValidated` field that nothing set would have been worse than
     * removing it, because an unset optional reads as "not validated" and
     * would have denied every listing.
     */
    case "LIST_ON_MARKETPLACE": {
      return denialForStatus(state.personalKycStatus, "KYC") ?? ALLOW;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Who reviews what                                                   */
/* ------------------------------------------------------------------ */

export type ReviewCaseType = "PERSONAL" | "KYB" | "LAND_DOCUMENTS";

/**
 * Reviewer permissions.
 *
 * The stack doc lists no KYC reviewer role, so this follows the guide's
 * suggestion and stays an open decision with the compliance team: personal
 * cases go to Support or a dedicated compliance permission; anything a lawyer
 * should read — a board resolution, a sale deed — goes to Legal.
 */
const REVIEWERS: Readonly<Record<ReviewCaseType, readonly string[]>> = {
  PERSONAL: ["compliance", "support", "super_admin"],
  KYB: ["legal", "super_admin"],
  LAND_DOCUMENTS: ["legal", "super_admin"],
};

/** Whether any of a staff member's roles may act on this kind of case. */
export function canReviewCase(
  staffRoles: readonly string[],
  caseType: ReviewCaseType,
): boolean {
  const allowed = REVIEWERS[caseType];
  return staffRoles.some((role) => allowed.includes(role));
}

/**
 * Overriding a failed check is a separate, higher permission than approving a
 * case that merely scored low. It additionally requires a second approver and
 * a fresh login, enforced at the API layer.
 */
export function canOverrideFailedCheck(staffRoles: readonly string[]): boolean {
  return staffRoles.includes("super_admin");
}
