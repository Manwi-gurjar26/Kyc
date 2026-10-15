import { describe, expect, test } from "vitest";
import { DEFAULT_KYC_THRESHOLDS } from "./decideKyc.js";
import {
  decideLand,
  type LandDecisionInput,
  type LandDocumentState,
} from "./decideLand.js";

/**
 * Whether a plot of land is ours to put panels on.
 *
 * This is the question behind ESIGN_LEASE, and it is not the same question as
 * "is this person verified". A verified person can perfectly well hand us the
 * record for land they share with four siblings, or land their neighbour has
 * already registered with us. Knowing who somebody is says nothing about what
 * they own.
 *
 * Pure, like decideKyc: no database, no clock beyond what is passed in. The
 * rules are the part that has to be arguable in a room with the legal team,
 * and that is much easier when they are twenty lines rather than a query.
 */

const RECORD_OF_RIGHTS: LandDocumentState = {
  docType: "JAMABANDI",
  scanStatus: "CLEAN",
  lowConfidenceFieldCount: 0,
  approved: true,
};

function input(overrides: Partial<LandDecisionInput> = {}): LandDecisionInput {
  return {
    ownerNameOnRecord: "RAMESH KUMAR SHARMA",
    verifiedName: "Ramesh Kumar Sharma",
    coOwnerNames: [],
    coOwnerConsentConfirmed: false,
    documents: [RECORD_OF_RIGHTS],
    duplicateKhasra: false,
    claimedFirst: false,
    thresholds: DEFAULT_KYC_THRESHOLDS,
    ...overrides,
  };
}

function codes(decision: { reasons: { code: string }[] }): string[] {
  return decision.reasons.map((r) => r.code);
}

/* ------------------------------------------------------------------ */

describe("the clean case", () => {
  test("an approved record of rights in the verified name passes", () => {
    const decision = decideLand(input());

    expect(decision.status).toBe("VERIFIED");
    expect(decision.reasons).toHaveLength(0);
  });

  test("the name match score is reported, not just applied", () => {
    const decision = decideLand(input());
    expect(decision.ownerNameMatchScore).toBeGreaterThan(0.9);
  });

  /** Case and spacing differ between a registry record and a KYC name. */
  test("a registry record in block capitals still matches", () => {
    const decision = decideLand(
      input({
        ownerNameOnRecord: "  RAMESH  KUMAR   SHARMA ",
        verifiedName: "ramesh kumar sharma",
      }),
    );
    expect(decision.status).toBe("VERIFIED");
  });
});

/* ------------------------------------------------------------------ */

describe("documents that cannot be relied on", () => {
  /**
   * The hardest line here. An infected document is not weak evidence, it is
   * no evidence — nobody has read it and nobody may. No reviewer waves this
   * through, which is what HARD_FAIL means.
   */
  test("an infected document is a hard fail", () => {
    const decision = decideLand(
      input({
        documents: [{ ...RECORD_OF_RIGHTS, scanStatus: "INFECTED" }],
      }),
    );

    expect(decision.status).toBe("REJECTED");
    expect(codes(decision)).toContain("LAND_DOCUMENT_INFECTED");
    expect(decision.reasons[0]!.severity).toBe("HARD_FAIL");
  });

  test("one infected document poisons the whole parcel", () => {
    const decision = decideLand(
      input({
        documents: [
          RECORD_OF_RIGHTS,
          { ...RECORD_OF_RIGHTS, docType: "SALE_DEED", scanStatus: "INFECTED" },
        ],
      }),
    );

    expect(decision.status).toBe("REJECTED");
  });

  test("an unscanned document is reviewed, not accepted", () => {
    const decision = decideLand(
      input({
        documents: [{ ...RECORD_OF_RIGHTS, scanStatus: "PENDING" }],
      }),
    );

    expect(decision.status).toBe("MANUAL_REVIEW");
    expect(codes(decision)).toContain("LAND_DOCUMENT_NOT_SCANNED");
  });

  test("a document the scanner could not reach is reviewed", () => {
    const decision = decideLand(
      input({
        documents: [{ ...RECORD_OF_RIGHTS, scanStatus: "ERRORED" }],
      }),
    );

    expect(decision.status).toBe("MANUAL_REVIEW");
    expect(codes(decision)).toContain("LAND_DOCUMENT_NOT_SCANNED");
  });

  test("an illegible document is reviewed", () => {
    const decision = decideLand(
      input({
        documents: [{ ...RECORD_OF_RIGHTS, lowConfidenceFieldCount: 3 }],
      }),
    );

    expect(decision.status).toBe("MANUAL_REVIEW");
    expect(codes(decision)).toContain("LAND_DOCUMENT_ILLEGIBLE");
  });

  /**
   * Legal's approval is the whole point of the queue. A parcel verified on
   * documents nobody signed off would make the review step decorative.
   */
  test("a document Legal has not yet approved is reviewed", () => {
    const decision = decideLand(
      input({ documents: [{ ...RECORD_OF_RIGHTS, approved: null }] }),
    );

    expect(decision.status).toBe("MANUAL_REVIEW");
    expect(codes(decision)).toContain("LAND_DOCUMENTS_AWAITING_LEGAL");
  });

  /** A document Legal rejected is a reason to stop, not to keep waiting. */
  test("a document Legal rejected is a hard fail", () => {
    const decision = decideLand(
      input({ documents: [{ ...RECORD_OF_RIGHTS, approved: false }] }),
    );

    expect(decision.status).toBe("REJECTED");
    expect(codes(decision)).toContain("LAND_DOCUMENT_REJECTED");
  });
});

/* ------------------------------------------------------------------ */

describe("which documents are required", () => {
  /**
   * A sale deed says the land changed hands. The record of rights says who
   * holds it now, which is the only thing a lease can rest on — a deed from
   * 2019 does not prove the 2026 position.
   */
  test("a sale deed alone is not enough", () => {
    const decision = decideLand(
      input({
        documents: [{ ...RECORD_OF_RIGHTS, docType: "SALE_DEED" }],
      }),
    );

    expect(decision.status).toBe("MANUAL_REVIEW");
    expect(codes(decision)).toContain("LAND_RECORD_OF_RIGHTS_MISSING");
  });

  test("a Khasra Khatauni counts as the record of rights", () => {
    const decision = decideLand(
      input({
        documents: [{ ...RECORD_OF_RIGHTS, docType: "KHASRA_KHATAUNI" }],
      }),
    );

    expect(decision.status).toBe("VERIFIED");
  });

  test("no documents at all is reviewed, never verified", () => {
    const decision = decideLand(input({ documents: [] }));

    expect(decision.status).toBe("MANUAL_REVIEW");
    expect(codes(decision)).toContain("LAND_RECORD_OF_RIGHTS_MISSING");
  });
});

/* ------------------------------------------------------------------ */

describe("the name on the record", () => {
  test("a different person on the record is reviewed", () => {
    const decision = decideLand(
      input({ ownerNameOnRecord: "ANITA DESAI" }),
    );

    expect(decision.status).toBe("MANUAL_REVIEW");
    expect(codes(decision)).toContain("LAND_OWNER_NAME_MISMATCH");
  });

  /**
   * The commonest real cause, and the reason this is a review rather than a
   * rejection: land records are often decades old and still carry a maiden
   * name, or a father's name in place of the holder's.
   */
  test("a reviewable mismatch reports the score it scored", () => {
    const decision = decideLand(input({ ownerNameOnRecord: "ANITA DESAI" }));

    expect(decision.ownerNameMatchScore).toBeLessThan(
      DEFAULT_KYC_THRESHOLDS.nameMatch,
    );
    expect(decision.status).not.toBe("REJECTED");
  });

  /**
   * `nameMatch` is a settings-table threshold, and this decision is now the
   * only one that reads it. Proving it is honoured here is what stops Ops
   * retuning a number that turns out to do nothing.
   *
   * A dropped middle name is the case to test it on, because it is both
   * common and genuinely borderline — "Ramesh Sharma" on a jamabandi for
   * Ramesh Kumar Sharma scores in the eighties, which passes at 0.75 and does
   * not at 0.90. A completely different name scores zero and so could never
   * demonstrate anything about where the bar sits.
   */
  test("raising the name bar turns that pass into a review", () => {
    const subject = input({ ownerNameOnRecord: "RAMESH SHARMA" });
    const strict = { ...DEFAULT_KYC_THRESHOLDS, nameMatch: 0.9 };

    expect(decideLand(subject).status).toBe("VERIFIED");

    const strictly = decideLand({ ...subject, thresholds: strict });
    expect(strictly.status).toBe("MANUAL_REVIEW");
    expect(codes(strictly)).toContain("LAND_OWNER_NAME_MISMATCH");
  });

  test("an empty name on the record is reviewed, not treated as matching", () => {
    const decision = decideLand(input({ ownerNameOnRecord: "" }));

    expect(decision.status).toBe("MANUAL_REVIEW");
    expect(codes(decision)).toContain("LAND_OWNER_NAME_MISMATCH");
  });
});

/* ------------------------------------------------------------------ */

describe("jointly held land", () => {
  /**
   * Extremely common, and the single most expensive thing to get wrong here.
   * Inherited agricultural land is routinely held by several siblings, and a
   * lease signed by one of them is a lease the others can have set aside —
   * after the panels are already on the ground.
   */
  test("co-owners on the record need their consent confirmed", () => {
    const decision = decideLand(
      input({ coOwnerNames: ["SUNITA SHARMA", "MOHAN LAL SHARMA"] }),
    );

    expect(decision.status).toBe("MANUAL_REVIEW");
    expect(codes(decision)).toContain("LAND_CO_OWNER_CONSENT_REQUIRED");
  });

  /**
   * It is not a refusal. Jointly held land is leasable; it just cannot be
   * leased on one signature, so Legal confirms the others have agreed.
   */
  test("co-owned land passes once consent is confirmed", () => {
    const decision = decideLand(
      input({
        coOwnerNames: ["SUNITA SHARMA"],
        coOwnerConsentConfirmed: true,
      }),
    );

    expect(decision.status).toBe("VERIFIED");
  });

  test("the decision says a lease needs every co-owner", () => {
    const joint = decideLand(input({ coOwnerNames: ["SUNITA SHARMA"] }));
    const sole = decideLand(input());

    expect(joint.requiresAllCoOwners).toBe(true);
    expect(sole.requiresAllCoOwners).toBe(false);
  });

  /**
   * Confirming consent cannot launder a document problem. These are separate
   * questions, and a reviewer answering one must not be taken to have
   * answered the other.
   */
  test("confirmed consent does not excuse an unapproved document", () => {
    const decision = decideLand(
      input({
        coOwnerNames: ["SUNITA SHARMA"],
        coOwnerConsentConfirmed: true,
        documents: [{ ...RECORD_OF_RIGHTS, approved: null }],
      }),
    );

    expect(decision.status).toBe("MANUAL_REVIEW");
    expect(codes(decision)).toContain("LAND_DOCUMENTS_AWAITING_LEGAL");
  });
});

/* ------------------------------------------------------------------ */

describe("the same plot claimed twice", () => {
  /**
   * The land equivalent of the duplicate-PAN check, and it catches a real
   * fraud: registering a neighbour's plot, or the same plot through two
   * accounts to collect two sets of rent.
   *
   * A review, not a rejection — deliberately. Two people claiming one plot
   * means at least one is wrong, and we do not know which. Rejecting the
   * second to arrive would reject the rightful owner whenever the fraudster
   * got there first.
   */
  test("a khasra claimed earlier by somebody else is reviewed", () => {
    const decision = decideLand(
      input({ duplicateKhasra: true, claimedFirst: false }),
    );

    expect(decision.status).toBe("MANUAL_REVIEW");
    expect(codes(decision)).toContain("LAND_KHASRA_ALREADY_CLAIMED");
  });

  test("a duplicate claim is never auto-rejected", () => {
    const decision = decideLand(
      input({ duplicateKhasra: true, claimedFirst: false }),
    );
    expect(decision.status).not.toBe("REJECTED");
  });

  /**
   * Whoever registered the plot first keeps it, and this is the important
   * half.
   *
   * Without it, anybody could take a verified owner's land out of service by
   * registering their khasra number — the real owner's lease would stop
   * working the next time anything re-decided their parcel. Blocking both
   * sides of a dispute turns a fraud check into a way to attack strangers.
   */
  test("whoever claimed it first is not blocked by a later claim", () => {
    const decision = decideLand(
      input({ duplicateKhasra: true, claimedFirst: true }),
    );

    expect(decision.status).toBe("VERIFIED");
  });

  /**
   * They are still told. The dispute is recorded as a FLAG — it blocks
   * nothing, and support is not blind when the second claimant telephones.
   */
  test("the earlier claim is flagged rather than silently ignored", () => {
    const decision = decideLand(
      input({ duplicateKhasra: true, claimedFirst: true }),
    );

    expect(codes(decision)).toContain("LAND_KHASRA_DISPUTED");
    expect(decision.reasons[0]!.severity).toBe("FLAG");
  });

  /** A flag does not rescue a parcel that has a real problem. */
  test("being first does not excuse an unapproved document", () => {
    const decision = decideLand(
      input({
        duplicateKhasra: true,
        claimedFirst: true,
        documents: [{ ...RECORD_OF_RIGHTS, approved: null }],
      }),
    );

    expect(decision.status).toBe("MANUAL_REVIEW");
  });
});

/* ------------------------------------------------------------------ */

describe("precedence", () => {
  /**
   * Same ordering as decideKyc: a hard fail outranks everything, and the
   * reasons are all collected rather than the function returning at the first
   * one. A reviewer needs the whole list — fixing one problem only to
   * discover the next is how a case bounces four times.
   */
  test("a hard fail outranks a review", () => {
    const decision = decideLand(
      input({
        duplicateKhasra: true,
        claimedFirst: false,
        coOwnerNames: ["SUNITA SHARMA"],
        documents: [{ ...RECORD_OF_RIGHTS, scanStatus: "INFECTED" }],
      }),
    );

    expect(decision.status).toBe("REJECTED");
  });

  test("every problem is reported, not just the first", () => {
    const decision = decideLand(
      input({
        ownerNameOnRecord: "ANITA DESAI",
        coOwnerNames: ["SUNITA SHARMA"],
        duplicateKhasra: true,
      }),
    );

    expect(codes(decision)).toEqual(
      expect.arrayContaining([
        "LAND_OWNER_NAME_MISMATCH",
        "LAND_CO_OWNER_CONSENT_REQUIRED",
        "LAND_KHASRA_ALREADY_CLAIMED",
      ]),
    );
  });

  /** Every reason carries something a person can read. */
  test("each reason has a detail of its own", () => {
    const decision = decideLand(
      input({ ownerNameOnRecord: "ANITA DESAI", duplicateKhasra: true }),
    );

    for (const reason of decision.reasons) {
      expect(reason.detail.length).toBeGreaterThan(10);
    }
  });
});
