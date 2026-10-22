import type { KycStatus } from "./kycStatus.js";

/**
 * The KYC decision function.
 *
 * This is the only place a KYC outcome is computed. The browser never decides
 * — it shows a spinner. The vendor never decides — HyperVerge's own docs say
 * not to use the SDK result for backend decisions. The webhook handler calls
 * this, inside the transaction that writes the result.
 *
 * It is a pure function: no I/O, no clock of its own, no randomness. The
 * caller passes `now` and the thresholds, which makes every decision
 * reproducible from its stored inputs — which is exactly what a reviewer or an
 * auditor needs eighteen months later.
 */

/* ------------------------------------------------------------------ */
/* Inputs                                                             */
/* ------------------------------------------------------------------ */

export type KycLevel = "PAN_ONLY" | "FULL" | "KYB";

export interface AadhaarResult {
  status: "SUCCESS" | "FAILED";
  /** Name as held by UIDAI. Absent when the fetch failed. */
  nameOnRecord?: string;
  /** ISO date, YYYY-MM-DD. Absent when the fetch failed. */
  dateOfBirth?: string;
}

export interface PanResult {
  status: "VALID" | "INVALID" | "DEACTIVATED" | "FAKE";
  /** Whether the Income Tax Department matched the name we sent. */
  nameMatch: boolean;
  /** Whether it matched the date of birth we sent. */
  dobMatch: boolean;
  /** An unlinked PAN may be inoperative, which changes the TDS rate. */
  linkedToAadhaar: boolean;
}

export interface SelfieResult {
  livenessPassed: boolean;
  /** 0..1, against the Aadhaar photo. */
  faceMatchScore: number;
}

export interface GstResult {
  status: "ACTIVE" | "CANCELLED" | "SUSPENDED";
}

/**
 * The MCA company register.
 *
 * An active GST registration says nothing about whether the company still
 * exists. A struck-off company has no legal personality, so it cannot be
 * bound by a 25-year PPA — and without this, an active GSTIN belonging to a
 * struck-off company would pass.
 */
export interface CompanyResult {
  status: "ACTIVE" | "STRUCK_OFF" | "UNDER_LIQUIDATION" | "DORMANT";
  /**
   * Whether the name on the MCA register agrees with the GST legal name.
   *
   * When it does not, either the wrong CIN was entered or the two
   * registrations belong to different entities — and the B2B invoice would go
   * out against the wrong one, which strands the customer's input tax credit.
   */
  nameMatchesGst: boolean;
}

export interface KycDecisionInput {
  level: KycLevel;
  /** Injected so age is deterministic and testable. */
  now: Date;
  aadhaar?: AadhaarResult;
  pan?: PanResult;
  selfie?: SelfieResult;
  /**
   * A selfie is held, scanned and on file, but nothing has scored it.
   *
   * Only meaningful when `selfie` is absent, and it exists because the two
   * absences are different. A gateway that sells no liveness or face-match
   * check still lets a selfie be collected and stored — so the file is there
   * and no comparison has been made. Reporting that as SELFIE_MISSING sends
   * a reviewer looking for something that is sitting in front of them.
   *
   * It never softens the outcome. A selfie nobody scored is not evidence of a
   * face match, so this reviews exactly as a missing one does; it only changes
   * what the reviewer is told. Filling in a `livenessPassed` instead would be
   * the real danger: it would auto-approve an unexamined biometric.
   */
  selfieCollectedButNotScored?: boolean;
  gst?: GstResult;
  /**
   * KYB only, and only when the constitution calls for one.
   *
   * A proprietorship has no CIN, so absence is not a failure — demanding one
   * would make every proprietor unverifiable.
   */
  company?: CompanyResult;
  /** KYB only: the status of the person who will sign. */
  signatoryKycStatus?: KycStatus;
  /** True when this PAN's blind index already exists on another subject. */
  duplicatePan: boolean;
  /** Document fields the extractor read below the confidence threshold. */
  lowConfidenceFieldCount?: number;
  /** Play Integrity / App Attest. Undefined means "not checked". */
  deviceTrusted?: boolean;
}

/* ------------------------------------------------------------------ */
/* Thresholds                                                         */
/* ------------------------------------------------------------------ */

export interface KycThresholds {
  /** Minimum face match score to auto-approve. */
  faceMatch: number;
  /** Minimum name match score, used for the document name checks. */
  nameMatch: number;
  /** Minimum extracted-field confidence to pre-fill without review. */
  documentConfidence: number;
  /** How many low-confidence fields are tolerated before review. */
  maxLowConfidenceFields: number;
  /** Minimum age, in whole years. */
  minimumAge: number;
}

/**
 * Starting values. These live in the `settings` table in production so Ops can
 * retune them without a release — the guide is explicit that the face-match
 * bar should be revisited after the first 50 cases.
 */
export const DEFAULT_KYC_THRESHOLDS: KycThresholds = {
  faceMatch: 0.75,
  nameMatch: 0.75,
  documentConfidence: 0.85,
  maxLowConfidenceFields: 1,
  minimumAge: 18,
};

/* ------------------------------------------------------------------ */
/* Output                                                             */
/* ------------------------------------------------------------------ */

/**
 * HARD_FAIL  the subject cannot be verified, and no reviewer may wave it
 *            through without an explicit, logged override
 * REVIEW     a person has to look at it
 * FLAG       recorded for somebody downstream, blocks nothing
 */
export type ReasonSeverity = "HARD_FAIL" | "REVIEW" | "FLAG";

export interface DecisionReason {
  code: string;
  /** Written for the reviewer who will read it, with the numbers included. */
  detail: string;
  severity: ReasonSeverity;
}

export interface KycDecision {
  status: Extract<KycStatus, "VERIFIED" | "MANUAL_REVIEW" | "REJECTED">;
  reasons: DecisionReason[];
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Whole years between a YYYY-MM-DD date of birth and `now`, in UTC. */
export function ageInYears(dateOfBirth: string, now: Date): number {
  const [y, m, d] = dateOfBirth.split("-").map(Number);
  if (!y || !m || !d) {
    throw new Error("ageInYears: date of birth must be YYYY-MM-DD");
  }
  let age = now.getUTCFullYear() - y;
  const monthDiff = now.getUTCMonth() + 1 - m;
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < d)) {
    age -= 1;
  }
  return age;
}

/** Trims a score to 2 decimals for display in a reason string. */
function score(value: number): string {
  return value.toFixed(2);
}

/* ------------------------------------------------------------------ */
/* The decision                                                       */
/* ------------------------------------------------------------------ */

/**
 * Weighs every check and returns one of three statuses, with the reasons that
 * produced it.
 *
 * Precedence is fixed and not negotiable:
 *   1. any HARD_FAIL  -> REJECTED
 *   2. any REVIEW     -> MANUAL_REVIEW
 *   3. otherwise      -> VERIFIED (FLAGs may still be attached)
 *
 * A missing check is never treated as a passing check. That is the difference
 * between a cautious system and one that can be verified by sending less data.
 */
export function decideKyc(
  input: KycDecisionInput,
  thresholds: KycThresholds = DEFAULT_KYC_THRESHOLDS,
): KycDecision {
  const reasons: DecisionReason[] = [];
  const hardFail = (code: string, detail: string) =>
    reasons.push({ code, detail, severity: "HARD_FAIL" });
  const review = (code: string, detail: string) =>
    reasons.push({ code, detail, severity: "REVIEW" });
  const flag = (code: string, detail: string) =>
    reasons.push({ code, detail, severity: "FLAG" });

  const needsAadhaar = input.level === "FULL";
  const needsPan = input.level === "FULL" || input.level === "PAN_ONLY";
  const needsSelfie = input.level === "FULL";
  const needsGst = input.level === "KYB";

  /* ---- Aadhaar ---- */
  if (needsAadhaar) {
    if (!input.aadhaar || input.aadhaar.status !== "SUCCESS") {
      review(
        "AADHAAR_NOT_VERIFIED",
        "Aadhaar was not returned. The user can retry, or use the Aadhaar App route if their mobile is not linked.",
      );
    } else if (input.aadhaar.dateOfBirth) {
      const age = ageInYears(input.aadhaar.dateOfBirth, input.now);
      if (age < thresholds.minimumAge) {
        hardFail(
          "AGE_UNDER_18",
          `Aadhaar date of birth makes this person ${age}. A contract with a minor is not enforceable, and DPDP treats children's data separately.`,
        );
      }
    }
  }

  /* ---- PAN ---- */
  if (needsPan) {
    if (!input.pan) {
      review("PAN_MISSING", "No PAN result was recorded for a level that requires one.");
    } else {
      switch (input.pan.status) {
        case "DEACTIVATED":
          hardFail(
            "PAN_DEACTIVATED",
            "The Income Tax Department has deactivated this PAN. It must be reactivated before we can proceed.",
          );
          break;
        case "FAKE":
          hardFail("PAN_FAKE", "The Income Tax Department does not recognise this PAN.");
          break;
        case "INVALID":
          hardFail("PAN_INVALID", "This PAN is not valid.");
          break;
        case "VALID":
          if (!input.pan.nameMatch) {
            review(
              "PAN_NAME_MISMATCH",
              "The PAN record did not match the Aadhaar name. A name change after marriage is the usual explanation.",
            );
          }
          if (!input.pan.dobMatch) {
            review(
              "PAN_DOB_MISMATCH",
              "The PAN record did not match the Aadhaar date of birth.",
            );
          }
          if (!input.pan.linkedToAadhaar) {
            flag(
              "PAN_NOT_LINKED_TO_AADHAAR",
              "This PAN is not linked to Aadhaar and may be inoperative, which means a higher TDS rate under section 206AA. Finance decides; this does not block verification.",
            );
          }
          break;
      }
    }

    if (input.duplicatePan) {
      review(
        "PAN_ALREADY_USED",
        "This PAN is already on another account. Either merge the duplicate or reject it.",
      );
    }
  }

  /* ---- Selfie: liveness and face match ---- */
  if (needsSelfie) {
    if (!input.selfie) {
      if (input.selfieCollectedButNotScored) {
        review(
          "SELFIE_NOT_SCORED",
          "A selfie was collected and scanned, but no liveness or face-match check has been run on it — " +
            "the verification gateway in use does not offer one. Compare the selfie against the Aadhaar " +
            "photograph by eye. Aadhaar photographs are often a decade old, so expect them to look dated.",
        );
      } else {
        review("SELFIE_MISSING", "No selfie result was recorded for a FULL verification.");
      }
    } else {
      if (!input.selfie.livenessPassed) {
        review(
          "LIVENESS_FAILED",
          "The liveness check did not pass. After three attempts a cool-off and a fraud flag apply.",
        );
      }
      if (input.selfie.faceMatchScore < thresholds.faceMatch) {
        review(
          "FACE_MATCH_LOW",
          `Face match scored ${score(input.selfie.faceMatchScore)} against the Aadhaar photo; the pass mark is ${thresholds.faceMatch}. Aadhaar photos are often years old, so compare the two images rather than trusting the number.`,
        );
      }
    }
  }

  /* ---- GST and the authorised signatory ---- */
  if (needsGst) {
    if (!input.gst) {
      review("GST_MISSING", "No GST lookup result was recorded for a KYB.");
    } else if (input.gst.status === "CANCELLED") {
      hardFail(
        "GST_CANCELLED",
        "This GST registration is cancelled. We cannot raise a valid B2B invoice against it.",
      );
    } else if (input.gst.status === "SUSPENDED") {
      hardFail("GST_SUSPENDED", "This GST registration is suspended.");
    }

    /**
     * Checked only when a lookup was performed. The caller decides whether a
     * CIN is required, because that follows from the constitution the GST
     * lookup returned, not from anything visible here.
     */
    if (input.company) {
      if (
        input.company.status === "STRUCK_OFF" ||
        input.company.status === "UNDER_LIQUIDATION"
      ) {
        hardFail(
          "COMPANY_NOT_ACTIVE",
          `The MCA register shows this company as ${input.company.status.toLowerCase().replace("_", " ")}. A company without legal personality cannot be bound by a 25-year agreement.`,
        );
      } else if (input.company.status === "DORMANT") {
        review(
          "COMPANY_DORMANT",
          "The MCA register shows this company as dormant. That is recoverable, so a person decides rather than the machine.",
        );
      }

      if (!input.company.nameMatchesGst) {
        review(
          "COMPANY_NAME_MISMATCH",
          "The name on the MCA register does not agree with the GST legal name. Either the wrong CIN was entered, or the two registrations belong to different entities.",
        );
      }
    }

    if (input.signatoryKycStatus !== "VERIFIED") {
      review(
        "SIGNATORY_NOT_VERIFIED",
        `The person who will sign is ${input.signatoryKycStatus ?? "not recorded"}. Both gates must pass: the business is real, and this person may bind it.`,
      );
    }
  }

  /* ---- Document extraction ---- */
  const lowFields = input.lowConfidenceFieldCount ?? 0;
  if (lowFields > thresholds.maxLowConfidenceFields) {
    review(
      "DOCUMENT_LOW_CONFIDENCE",
      `${lowFields} document fields were read below ${thresholds.documentConfidence} confidence. More than ${thresholds.maxLowConfidenceFields} goes to a person.`,
    );
  }

  /* ---- Device signals ---- */
  if (input.deviceTrusted === false) {
    review(
      "DEVICE_UNTRUSTED",
      "Play Integrity or App Attest failed. This is the usual shape of free-trial farming.",
    );
  }

  /* ---- Precedence ---- */
  if (reasons.some((r) => r.severity === "HARD_FAIL")) {
    return { status: "REJECTED", reasons };
  }
  if (reasons.some((r) => r.severity === "REVIEW")) {
    return { status: "MANUAL_REVIEW", reasons };
  }
  return { status: "VERIFIED", reasons };
}
