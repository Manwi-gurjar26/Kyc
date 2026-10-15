import { describe, expect, test } from "vitest";
import { KYC_ACTIONS, can, canReviewCase, type SubjectKycState } from "./guards.js";

function verified(overrides: Partial<SubjectKycState> = {}): SubjectKycState {
  return {
    personalKycStatus: "VERIFIED",
    phoneVerified: true,
    panCheckPassed: true,
    panAlreadyUsed: false,
    kybStatus: "VERIFIED",
    signatoryKycStatus: "VERIFIED",
    signatoryAuthorityApproved: true,
    landDocumentsApproved: true,
    ...overrides,
  };
}

describe("can — starting a free trial", () => {
  test("allowed on a verified phone with a passed PAN check", () => {
    const state: SubjectKycState = {
      personalKycStatus: "NOT_STARTED",
      phoneVerified: true,
      panCheckPassed: true,
      panAlreadyUsed: false,
    };
    expect(can("START_TRIAL", state).allowed).toBe(true);
  });

  test("a trial does not require full KYC", () => {
    const state: SubjectKycState = {
      personalKycStatus: "NOT_STARTED",
      phoneVerified: true,
      panCheckPassed: true,
      panAlreadyUsed: false,
    };
    expect(can("INVEST", state).allowed).toBe(false);
    expect(can("START_TRIAL", state).allowed).toBe(true);
  });

  test("denied when the phone is not verified", () => {
    const result = can(
      "START_TRIAL",
      verified({ personalKycStatus: "NOT_STARTED", phoneVerified: false }),
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("PHONE_VERIFICATION_REQUIRED");
  });

  test("denied when the PAN check has not passed", () => {
    const result = can(
      "START_TRIAL",
      verified({ personalKycStatus: "NOT_STARTED", panCheckPassed: false }),
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("KYC_REQUIRED");
  });

  test("denied when the PAN already took a trial", () => {
    const result = can(
      "START_TRIAL",
      verified({ personalKycStatus: "NOT_STARTED", panAlreadyUsed: true }),
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("PAN_ALREADY_USED");
  });
});

describe("can — investing", () => {
  test("allowed once personal KYC is verified", () => {
    expect(can("INVEST", verified()).allowed).toBe(true);
  });

  test("denied while KYC has not started", () => {
    const result = can("INVEST", verified({ personalKycStatus: "NOT_STARTED" }));
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("KYC_REQUIRED");
  });

  /**
   * A case under review reports a different code from one never started, so
   * the app can say "we are looking at it" instead of asking again.
   */
  test("denied with a distinct code while under review", () => {
    const result = can("INVEST", verified({ personalKycStatus: "MANUAL_REVIEW" }));
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("KYC_IN_REVIEW");
  });

  test("denied when rejected", () => {
    const result = can("INVEST", verified({ personalKycStatus: "REJECTED" }));
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("KYC_REJECTED");
  });

  test("denied when blocked for fraud", () => {
    const result = can("INVEST", verified({ personalKycStatus: "BLOCKED" }));
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("ACCOUNT_BLOCKED");
  });
});

describe("can — signing a PPA", () => {
  test("allowed when the business and the signatory are both verified", () => {
    expect(can("ESIGN_PPA", verified()).allowed).toBe(true);
  });

  test("denied when the business is not verified", () => {
    const result = can("ESIGN_PPA", verified({ kybStatus: "MANUAL_REVIEW" }));
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("KYB_REQUIRED");
  });

  test("denied when the signatory is not verified, even if the business is", () => {
    const result = can("ESIGN_PPA", verified({ signatoryKycStatus: "NOT_STARTED" }));
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("SIGNATORY_KYC_REQUIRED");
  });

  /**
   * Being verified is not the same as being allowed to bind the company.
   *
   * A finance clerk can complete their own KYC perfectly and still have no
   * authority to commit their employer to a 25-year agreement. That authority
   * comes from a board resolution Legal reads by hand, recorded as
   * `authority_approved_at` — a column that existed, was displayed in the KYB
   * view, and was enforced by nothing.
   */
  test("denied when nobody has approved the signatory's authority", () => {
    const result = can(
      "ESIGN_PPA",
      verified({ signatoryAuthorityApproved: false }),
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("SIGNATORY_AUTHORITY_REQUIRED");
  });

  /**
   * Absent is not approved. An undefined flag has to deny, because the
   * caller that forgot to read the column is exactly the caller that would
   * otherwise let an unauthorised person sign.
   */
  test("an unknown authority denies rather than defaulting to allowed", () => {
    const result = can(
      "ESIGN_PPA",
      verified({ signatoryAuthorityApproved: undefined }),
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("SIGNATORY_AUTHORITY_REQUIRED");
  });

  /** The business comes first: an unverified company is the bigger problem. */
  test("KYB is reported before the authority question", () => {
    const result = can(
      "ESIGN_PPA",
      verified({ kybStatus: "MANUAL_REVIEW", signatoryAuthorityApproved: false }),
    );
    expect(result.code).toBe("KYB_REQUIRED");
  });

  /** And the signatory's own KYC before their authority. */
  test("signatory KYC is reported before the authority question", () => {
    const result = can(
      "ESIGN_PPA",
      verified({
        signatoryKycStatus: "NOT_STARTED",
        signatoryAuthorityApproved: false,
      }),
    );
    expect(result.code).toBe("SIGNATORY_KYC_REQUIRED");
  });
});

describe("can — signing a lease", () => {
  test("allowed when KYC is verified and the land papers are approved", () => {
    expect(can("ESIGN_LEASE", verified()).allowed).toBe(true);
  });

  test("denied while the land documents are unapproved", () => {
    const result = can("ESIGN_LEASE", verified({ landDocumentsApproved: false }));
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("LAND_DOCUMENTS_REQUIRED");
  });

  test("personal KYC is still required on top of the documents", () => {
    const result = can(
      "ESIGN_LEASE",
      verified({ personalKycStatus: "NOT_STARTED", landDocumentsApproved: true }),
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("KYC_REQUIRED");
  });
});

describe("can — listing on the marketplace", () => {
  test("allowed on verified personal KYC", () => {
    expect(can("LIST_ON_MARKETPLACE", verified()).allowed).toBe(true);
  });

  test("denied while personal KYC is anything else", () => {
    for (const status of ["NOT_STARTED", "IN_PROGRESS", "MANUAL_REVIEW", "REJECTED"] as const) {
      expect(
        can("LIST_ON_MARKETPLACE", verified({ personalKycStatus: status })).allowed,
      ).toBe(false);
    }
  });
});

describe("can — the matrix as a whole", () => {
  /**
   * The table-driven check the stack doc asks for: every action is denied for
   * a subject who has done nothing. A new action added without a guard would
   * default to allowed, and this test is what catches that.
   */
  test("every action is denied for a subject with no verification at all", () => {
    const nothing: SubjectKycState = {
      personalKycStatus: "NOT_STARTED",
      phoneVerified: false,
      panCheckPassed: false,
      panAlreadyUsed: false,
    };
    for (const action of KYC_ACTIONS) {
      expect(can(action, nothing).allowed, `${action} should be denied`).toBe(false);
    }
  });

  test("every denial carries a code the API can return", () => {
    const nothing: SubjectKycState = {
      personalKycStatus: "NOT_STARTED",
      phoneVerified: false,
      panCheckPassed: false,
      panAlreadyUsed: false,
    };
    for (const action of KYC_ACTIONS) {
      const result = can(action, nothing);
      expect(result.code, `${action} should carry a denial code`).toBeTruthy();
    }
  });

  test("a blocked subject can do nothing at all", () => {
    const blocked = verified({ personalKycStatus: "BLOCKED" });
    for (const action of KYC_ACTIONS) {
      expect(can(action, blocked).allowed, `${action} should be denied`).toBe(false);
    }
  });
});

/**
 * Who may review what. The stack doc has no KYC reviewer role, so this is the
 * guide's suggestion: personal KYC to compliance, business and land to Legal.
 */
describe("canReviewCase", () => {
  test("compliance reviews personal KYC", () => {
    expect(canReviewCase(["compliance"], "PERSONAL")).toBe(true);
  });

  test("support can review personal KYC", () => {
    expect(canReviewCase(["support"], "PERSONAL")).toBe(true);
  });

  test("legal reviews a business check", () => {
    expect(canReviewCase(["legal"], "KYB")).toBe(true);
  });

  test("legal reviews land documents", () => {
    expect(canReviewCase(["legal"], "LAND_DOCUMENTS")).toBe(true);
  });

  test("support cannot approve a business check", () => {
    expect(canReviewCase(["support"], "KYB")).toBe(false);
  });

  test("compliance cannot approve land documents", () => {
    expect(canReviewCase(["compliance"], "LAND_DOCUMENTS")).toBe(false);
  });

  test("a super admin can review anything", () => {
    expect(canReviewCase(["super_admin"], "PERSONAL")).toBe(true);
    expect(canReviewCase(["super_admin"], "KYB")).toBe(true);
    expect(canReviewCase(["super_admin"], "LAND_DOCUMENTS")).toBe(true);
  });

  test("an engineer cannot review anything", () => {
    expect(canReviewCase(["engineer"], "PERSONAL")).toBe(false);
    expect(canReviewCase(["engineer"], "KYB")).toBe(false);
  });

  test("no roles at all reviews nothing", () => {
    expect(canReviewCase([], "PERSONAL")).toBe(false);
  });
});
