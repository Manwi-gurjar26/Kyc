import {
  DEFAULT_KYC_THRESHOLDS,
  decideKyc,
  panBlindIndex,
  type KycDecision,
} from "@kilowattx/core";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { withContext, type DatabaseHandle } from "../client.js";
import {
  assertRlsIsEnforceable,
  countOf,
  createTestUser,
  openOwnerDatabase,
  openTestDatabase,
  resetTables,
} from "../testing/harness.js";
import { applyKycDecision } from "./kycRepository.js";

/**
 * The single-transaction write.
 *
 * A KYC decision touches five tables. Either all five land or none do. A
 * partial write here is the worst failure mode in the module: a status with no
 * audit row is an unexplainable decision, and a status with no outbox event is
 * a customer who is verified and never told.
 */

const KEY = Buffer.alloc(32, 7);
const NOW = new Date("2026-10-09T09:00:00.000Z");

let app: DatabaseHandle;
let owner: DatabaseHandle;

beforeAll(async () => {
  app = openTestDatabase();
  owner = openOwnerDatabase();
  await assertRlsIsEnforceable(owner);
});

afterAll(async () => {
  await app.close();
  await owner.close();
});

beforeEach(async () => {
  await resetTables(owner);
});

/* ------------------------------------------------------------------ */

async function seedRecord(phone: string): Promise<{ userId: string; recordId: string }> {
  const userId = await createTestUser(owner, phone, "Ramesh Kumar Sharma");
  const rows = await owner.sql<{ id: string }[]>`
    INSERT INTO kyc_records (subject_type, user_id, level, status, vendor, vendor_session_id)
    VALUES ('PERSON', ${userId}, 'FULL', 'IN_PROGRESS', 'fake', ${"sess_" + phone})
    RETURNING id
  `;
  return { userId, recordId: rows[0]!.id };
}

function verifiedDecision(): KycDecision {
  return decideKyc(
    {
      level: "FULL",
      now: NOW,
      aadhaar: {
        status: "SUCCESS",
        nameOnRecord: "Ramesh Kumar Sharma",
        dateOfBirth: "1979-03-14",
      },
      pan: { status: "VALID", nameMatch: true, dobMatch: true, linkedToAadhaar: true },
      selfie: { livenessPassed: true, faceMatchScore: 0.91 },
      duplicatePan: false,
    },
    DEFAULT_KYC_THRESHOLDS,
  );
}

function reviewDecision(): KycDecision {
  return decideKyc(
    {
      level: "FULL",
      now: NOW,
      aadhaar: {
        status: "SUCCESS",
        nameOnRecord: "Ramesh Kumar Sharma",
        dateOfBirth: "1979-03-14",
      },
      pan: { status: "VALID", nameMatch: true, dobMatch: true, linkedToAadhaar: true },
      selfie: { livenessPassed: true, faceMatchScore: 0.68 },
      duplicatePan: false,
    },
    DEFAULT_KYC_THRESHOLDS,
  );
}

function applyInput(recordId: string, decision: KycDecision, pan = "ABCPS4412K") {
  return {
    kycRecordId: recordId,
    decision,
    thresholds: DEFAULT_KYC_THRESHOLDS,
    now: NOW,
    vendor: "fake",
    vendorVersion: "fake-1.0.0",
    aadhaarLast4: "7731",
    aadhaarRefToken: "fake_ref_abc123",
    panEncrypted: "enc:v1:ciphertext-placeholder",
    panBlindIndex: panBlindIndex(pan, KEY),
    panLast4: pan.slice(-4),
    livenessPassed: true,
    faceMatchScore: 0.91,
    checks: [
      { checkType: "AADHAAR" as const, status: "PASSED" as const },
      { checkType: "PAN" as const, status: "PASSED" as const },
      { checkType: "LIVENESS" as const, status: "PASSED" as const },
      {
        checkType: "FACE_MATCH" as const,
        status: "PASSED" as const,
        score: 0.91,
      },
    ],
    actorType: "SYSTEM" as const,
    traceId: "trace_01HQZX",
  };
}

/* ------------------------------------------------------------------ */

describe("applyKycDecision writes every table together", () => {
  test("a verified decision updates the record", async () => {
    const { recordId } = await seedRecord("+919811000001");

    const status = await withContext(app.db, { role: "system" }, (tx) =>
      applyKycDecision(tx, applyInput(recordId, verifiedDecision())),
    );
    expect(status).toBe("VERIFIED");

    const rows = await owner.sql<
      { status: string; verified_at: string | null; aadhaar_last4: string }[]
    >`SELECT status, verified_at, aadhaar_last4 FROM kyc_records WHERE id = ${recordId}`;
    expect(rows[0]!.status).toBe("VERIFIED");
    expect(rows[0]!.verified_at).not.toBeNull();
    expect(rows[0]!.aadhaar_last4).toBe("7731");
  });

  test("it writes one kyc_check row per check performed", async () => {
    const { recordId } = await seedRecord("+919811000002");

    await withContext(app.db, { role: "system" }, (tx) =>
      applyKycDecision(tx, applyInput(recordId, verifiedDecision())),
    );
    expect(await countOf(owner, "kyc_checks")).toBe(4);
  });

  test("it emits exactly one outbox event", async () => {
    const { recordId } = await seedRecord("+919811000003");

    await withContext(app.db, { role: "system" }, (tx) =>
      applyKycDecision(tx, applyInput(recordId, verifiedDecision())),
    );

    const rows = await owner.sql<{ event_type: string; aggregate_id: string }[]>`
      SELECT event_type, aggregate_id FROM outbox_events
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event_type).toBe("kyc.verified");
    expect(rows[0]!.aggregate_id).toBe(recordId);
  });

  test("a review decision emits a different event, so the queue is notified", async () => {
    const { recordId } = await seedRecord("+919811000004");

    await withContext(app.db, { role: "system" }, (tx) =>
      applyKycDecision(tx, applyInput(recordId, reviewDecision())),
    );

    const rows = await owner.sql<{ event_type: string }[]>`
      SELECT event_type FROM outbox_events
    `;
    expect(rows[0]!.event_type).toBe("kyc.review_required");
  });

  test("it writes one audit row naming the action and the actor", async () => {
    const { recordId } = await seedRecord("+919811000005");

    await withContext(app.db, { role: "system" }, (tx) =>
      applyKycDecision(tx, applyInput(recordId, verifiedDecision())),
    );

    const rows = await owner.sql<
      { action: string; actor_type: string; resource_id: string; trace_id: string }[]
    >`SELECT action, actor_type, resource_id, trace_id FROM audit_log`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("kyc.decided");
    expect(rows[0]!.actor_type).toBe("SYSTEM");
    expect(rows[0]!.resource_id).toBe(recordId);
    expect(rows[0]!.trace_id).toBe("trace_01HQZX");
  });

  /**
   * decideKyc() is pure, so storing its inputs and the thresholds in force
   * means a decision can be re-derived exactly, months later, when a reviewer
   * or an auditor asks why it went the way it did.
   */
  test("it stores the reasons and the thresholds that produced the decision", async () => {
    const { recordId } = await seedRecord("+919811000006");

    await withContext(app.db, { role: "system" }, (tx) =>
      applyKycDecision(tx, applyInput(recordId, reviewDecision())),
    );

    const rows = await owner.sql<
      {
        decision_reasons: { code: string; severity: string }[];
        thresholds_used: Record<string, number>;
      }[]
    >`SELECT decision_reasons, thresholds_used FROM kyc_records WHERE id = ${recordId}`;

    expect(rows[0]!.decision_reasons.map((r) => r.code)).toContain("FACE_MATCH_LOW");
    expect(rows[0]!.thresholds_used.faceMatch).toBe(0.75);
  });

  test("verified_at stays null for a review decision", async () => {
    const { recordId } = await seedRecord("+919811000007");

    await withContext(app.db, { role: "system" }, (tx) =>
      applyKycDecision(tx, applyInput(recordId, reviewDecision())),
    );

    const rows = await owner.sql<{ verified_at: string | null }[]>`
      SELECT verified_at FROM kyc_records WHERE id = ${recordId}
    `;
    expect(rows[0]!.verified_at).toBeNull();
  });
});

/* ------------------------------------------------------------------ */

/**
 * The rollback tests. These are the reason the write is one transaction
 * rather than five statements.
 */
describe("applyKycDecision leaves nothing behind when it fails", () => {
  /**
   * A real constraint violation, mid-transaction, after the record update and
   * the check rows have already been issued. Everything must disappear.
   */
  test("a duplicate PAN rolls back all five tables", async () => {
    const first = await seedRecord("+919811000011");
    const second = await seedRecord("+919811000012");

    // The first subject legitimately claims the PAN.
    await withContext(app.db, { role: "system" }, (tx) =>
      applyKycDecision(tx, applyInput(first.recordId, verifiedDecision(), "ABCPS4412K")),
    );

    const outboxBefore = await countOf(owner, "outbox_events");
    const auditBefore = await countOf(owner, "audit_log");
    const checksBefore = await countOf(owner, "kyc_checks");

    // The second subject claims the same PAN. The unique index must stop it.
    await expect(
      withContext(app.db, { role: "system" }, (tx) =>
        applyKycDecision(
          tx,
          applyInput(second.recordId, verifiedDecision(), "ABCPS4412K"),
        ),
      ),
    ).rejects.toThrow(/pan_blind_index_unique/);

    // Nothing from the failed attempt survived.
    expect(await countOf(owner, "outbox_events")).toBe(outboxBefore);
    expect(await countOf(owner, "audit_log")).toBe(auditBefore);
    expect(await countOf(owner, "kyc_checks")).toBe(checksBefore);

    const rows = await owner.sql<{ status: string }[]>`
      SELECT status FROM kyc_records WHERE id = ${second.recordId}
    `;
    expect(rows[0]!.status).toBe("IN_PROGRESS");
  });

  /**
   * The state machine is consulted inside the transaction, so an illegal move
   * fails before anything is written rather than after.
   */
  test("an illegal transition is refused and writes nothing", async () => {
    const { recordId } = await seedRecord("+919811000013");

    await withContext(app.db, { role: "system" }, (tx) =>
      applyKycDecision(tx, applyInput(recordId, verifiedDecision())),
    );
    const outboxAfterFirst = await countOf(owner, "outbox_events");

    // VERIFIED -> VERIFIED is not a legal transition.
    await expect(
      withContext(app.db, { role: "system" }, (tx) =>
        applyKycDecision(tx, applyInput(recordId, verifiedDecision(), "AMJPN3301R")),
      ),
    ).rejects.toThrow(/Illegal KYC transition/);

    expect(await countOf(owner, "outbox_events")).toBe(outboxAfterFirst);
  });

  test("a decision for an unknown record is refused", async () => {
    await expect(
      withContext(app.db, { role: "system" }, (tx) =>
        applyKycDecision(
          tx,
          applyInput("00000000-0000-0000-0000-000000000000", verifiedDecision()),
        ),
      ),
    ).rejects.toThrow(/not found/i);

    expect(await countOf(owner, "audit_log")).toBe(0);
  });

  /**
   * A customer must have no write path to their own KYC status, even if they
   * somehow reached this function. RLS is the net under the API guard.
   */
  test("the same call under a customer context cannot change a status", async () => {
    const { userId, recordId } = await seedRecord("+919811000014");

    await expect(
      withContext(app.db, { role: "customer", userId }, (tx) =>
        applyKycDecision(tx, applyInput(recordId, verifiedDecision())),
      ),
    ).rejects.toThrow();

    const rows = await owner.sql<{ status: string }[]>`
      SELECT status FROM kyc_records WHERE id = ${recordId}
    `;
    expect(rows[0]!.status).toBe("IN_PROGRESS");
  });
});
