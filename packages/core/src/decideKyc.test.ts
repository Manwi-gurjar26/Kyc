import { describe, expect, test } from "vitest";
import {
  DEFAULT_KYC_THRESHOLDS,
  decideKyc,
  type KycDecisionInput,
  type KycThresholds,
} from "./decideKyc.js";

/** Fixed clock, so an age assertion does not rot as the calendar moves. */
const NOW = new Date("2026-10-08T12:00:00.000Z");

function fullKyc(overrides: Partial<KycDecisionInput> = {}): KycDecisionInput {
  return {
    level: "FULL",
    now: NOW,
    aadhaar: {
      status: "SUCCESS",
      nameOnRecord: "Ramesh Kumar Sharma",
      dateOfBirth: "1979-03-14",
    },
    pan: {
      status: "VALID",
      nameMatch: true,
      dobMatch: true,
      linkedToAadhaar: true,
    },
    selfie: { livenessPassed: true, faceMatchScore: 0.91 },
    duplicatePan: false,
    ...overrides,
  };
}

function codes(reasons: { code: string }[]): string[] {
  return reasons.map((r) => r.code);
}

/* ------------------------------------------------------------------ */

describe("decideKyc — the happy path", () => {
  test("auto-approves when liveness and face match both pass", () => {
    const decision = decideKyc(fullKyc(), DEFAULT_KYC_THRESHOLDS);
    expect(decision.status).toBe("VERIFIED");
    expect(decision.reasons).toEqual([]);
  });

  test("a PAN-only trial needs no Aadhaar or selfie", () => {
    const decision = decideKyc(
      {
        level: "PAN_ONLY",
        now: NOW,
        pan: { status: "VALID", nameMatch: true, dobMatch: true, linkedToAadhaar: true },
        duplicatePan: false,
      },
      DEFAULT_KYC_THRESHOLDS,
    );
    expect(decision.status).toBe("VERIFIED");
  });

  test("an active GST, an active company and a verified signatory clear a KYB", () => {
    const decision = decideKyc(
      {
        level: "KYB",
        now: NOW,
        gst: { status: "ACTIVE" },
        company: { status: "ACTIVE", nameMatchesGst: true },
        signatoryKycStatus: "VERIFIED",
        duplicatePan: false,
      },
      DEFAULT_KYC_THRESHOLDS,
    );
    expect(decision.status).toBe("VERIFIED");
  });
});

/* ------------------------------------------------------------------ */

/**
 * The company register.
 *
 * A GST registration being active says nothing about whether the company
 * still exists. A struck-off company has no legal personality, so it cannot
 * sign a 25-year PPA — and without this check an active GSTIN on a struck-off
 * company would sail through.
 */
describe("decideKyc — the MCA company register", () => {
  function kyb(overrides: Partial<KycDecisionInput> = {}): KycDecisionInput {
    return {
      level: "KYB",
      now: NOW,
      gst: { status: "ACTIVE" },
      company: { status: "ACTIVE", nameMatchesGst: true },
      signatoryKycStatus: "VERIFIED",
      duplicatePan: false,
      ...overrides,
    };
  }

  test("an active company passes", () => {
    expect(decideKyc(kyb(), DEFAULT_KYC_THRESHOLDS).status).toBe("VERIFIED");
  });

  test("a struck-off company is a hard fail", () => {
    const decision = decideKyc(
      kyb({ company: { status: "STRUCK_OFF", nameMatchesGst: true } }),
      DEFAULT_KYC_THRESHOLDS,
    );
    expect(decision.status).toBe("REJECTED");
    expect(codes(decision.reasons)).toContain("COMPANY_NOT_ACTIVE");
  });

  test("a company under liquidation is a hard fail", () => {
    const decision = decideKyc(
      kyb({ company: { status: "UNDER_LIQUIDATION", nameMatchesGst: true } }),
      DEFAULT_KYC_THRESHOLDS,
    );
    expect(decision.status).toBe("REJECTED");
    expect(codes(decision.reasons)).toContain("COMPANY_NOT_ACTIVE");
  });

  /** Dormant is recoverable, so a person decides rather than the machine. */
  test("a dormant company goes to review", () => {
    const decision = decideKyc(
      kyb({ company: { status: "DORMANT", nameMatchesGst: true } }),
      DEFAULT_KYC_THRESHOLDS,
    );
    expect(decision.status).toBe("MANUAL_REVIEW");
    expect(codes(decision.reasons)).toContain("COMPANY_DORMANT");
  });

  /**
   * The MCA name and the GST legal name have to agree. When they do not,
   * either the wrong CIN was entered or the two registrations belong to
   * different entities — and the invoice would go out on the wrong one.
   */
  test("a company name that disagrees with the GST name goes to review", () => {
    const decision = decideKyc(
      kyb({ company: { status: "ACTIVE", nameMatchesGst: false } }),
      DEFAULT_KYC_THRESHOLDS,
    );
    expect(decision.status).toBe("MANUAL_REVIEW");
    expect(codes(decision.reasons)).toContain("COMPANY_NAME_MISMATCH");
  });

  /**
   * A proprietorship has no CIN, and demanding one would make every
   * proprietor unverifiable. Absence is only a problem when the constitution
   * says there should be one.
   */
  test("a KYB with no company lookup is fine when none is required", () => {
    const input = kyb();
    delete (input as { company?: unknown }).company;
    expect(decideKyc(input, DEFAULT_KYC_THRESHOLDS).status).toBe("VERIFIED");
  });

  test("a cancelled GST outranks an active company", () => {
    const decision = decideKyc(
      kyb({ gst: { status: "CANCELLED" } }),
      DEFAULT_KYC_THRESHOLDS,
    );
    expect(decision.status).toBe("REJECTED");
    expect(codes(decision.reasons)).toContain("GST_CANCELLED");
  });
});

/* ------------------------------------------------------------------ */

describe("decideKyc — hard fails go straight to REJECTED", () => {
  test("rejects someone under 18", () => {
    const decision = decideKyc(
      fullKyc({
        aadhaar: {
          status: "SUCCESS",
          nameOnRecord: "Aarav Sharma",
          dateOfBirth: "2009-06-01",
        },
      }),
      DEFAULT_KYC_THRESHOLDS,
    );
    expect(decision.status).toBe("REJECTED");
    expect(codes(decision.reasons)).toContain("AGE_UNDER_18");
  });

  test("accepts someone who turned 18 today", () => {
    const decision = decideKyc(
      fullKyc({
        aadhaar: {
          status: "SUCCESS",
          nameOnRecord: "Aarav Sharma",
          dateOfBirth: "2008-10-08",
        },
      }),
      DEFAULT_KYC_THRESHOLDS,
    );
    expect(decision.status).toBe("VERIFIED");
  });

  test("rejects someone one day short of 18", () => {
    const decision = decideKyc(
      fullKyc({
        aadhaar: {
          status: "SUCCESS",
          nameOnRecord: "Aarav Sharma",
          dateOfBirth: "2008-10-09",
        },
      }),
      DEFAULT_KYC_THRESHOLDS,
    );
    expect(decision.status).toBe("REJECTED");
  });

  test("rejects a deactivated PAN", () => {
    const decision = decideKyc(
      fullKyc({
        pan: {
          status: "DEACTIVATED",
          nameMatch: true,
          dobMatch: true,
          linkedToAadhaar: true,
        },
      }),
      DEFAULT_KYC_THRESHOLDS,
    );
    expect(decision.status).toBe("REJECTED");
    expect(codes(decision.reasons)).toContain("PAN_DEACTIVATED");
  });

  test("rejects a fake PAN", () => {
    const decision = decideKyc(
      fullKyc({
        pan: { status: "FAKE", nameMatch: false, dobMatch: false, linkedToAadhaar: false },
      }),
      DEFAULT_KYC_THRESHOLDS,
    );
    expect(decision.status).toBe("REJECTED");
    expect(codes(decision.reasons)).toContain("PAN_FAKE");
  });

  test("rejects a cancelled GST registration", () => {
    const decision = decideKyc(
      {
        level: "KYB",
        now: NOW,
        gst: { status: "CANCELLED" },
        signatoryKycStatus: "VERIFIED",
        duplicatePan: false,
      },
      DEFAULT_KYC_THRESHOLDS,
    );
    expect(decision.status).toBe("REJECTED");
    expect(codes(decision.reasons)).toContain("GST_CANCELLED");
  });

  test("rejects a suspended GST registration", () => {
    const decision = decideKyc(
      {
        level: "KYB",
        now: NOW,
        gst: { status: "SUSPENDED" },
        signatoryKycStatus: "VERIFIED",
        duplicatePan: false,
      },
      DEFAULT_KYC_THRESHOLDS,
    );
    expect(decision.status).toBe("REJECTED");
  });

  test("a hard fail outranks any number of review reasons", () => {
    const decision = decideKyc(
      fullKyc({
        aadhaar: {
          status: "SUCCESS",
          nameOnRecord: "Aarav Sharma",
          dateOfBirth: "2009-06-01",
        },
        selfie: { livenessPassed: false, faceMatchScore: 0.2 },
        duplicatePan: true,
      }),
      DEFAULT_KYC_THRESHOLDS,
    );
    expect(decision.status).toBe("REJECTED");
  });
});

/* ------------------------------------------------------------------ */

describe("decideKyc — anything unclear goes to a person", () => {
  test("a face match below the threshold goes to review", () => {
    const decision = decideKyc(
      fullKyc({ selfie: { livenessPassed: true, faceMatchScore: 0.68 } }),
      DEFAULT_KYC_THRESHOLDS,
    );
    expect(decision.status).toBe("MANUAL_REVIEW");
    expect(codes(decision.reasons)).toContain("FACE_MATCH_LOW");
  });

  test("the reason carries the score and the threshold, for the reviewer", () => {
    const decision = decideKyc(
      fullKyc({ selfie: { livenessPassed: true, faceMatchScore: 0.68 } }),
      DEFAULT_KYC_THRESHOLDS,
    );
    const reason = decision.reasons.find((r) => r.code === "FACE_MATCH_LOW");
    expect(reason?.detail).toContain("0.68");
    expect(reason?.detail).toContain(String(DEFAULT_KYC_THRESHOLDS.faceMatch));
  });

  test("a failed liveness check goes to review, not rejection", () => {
    const decision = decideKyc(
      fullKyc({ selfie: { livenessPassed: false, faceMatchScore: 0.95 } }),
      DEFAULT_KYC_THRESHOLDS,
    );
    expect(decision.status).toBe("MANUAL_REVIEW");
    expect(codes(decision.reasons)).toContain("LIVENESS_FAILED");
  });

  test("a PAN name mismatch goes to review — marriage name changes are common", () => {
    const decision = decideKyc(
      fullKyc({
        pan: {
          status: "VALID",
          nameMatch: false,
          dobMatch: true,
          linkedToAadhaar: true,
        },
      }),
      DEFAULT_KYC_THRESHOLDS,
    );
    expect(decision.status).toBe("MANUAL_REVIEW");
    expect(codes(decision.reasons)).toContain("PAN_NAME_MISMATCH");
  });

  test("a PAN date-of-birth mismatch goes to review", () => {
    const decision = decideKyc(
      fullKyc({
        pan: {
          status: "VALID",
          nameMatch: true,
          dobMatch: false,
          linkedToAadhaar: true,
        },
      }),
      DEFAULT_KYC_THRESHOLDS,
    );
    expect(decision.status).toBe("MANUAL_REVIEW");
    expect(codes(decision.reasons)).toContain("PAN_DOB_MISMATCH");
  });

  test("a PAN already used on another account goes to review", () => {
    const decision = decideKyc(fullKyc({ duplicatePan: true }), DEFAULT_KYC_THRESHOLDS);
    expect(decision.status).toBe("MANUAL_REVIEW");
    expect(codes(decision.reasons)).toContain("PAN_ALREADY_USED");
  });

  test("a failed Aadhaar fetch goes to review so the user can retry", () => {
    const decision = decideKyc(
      fullKyc({ aadhaar: { status: "FAILED" } }),
      DEFAULT_KYC_THRESHOLDS,
    );
    expect(decision.status).toBe("MANUAL_REVIEW");
    expect(codes(decision.reasons)).toContain("AADHAAR_NOT_VERIFIED");
  });

  test("two or more low-confidence document fields go to review", () => {
    const decision = decideKyc(
      fullKyc({ lowConfidenceFieldCount: 2 }),
      DEFAULT_KYC_THRESHOLDS,
    );
    expect(decision.status).toBe("MANUAL_REVIEW");
    expect(codes(decision.reasons)).toContain("DOCUMENT_LOW_CONFIDENCE");
  });

  test("one low-confidence field is pre-filled and does not block", () => {
    const decision = decideKyc(
      fullKyc({ lowConfidenceFieldCount: 1 }),
      DEFAULT_KYC_THRESHOLDS,
    );
    expect(decision.status).toBe("VERIFIED");
  });

  test("a KYB whose signatory is not verified goes to review", () => {
    const decision = decideKyc(
      {
        level: "KYB",
        now: NOW,
        gst: { status: "ACTIVE" },
        signatoryKycStatus: "MANUAL_REVIEW",
        duplicatePan: false,
      },
      DEFAULT_KYC_THRESHOLDS,
    );
    expect(decision.status).toBe("MANUAL_REVIEW");
    expect(codes(decision.reasons)).toContain("SIGNATORY_NOT_VERIFIED");
  });
});

/* ------------------------------------------------------------------ */

describe("decideKyc — missing checks never become a pass", () => {
  test("a FULL decision without a selfie goes to review, not VERIFIED", () => {
    const input = fullKyc();
    delete (input as { selfie?: unknown }).selfie;
    const decision = decideKyc(input, DEFAULT_KYC_THRESHOLDS);
    expect(decision.status).toBe("MANUAL_REVIEW");
    expect(codes(decision.reasons)).toContain("SELFIE_MISSING");
  });

  test("a FULL decision without a PAN result goes to review", () => {
    const input = fullKyc();
    delete (input as { pan?: unknown }).pan;
    const decision = decideKyc(input, DEFAULT_KYC_THRESHOLDS);
    expect(decision.status).toBe("MANUAL_REVIEW");
    expect(codes(decision.reasons)).toContain("PAN_MISSING");
  });

  test("a KYB decision without a GST result goes to review", () => {
    const decision = decideKyc(
      { level: "KYB", now: NOW, signatoryKycStatus: "VERIFIED", duplicatePan: false },
      DEFAULT_KYC_THRESHOLDS,
    );
    expect(decision.status).toBe("MANUAL_REVIEW");
    expect(codes(decision.reasons)).toContain("GST_MISSING");
  });
});

/* ------------------------------------------------------------------ */

describe("decideKyc — flags inform without blocking", () => {
  test("an inoperative PAN is flagged for Finance but still verifies", () => {
    const decision = decideKyc(
      fullKyc({
        pan: {
          status: "VALID",
          nameMatch: true,
          dobMatch: true,
          linkedToAadhaar: false,
        },
      }),
      DEFAULT_KYC_THRESHOLDS,
    );
    expect(decision.status).toBe("VERIFIED");
    expect(codes(decision.reasons)).toContain("PAN_NOT_LINKED_TO_AADHAAR");
  });

  test("the flag says it affects TDS, so Finance knows why it matters", () => {
    const decision = decideKyc(
      fullKyc({
        pan: {
          status: "VALID",
          nameMatch: true,
          dobMatch: true,
          linkedToAadhaar: false,
        },
      }),
      DEFAULT_KYC_THRESHOLDS,
    );
    const flag = decision.reasons.find((r) => r.code === "PAN_NOT_LINKED_TO_AADHAAR");
    expect(flag?.severity).toBe("FLAG");
    expect(flag?.detail).toMatch(/TDS/i);
  });
});

/* ------------------------------------------------------------------ */

describe("decideKyc — thresholds come from settings, not the code", () => {
  test("raising the face-match bar turns a pass into a review", () => {
    const strict: KycThresholds = { ...DEFAULT_KYC_THRESHOLDS, faceMatch: 0.95 };
    const input = fullKyc({ selfie: { livenessPassed: true, faceMatchScore: 0.91 } });

    expect(decideKyc(input, DEFAULT_KYC_THRESHOLDS).status).toBe("VERIFIED");
    expect(decideKyc(input, strict).status).toBe("MANUAL_REVIEW");
  });

  test("raising the tolerated low-confidence count turns a review into a pass", () => {
    const lenient: KycThresholds = {
      ...DEFAULT_KYC_THRESHOLDS,
      maxLowConfidenceFields: 4,
    };
    const input = fullKyc({ lowConfidenceFieldCount: 3 });

    expect(decideKyc(input, DEFAULT_KYC_THRESHOLDS).status).toBe("MANUAL_REVIEW");
    expect(decideKyc(input, lenient).status).toBe("VERIFIED");
  });
});

/* ------------------------------------------------------------------ */

describe("decideKyc — properties that must always hold", () => {
  test("the same input always produces the same decision", () => {
    const input = fullKyc({ selfie: { livenessPassed: true, faceMatchScore: 0.74 } });
    const a = decideKyc(input, DEFAULT_KYC_THRESHOLDS);
    const b = decideKyc(input, DEFAULT_KYC_THRESHOLDS);
    expect(a).toEqual(b);
  });

  test("it never returns a status outside the three it is allowed to", () => {
    const scores = [0, 0.25, 0.5, 0.74, 0.75, 0.9, 1];
    const panStatuses = ["VALID", "INVALID", "DEACTIVATED", "FAKE"] as const;

    for (const faceMatchScore of scores) {
      for (const status of panStatuses) {
        for (const livenessPassed of [true, false]) {
          for (const duplicatePan of [true, false]) {
            const decision = decideKyc(
              fullKyc({
                selfie: { livenessPassed, faceMatchScore },
                pan: { status, nameMatch: true, dobMatch: true, linkedToAadhaar: true },
                duplicatePan,
              }),
              DEFAULT_KYC_THRESHOLDS,
            );
            expect(["VERIFIED", "MANUAL_REVIEW", "REJECTED"]).toContain(decision.status);
          }
        }
      }
    }
  });

  test("a REJECTED decision always carries at least one hard-fail reason", () => {
    const scores = [0, 0.5, 1];
    const panStatuses = ["VALID", "INVALID", "DEACTIVATED", "FAKE"] as const;

    for (const faceMatchScore of scores) {
      for (const status of panStatuses) {
        const decision = decideKyc(
          fullKyc({
            selfie: { livenessPassed: true, faceMatchScore },
            pan: { status, nameMatch: true, dobMatch: true, linkedToAadhaar: true },
          }),
          DEFAULT_KYC_THRESHOLDS,
        );
        if (decision.status === "REJECTED") {
          expect(decision.reasons.some((r) => r.severity === "HARD_FAIL")).toBe(true);
        }
      }
    }
  });

  test("a VERIFIED decision never carries a blocking reason", () => {
    const decision = decideKyc(
      fullKyc({
        pan: {
          status: "VALID",
          nameMatch: true,
          dobMatch: true,
          linkedToAadhaar: false,
        },
        lowConfidenceFieldCount: 1,
      }),
      DEFAULT_KYC_THRESHOLDS,
    );
    expect(decision.status).toBe("VERIFIED");
    expect(decision.reasons.every((r) => r.severity === "FLAG")).toBe(true);
  });
});
