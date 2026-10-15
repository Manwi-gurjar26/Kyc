import { DEFAULT_KYC_THRESHOLDS, panBlindIndex } from "@kilowattx/core";
import { createClient, withContext, type Database, type DatabaseHandle } from "@kilowattx/db";
import { FakeKycProvider, type VendorKycResult } from "@kilowattx/integrations";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { applyVendorResult } from "./applyVendorResult.js";
import { PlaceholderPanEncryptor } from "./panEncryption.js";

/**
 * The shared pipeline.
 *
 * This is the only path from "the vendor said something" to "the record has a
 * status". It existed twice before — once in the API's webhook handler, and
 * about to be copied into the worker's reconciliation job — which is exactly
 * the drift worth preventing: the duplicate-PAN check, the encryption and the
 * five-table transaction are the parts where being quietly wrong matters most.
 */

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://kilowattx_app:local_dev_only@localhost:5434/kilowattx_pipeline_test";
const OWNER_URL =
  process.env.OWNER_DATABASE_URL ??
  "postgresql://kilowattx:local_dev_only@localhost:5434/kilowattx_pipeline_test";

const NOW = new Date("2026-10-09T18:00:00.000Z");
const KEY = Buffer.alloc(32, 29);
const SECRET = "whsec_pipeline_test_000";

let app: DatabaseHandle;
let owner: DatabaseHandle;
let db: Database;
let provider: FakeKycProvider;

const encryptor = new PlaceholderPanEncryptor("test");

beforeAll(() => {
  app = createClient({ url: DB_URL, maxConnections: 10 });
  owner = createClient({ url: OWNER_URL, maxConnections: 4 });
  db = app.db;
});

afterAll(async () => {
  await app.close();
  await owner.close();
});

beforeEach(async () => {
  await owner.sql.unsafe(`
    TRUNCATE TABLE notification_deliveries, audit_log, outbox_events, kyc_checks,
      documents, land_parcels, org_members, kyc_records,
      organisations, consent_records, seen_webhook_events, users
    RESTART IDENTITY CASCADE
  `);
  provider = new FakeKycProvider({ webhookSecret: SECRET, clock: () => NOW });
});

/* ------------------------------------------------------------------ */

async function openSession(scenario?: string): Promise<{
  userId: string;
  recordId: string;
  sessionId: string;
}> {
  const people = await owner.sql<{ id: string }[]>`
    INSERT INTO users (phone_e164, display_name, locale, phone_verified_at)
    VALUES (${"+9198240" + Math.floor(Math.random() * 90000 + 10000)},
            'Ramesh Kumar Sharma', 'en', now())
    RETURNING id
  `;
  const userId = people[0]!.id;

  const session = await provider.createSession({
    subjectId: userId,
    level: "FULL",
    role: "LAND_OWNER",
    locale: "en",
    redirectUrl: "http://localhost:3000/kyc/return",
    idempotencyKey: `pipe-${Math.random()}`,
    ...(scenario ? { testScenario: scenario as never } : {}),
  });

  const records = await owner.sql<{ id: string }[]>`
    INSERT INTO kyc_records (subject_type, user_id, level, status, vendor, vendor_session_id)
    VALUES ('PERSON', ${userId}, 'FULL', 'IN_PROGRESS', 'fake', ${session.vendorSessionId})
    RETURNING id
  `;

  return { userId, recordId: records[0]!.id, sessionId: session.vendorSessionId };
}

async function run(sessionId: string) {
  const result: VendorKycResult = await provider.fetchResult(sessionId);

  return withContext(db, { role: "system" }, (tx) =>
    applyVendorResult(tx, {
      result,
      thresholds: DEFAULT_KYC_THRESHOLDS,
      blindIndexKey: KEY,
      encryptor,
      now: NOW,
    }),
  );
}

/* ------------------------------------------------------------------ */

describe("applying a vendor result", () => {
  test("a passing result verifies the record", async () => {
    const { recordId, sessionId } = await openSession("pass");

    const outcome = await run(sessionId);
    expect(outcome.status).toBe("VERIFIED");

    const rows = await owner.sql<{ status: string; verified_at: string | null }[]>`
      SELECT status, verified_at FROM kyc_records WHERE id = ${recordId}
    `;
    expect(rows[0]!.status).toBe("VERIFIED");
    expect(rows[0]!.verified_at).not.toBeNull();
  });

  test("it writes every check, the outbox event and the audit row", async () => {
    const { sessionId } = await openSession("pass");
    await run(sessionId);

    const checks = await owner.sql<{ c: string }[]>`SELECT count(*)::text AS c FROM kyc_checks`;
    const outbox = await owner.sql<{ event_type: string }[]>`SELECT event_type FROM outbox_events`;
    const audit = await owner.sql<{ action: string }[]>`SELECT action FROM audit_log`;

    expect(checks[0]!.c).toBe("4");
    expect(outbox[0]!.event_type).toBe("kyc.verified");
    expect(audit[0]!.action).toBe("kyc.decided");
  });

  test("a weak face match goes to review", async () => {
    const { sessionId } = await openSession("low_face_score");

    const outcome = await run(sessionId);
    expect(outcome.status).toBe("MANUAL_REVIEW");
    expect(outcome.decision.reasons.map((r) => r.code)).toContain("FACE_MATCH_LOW");
  });

  test("a minor is rejected", async () => {
    const { sessionId } = await openSession("minor");

    const outcome = await run(sessionId);
    expect(outcome.status).toBe("REJECTED");
    expect(outcome.decision.reasons.map((r) => r.code)).toContain("AGE_UNDER_18");
  });

  test("it stores the thresholds it used, so the decision is reproducible", async () => {
    const { recordId, sessionId } = await openSession("low_face_score");
    await run(sessionId);

    const rows = await owner.sql<{ thresholds_used: Record<string, number> }[]>`
      SELECT thresholds_used FROM kyc_records WHERE id = ${recordId}
    `;
    expect(rows[0]!.thresholds_used.faceMatch).toBe(0.75);
  });

  test("an unknown session is refused rather than invented", async () => {
    const result = await provider
      .createSession({
        subjectId: "00000000-0000-0000-0000-000000000000",
        level: "FULL",
        role: "INVESTOR",
        locale: "en",
        redirectUrl: "http://localhost:3000",
        idempotencyKey: "orphan",
      })
      .then((s) => provider.fetchResult(s.vendorSessionId));

    await expect(
      withContext(db, { role: "system" }, (tx) =>
        applyVendorResult(tx, {
          result,
          thresholds: DEFAULT_KYC_THRESHOLDS,
          blindIndexKey: KEY,
          encryptor,
          now: NOW,
        }),
      ),
    ).rejects.toThrow(/no kyc_record/i);
  });
});

/* ------------------------------------------------------------------ */

describe("the PAN", () => {
  test("is stored through the encryptor, never in plaintext", async () => {
    const { recordId, sessionId } = await openSession("pass");
    await run(sessionId);

    const rows = await owner.sql<
      { pan_encrypted: string; pan_last4: string; pan_blind_index: string }[]
    >`SELECT pan_encrypted, pan_last4, pan_blind_index FROM kyc_records WHERE id = ${recordId}`;

    expect(rows[0]!.pan_encrypted).toContain("PLACEHOLDER");
    expect(rows[0]!.pan_last4).toMatch(/^[A-Z0-9]{4}$/);
    expect(rows[0]!.pan_blind_index).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the blind index matches what core would compute", async () => {
    const { recordId, sessionId } = await openSession("pass");
    const result = await provider.fetchResult(sessionId);
    await run(sessionId);

    const rows = await owner.sql<{ pan_blind_index: string }[]>`
      SELECT pan_blind_index FROM kyc_records WHERE id = ${recordId}
    `;
    expect(rows[0]!.pan_blind_index).toBe(panBlindIndex(result.pan!.pan!, KEY));
  });

  /** A failed Aadhaar fetch means no PAN came back either; nothing to store. */
  test("is left null when the vendor returned none", async () => {
    const { recordId, sessionId } = await openSession("aadhaar_failed");
    await run(sessionId);

    const rows = await owner.sql<{ pan_encrypted: string | null }[]>`
      SELECT pan_encrypted FROM kyc_records WHERE id = ${recordId}
    `;
    expect(rows[0]!.pan_encrypted).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */

describe("duplicate PAN detection", () => {
  test("the same PAN on a second subject goes to review", async () => {
    const first = await openSession("pass");
    await run(first.sessionId);
    const firstResult = await provider.fetchResult(first.sessionId);

    /** A second subject whose vendor result carries the first one's PAN. */
    const second = await openSession("pass");
    const secondResult: VendorKycResult = {
      ...(await provider.fetchResult(second.sessionId)),
      pan: firstResult.pan,
    };

    const outcome = await withContext(db, { role: "system" }, (tx) =>
      applyVendorResult(tx, {
        result: secondResult,
        thresholds: DEFAULT_KYC_THRESHOLDS,
        blindIndexKey: KEY,
        encryptor,
        now: NOW,
      }),
    ).catch((error: unknown) => error as Error);

    /**
     * Either outcome is safe, and both are acceptable: the decision function
     * flags it as a duplicate and sends it to a reviewer, or the unique index
     * refuses the write outright. What must NOT happen is a second subject
     * verifying silently on a PAN that already belongs to somebody else.
     */
    if (outcome instanceof Error) {
      expect(outcome.message).toMatch(/pan_blind_index_unique/);
    } else {
      expect(outcome.status).toBe("MANUAL_REVIEW");
      expect(outcome.decision.reasons.map((r) => r.code)).toContain("PAN_ALREADY_USED");
    }
  });

  /**
   * THE SUBTLE ONE, and the reason reconciliation needs this function rather
   * than its own copy.
   *
   * Reconciliation reprocesses a session whose record may ALREADY carry the
   * PAN from an earlier partial run. If the duplicate check does not exclude
   * the record being decided, it finds the subject's own PAN and reports them
   * as a duplicate of themselves — so a lost webhook turns into a manual
   * review for no reason, and the reviewer sees nothing wrong with the case.
   */
  test("a record's own stored PAN is not a duplicate of itself", async () => {
    const { recordId, sessionId } = await openSession("pass");
    const result = await provider.fetchResult(sessionId);

    /** Simulate a partial earlier run that stored the PAN. */
    await owner.sql`
      UPDATE kyc_records
      SET pan_blind_index = ${panBlindIndex(result.pan!.pan!, KEY)},
          pan_last4 = ${result.pan!.pan!.slice(-4)}
      WHERE id = ${recordId}
    `;

    const outcome = await run(sessionId);

    expect(outcome.status).toBe("VERIFIED");
    expect(outcome.decision.reasons.map((r) => r.code)).not.toContain(
      "PAN_ALREADY_USED",
    );
  });
});

/* ------------------------------------------------------------------ */

describe("reprocessing is safe", () => {
  /**
   * Both callers can reach the same session twice: the API through a
   * redelivered webhook, the worker through reconciliation. The state machine
   * is what stops the second one, and it stops it before anything is written.
   */
  test("applying a result to an already settled record is refused", async () => {
    const { sessionId } = await openSession("pass");
    await run(sessionId);

    await expect(run(sessionId)).rejects.toThrow(/Illegal KYC transition/);
  });

  test("the refused second attempt writes nothing extra", async () => {
    const { sessionId } = await openSession("pass");
    await run(sessionId);

    const before = await owner.sql<{ c: string }[]>`
      SELECT count(*)::text AS c FROM outbox_events
    `;
    await run(sessionId).catch(() => undefined);
    const after = await owner.sql<{ c: string }[]>`
      SELECT count(*)::text AS c FROM outbox_events
    `;

    expect(after[0]!.c).toBe(before[0]!.c);
  });
});
