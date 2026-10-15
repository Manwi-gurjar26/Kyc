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
import { applyReviewDecision } from "./reviewRepository.js";

/**
 * A human decision on a case the machine would not settle.
 *
 * Unlike applyKycDecision, this does not re-run decideKyc(). A reviewer has
 * looked at two photographs and a scanned deed and formed a judgement; the
 * job here is to record that judgement, who made it, and why, in one
 * transaction.
 */

const NOW = new Date("2026-10-09T14:00:00.000Z");

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

async function seedCase(
  status = "MANUAL_REVIEW",
): Promise<{ subjectId: string; recordId: string }> {
  const subjectId = await createTestUser(
    owner,
    `+9198140${Math.floor(Math.random() * 90000 + 10000)}`,
    "Ramesh Kumar Sharma",
  );

  /**
   * The jsonb column gets an explicit ::jsonb cast over a stringified value,
   * for the same reason timestamps get ::timestamptz: on a prepared statement
   * Postgres declares the parameter's type and postgres-js then writes the
   * value through its string writer, which an Array is not. Casting lets the
   * driver settle the type itself.
   */
  const reasons = JSON.stringify([
    {
      code: "FACE_MATCH_LOW",
      detail: "Face match scored 0.68; the pass mark is 0.75.",
      severity: "REVIEW",
    },
  ]);

  const rows = await owner.sql<{ id: string }[]>`
    INSERT INTO kyc_records (
      subject_type, user_id, level, status, vendor, vendor_session_id,
      face_match_score, decision_reasons
    ) VALUES (
      'PERSON', ${subjectId}, 'FULL', ${status}, 'fake',
      ${"sess_" + Math.random().toString(36).slice(2, 12)},
      0.68,
      ${reasons}::jsonb
    ) RETURNING id
  `;

  return { subjectId, recordId: rows[0]!.id };
}

async function reviewer(name = "R Iyer"): Promise<string> {
  return createTestUser(
    owner,
    `+9198150${Math.floor(Math.random() * 90000 + 10000)}`,
    name,
  );
}

/* ------------------------------------------------------------------ */

describe("approving a case", () => {
  test("moves it to VERIFIED and records who decided", async () => {
    const { recordId } = await seedCase();
    const staffId = await reviewer();

    const status = await withContext(app.db, { role: "staff" }, (tx) =>
      applyReviewDecision(tx, {
        kycRecordId: recordId,
        action: "APPROVE",
        reasonCode: "FACE_MATCH_ACCEPTED_ON_REVIEW",
        note: "Aadhaar photo is from 2013. Same person, clearly.",
        reviewerUserId: staffId,
        now: NOW,
      }),
    );

    expect(status).toBe("VERIFIED");

    const rows = await owner.sql<
      {
        status: string;
        reviewed_by: string;
        review_reason_code: string;
        verified_at: string | null;
      }[]
    >`SELECT status, reviewed_by, review_reason_code, verified_at
      FROM kyc_records WHERE id = ${recordId}`;

    expect(rows[0]!.status).toBe("VERIFIED");
    expect(rows[0]!.reviewed_by).toBe(staffId);
    expect(rows[0]!.review_reason_code).toBe("FACE_MATCH_ACCEPTED_ON_REVIEW");
    expect(rows[0]!.verified_at).not.toBeNull();
  });

  test("writes an audit row naming the reviewer and the reason", async () => {
    const { recordId } = await seedCase();
    const staffId = await reviewer();

    await withContext(app.db, { role: "staff" }, (tx) =>
      applyReviewDecision(tx, {
        kycRecordId: recordId,
        action: "APPROVE",
        reasonCode: "FACE_MATCH_ACCEPTED_ON_REVIEW",
        note: "Same person.",
        reviewerUserId: staffId,
        now: NOW,
      }),
    );

    const rows = await owner.sql<
      {
        action: string;
        actor_type: string;
        actor_user_id: string;
        reason_code: string;
        note: string;
        changes: { from: string; to: string };
      }[]
    >`SELECT action, actor_type, actor_user_id, reason_code, note, changes FROM audit_log`;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("kyc.reviewed");
    expect(rows[0]!.actor_type).toBe("STAFF");
    expect(rows[0]!.actor_user_id).toBe(staffId);
    expect(rows[0]!.reason_code).toBe("FACE_MATCH_ACCEPTED_ON_REVIEW");
    expect(rows[0]!.note).toBe("Same person.");
    expect(rows[0]!.changes.from).toBe("MANUAL_REVIEW");
    expect(rows[0]!.changes.to).toBe("VERIFIED");
  });

  test("emits an outbox event so the customer is told", async () => {
    const { recordId } = await seedCase();
    const staffId = await reviewer();

    await withContext(app.db, { role: "staff" }, (tx) =>
      applyReviewDecision(tx, {
        kycRecordId: recordId,
        action: "APPROVE",
        reasonCode: "OK",
        reviewerUserId: staffId,
        now: NOW,
      }),
    );

    const rows = await owner.sql<
      { event_type: string; aggregate_id: string }[]
    >`SELECT event_type, aggregate_id FROM outbox_events`;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.event_type).toBe("kyc.verified");
    expect(rows[0]!.aggregate_id).toBe(recordId);
  });
});

/* ------------------------------------------------------------------ */

describe("rejecting a case", () => {
  test("moves it to REJECTED and leaves verified_at null", async () => {
    const { recordId } = await seedCase();
    const staffId = await reviewer();

    const status = await withContext(app.db, { role: "staff" }, (tx) =>
      applyReviewDecision(tx, {
        kycRecordId: recordId,
        action: "REJECT",
        reasonCode: "DOCUMENT_NOT_GENUINE",
        reviewerUserId: staffId,
        now: NOW,
      }),
    );

    expect(status).toBe("REJECTED");

    const rows = await owner.sql<{ verified_at: string | null }[]>`
      SELECT verified_at FROM kyc_records WHERE id = ${recordId}
    `;
    expect(rows[0]!.verified_at).toBeNull();
  });

  test("emits a rejection event", async () => {
    const { recordId } = await seedCase();
    const staffId = await reviewer();

    await withContext(app.db, { role: "staff" }, (tx) =>
      applyReviewDecision(tx, {
        kycRecordId: recordId,
        action: "REJECT",
        reasonCode: "DOCUMENT_NOT_GENUINE",
        reviewerUserId: staffId,
        now: NOW,
      }),
    );

    const rows = await owner.sql<{ event_type: string }[]>`
      SELECT event_type FROM outbox_events
    `;
    expect(rows[0]!.event_type).toBe("kyc.rejected");
  });
});

/* ------------------------------------------------------------------ */

describe("asking for a re-upload", () => {
  /**
   * The reviewer's third option. A blurry deed is not grounds to reject
   * someone, and approving something unreadable is worse.
   */
  test("sends the case back to IN_PROGRESS", async () => {
    const { recordId } = await seedCase();
    const staffId = await reviewer();

    const status = await withContext(app.db, { role: "staff" }, (tx) =>
      applyReviewDecision(tx, {
        kycRecordId: recordId,
        action: "REQUEST_RESUBMISSION",
        reasonCode: "SELFIE_TOO_DARK",
        note: "Please retake in daylight.",
        reviewerUserId: staffId,
        now: NOW,
      }),
    );

    expect(status).toBe("IN_PROGRESS");
  });

  test("emits an event carrying the reason, so the message can say why", async () => {
    const { recordId } = await seedCase();
    const staffId = await reviewer();

    await withContext(app.db, { role: "staff" }, (tx) =>
      applyReviewDecision(tx, {
        kycRecordId: recordId,
        action: "REQUEST_RESUBMISSION",
        reasonCode: "SELFIE_TOO_DARK",
        reviewerUserId: staffId,
        now: NOW,
      }),
    );

    const rows = await owner.sql<
      { event_type: string; payload: { reasonCode: string } }[]
    >`SELECT event_type, payload FROM outbox_events`;

    expect(rows[0]!.event_type).toBe("kyc.resubmission_requested");
    expect(rows[0]!.payload.reasonCode).toBe("SELFIE_TOO_DARK");
  });
});

/* ------------------------------------------------------------------ */

describe("what a reviewer may not do", () => {
  /**
   * Nobody approves their own verification.
   *
   * Staff are customers too — an engineer can lease out their own land, and
   * somebody with the compliance permission could be the subject of a case.
   * This is the cheapest possible control against the most obvious abuse, and
   * it belongs in the transaction rather than in a UI that hides a button.
   */
  test("a reviewer cannot decide their own case", async () => {
    const { subjectId, recordId } = await seedCase();

    await expect(
      withContext(app.db, { role: "staff" }, (tx) =>
        applyReviewDecision(tx, {
          kycRecordId: recordId,
          action: "APPROVE",
          reasonCode: "LOOKS_FINE_TO_ME",
          reviewerUserId: subjectId,
          now: NOW,
        }),
      ),
    ).rejects.toThrow(/own/i);
  });

  test("a self-review attempt writes nothing", async () => {
    const { subjectId, recordId } = await seedCase();

    await withContext(app.db, { role: "staff" }, (tx) =>
      applyReviewDecision(tx, {
        kycRecordId: recordId,
        action: "APPROVE",
        reasonCode: "LOOKS_FINE_TO_ME",
        reviewerUserId: subjectId,
        now: NOW,
      }),
    ).catch(() => undefined);

    expect(await countOf(owner, "audit_log")).toBe(0);
    expect(await countOf(owner, "outbox_events")).toBe(0);

    const rows = await owner.sql<{ status: string }[]>`
      SELECT status FROM kyc_records WHERE id = ${recordId}
    `;
    expect(rows[0]!.status).toBe("MANUAL_REVIEW");
  });

  /** A reason code is what makes the audit log worth keeping. */
  test("a blank reason code is refused", async () => {
    const { recordId } = await seedCase();
    const staffId = await reviewer();

    await expect(
      withContext(app.db, { role: "staff" }, (tx) =>
        applyReviewDecision(tx, {
          kycRecordId: recordId,
          action: "APPROVE",
          reasonCode: "   ",
          reviewerUserId: staffId,
          now: NOW,
        }),
      ),
    ).rejects.toThrow(/reason code/i);
  });

  /**
   * The state machine does the work. A case that is already settled cannot be
   * reopened by a second reviewer clicking approve on a stale queue.
   */
  test("a case that is already VERIFIED cannot be reviewed again", async () => {
    const { recordId } = await seedCase("VERIFIED");
    const staffId = await reviewer();

    await expect(
      withContext(app.db, { role: "staff" }, (tx) =>
        applyReviewDecision(tx, {
          kycRecordId: recordId,
          action: "APPROVE",
          reasonCode: "AGAIN",
          reviewerUserId: staffId,
          now: NOW,
        }),
      ),
    ).rejects.toThrow(/Illegal KYC transition/);
  });

  test("a REJECTED case cannot be approved into VERIFIED", async () => {
    const { recordId } = await seedCase("REJECTED");
    const staffId = await reviewer();

    await expect(
      withContext(app.db, { role: "staff" }, (tx) =>
        applyReviewDecision(tx, {
          kycRecordId: recordId,
          action: "APPROVE",
          reasonCode: "CHANGED_MY_MIND",
          reviewerUserId: staffId,
          now: NOW,
        }),
      ),
    ).rejects.toThrow(/Illegal KYC transition/);
  });

  test("an unknown case is refused", async () => {
    const staffId = await reviewer();

    await expect(
      withContext(app.db, { role: "staff" }, (tx) =>
        applyReviewDecision(tx, {
          kycRecordId: "00000000-0000-0000-0000-000000000000",
          action: "APPROVE",
          reasonCode: "OK",
          reviewerUserId: staffId,
          now: NOW,
        }),
      ),
    ).rejects.toThrow(/not found/i);
  });

  /**
   * A customer context must not be able to run this at all, even reaching the
   * function directly. RLS is the net under the API's permission guard.
   */
  test("a customer context cannot decide a case", async () => {
    const { subjectId, recordId } = await seedCase();
    const staffId = await reviewer();

    await expect(
      withContext(app.db, { role: "customer", userId: subjectId }, (tx) =>
        applyReviewDecision(tx, {
          kycRecordId: recordId,
          action: "APPROVE",
          reasonCode: "OK",
          reviewerUserId: staffId,
          now: NOW,
        }),
      ),
    ).rejects.toThrow();

    const rows = await owner.sql<{ status: string }[]>`
      SELECT status FROM kyc_records WHERE id = ${recordId}
    `;
    expect(rows[0]!.status).toBe("MANUAL_REVIEW");
  });
});
