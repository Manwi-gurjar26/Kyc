import { createClient, type Database, type DatabaseHandle } from "@kilowattx/db";
import { DEFAULT_KYC_THRESHOLDS } from "@kilowattx/core";
import { FakeKycProvider } from "@kilowattx/integrations";
import { PlaceholderPanEncryptor } from "@kilowattx/kyc-pipeline";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { healerFactory } from "./healer.js";
import { reconcileStuckSessions } from "./reconciliation.js";

/**
 * Finding sessions the webhook never came back for.
 */

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://kilowattx_app:local_dev_only@localhost:5434/kilowattx_worker_test";
const OWNER_URL =
  process.env.OWNER_DATABASE_URL ??
  "postgresql://kilowattx:local_dev_only@localhost:5434/kilowattx_worker_test";

const NOW = new Date("2026-10-09T17:00:00.000Z");
const SECRET = "whsec_reconcile_test_00";

let app: DatabaseHandle;
let owner: DatabaseHandle;
let db: Database;
let provider: FakeKycProvider;

beforeAll(() => {
  app = createClient({ url: DB_URL, maxConnections: 8 });
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
  /** Otherwise a threshold override leaks into the next test. */
  await owner.sql.unsafe(`TRUNCATE TABLE settings`);
  provider = new FakeKycProvider({ webhookSecret: SECRET, clock: () => NOW });
});

/* ------------------------------------------------------------------ */

async function seedInProgress(params: {
  ageMinutes: number;
  /** When true, a real vendor session exists and has a result to fetch. */
  vendorKnowsIt: boolean;
}): Promise<string> {
  const people = await owner.sql<{ id: string }[]>`
    INSERT INTO users (phone_e164, display_name, phone_verified_at)
    VALUES (${"+9198210" + Math.floor(Math.random() * 90000 + 10000)}, 'Stuck Person', now())
    RETURNING id
  `;

  let sessionId = `fake_sess_never_opened_${Math.random().toString(36).slice(2, 10)}`;

  if (params.vendorKnowsIt) {
    const session = await provider.createSession({
      subjectId: people[0]!.id,
      level: "FULL",
      role: "LAND_OWNER",
      locale: "en",
      redirectUrl: "http://localhost:3000/kyc/return",
      idempotencyKey: `recon-${Math.random()}`,
    });
    sessionId = session.vendorSessionId;
  }

  const createdAt = new Date(NOW.getTime() - params.ageMinutes * 60_000);

  const records = await owner.sql<{ id: string }[]>`
    INSERT INTO kyc_records (subject_type, user_id, level, status, vendor, vendor_session_id, created_at)
    VALUES ('PERSON', ${people[0]!.id}, 'FULL', 'IN_PROGRESS', 'fake', ${sessionId},
            ${createdAt.toISOString()}::timestamptz)
    RETURNING id
  `;

  return records[0]!.id;
}

function run(overrides: { stuckAfterMinutes?: number; log?: (l: string) => void } = {}) {
  return reconcileStuckSessions({ db, provider, now: NOW, ...overrides });
}

/* ------------------------------------------------------------------ */

describe("which sessions get looked at", () => {
  test("a session stuck well past the threshold is checked", async () => {
    await seedInProgress({ ageMinutes: 120, vendorKnowsIt: true });

    const report = await run();
    expect(report.checked).toBe(1);
  });

  /** Somebody slowly working through DigiLocker is not a stuck session. */
  test("a session still inside the threshold is left alone", async () => {
    await seedInProgress({ ageMinutes: 5, vendorKnowsIt: true });

    const report = await run();
    expect(report.checked).toBe(0);
  });

  test("the threshold is configurable", async () => {
    await seedInProgress({ ageMinutes: 10, vendorKnowsIt: true });

    expect((await run({ stuckAfterMinutes: 30 })).checked).toBe(0);
    expect((await run({ stuckAfterMinutes: 5 })).checked).toBe(1);
  });

  test("a settled record is never checked, however old", async () => {
    const id = await seedInProgress({ ageMinutes: 600, vendorKnowsIt: true });
    await owner.sql`UPDATE kyc_records SET status = 'VERIFIED' WHERE id = ${id}`;

    const report = await run();
    expect(report.checked).toBe(0);
  });

  test("oldest first, so the longest wait is reported first", async () => {
    await seedInProgress({ ageMinutes: 60, vendorKnowsIt: true });
    await seedInProgress({ ageMinutes: 600, vendorKnowsIt: true });

    const report = await run();
    expect(report.checked).toBe(2);
    expect(report.resultWaiting[0]!.ageMinutes).toBeGreaterThan(
      report.resultWaiting[1]!.ageMinutes,
    );
  });
});

/* ------------------------------------------------------------------ */

describe("what the vendor says", () => {
  /**
   * The case this job exists for: the vendor finished and we never heard.
   * Either a webhook was lost, or one was refused by the signature check —
   * and the second is a security signal rather than a glitch.
   */
  test("a vendor with a result is reported as a missed result", async () => {
    await seedInProgress({ ageMinutes: 120, vendorKnowsIt: true });
    const lines: string[] = [];

    const report = await run({ log: (l) => lines.push(l) });

    expect(report.resultWaiting).toHaveLength(1);
    expect(report.resultWaiting[0]!.vendorHasResult).toBe(true);
    expect(lines.some((l) => l.includes("MISSED RESULT"))).toBe(true);
  });

  /** A person who opened the flow and wandered off. Not a problem. */
  test("a vendor with nothing is inconclusive, not an alarm", async () => {
    await seedInProgress({ ageMinutes: 120, vendorKnowsIt: false });
    const lines: string[] = [];

    const report = await run({ log: (l) => lines.push(l) });

    expect(report.inconclusive).toHaveLength(1);
    expect(report.inconclusive[0]!.vendorHasResult).toBe(false);
    expect(lines.some((l) => l.includes("MISSED RESULT"))).toBe(false);
  });

  test("the vendor's error is kept, so a real outage is distinguishable", async () => {
    await seedInProgress({ ageMinutes: 120, vendorKnowsIt: false });

    const report = await run();
    expect(report.inconclusive[0]!.vendorError).toMatch(/unknown session/i);
  });

  test("it reports both kinds in one pass", async () => {
    await seedInProgress({ ageMinutes: 120, vendorKnowsIt: true });
    await seedInProgress({ ageMinutes: 120, vendorKnowsIt: false });

    const report = await run();
    expect(report.checked).toBe(2);
    expect(report.resultWaiting).toHaveLength(1);
    expect(report.inconclusive).toHaveLength(1);
  });

  /** Detection alone leaves the record untouched. */
  test("without a healer it does not change the record's status", async () => {
    const id = await seedInProgress({ ageMinutes: 120, vendorKnowsIt: true });

    await run();

    const rows = await owner.sql<{ status: string }[]>`
      SELECT status FROM kyc_records WHERE id = ${id}
    `;
    expect(rows[0]!.status).toBe("IN_PROGRESS");
  });

  test("an empty sweep is quiet", async () => {
    const lines: string[] = [];
    const report = await run({ log: (l) => lines.push(l) });

    expect(report.checked).toBe(0);
    expect(lines).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */

/**
 * Self-healing.
 *
 * Given the shared pipeline — the same function the API's webhook handler
 * calls — reconciliation can finish the job instead of only reporting it. A
 * lost webhook stops being a case somebody has to chase and becomes a case
 * that completes a few minutes late.
 *
 * It can only do this safely because the pipeline is shared. A second copy of
 * decideKyc(), the duplicate-PAN check and the five-table write would drift
 * from the API's, silently, in the part of the system where being wrong
 * matters most.
 */
describe("healing the sessions it finds", () => {
  const encryptor = new PlaceholderPanEncryptor("test");

  function heal(overrides: { stuckAfterMinutes?: number; log?: (l: string) => void } = {}) {
    return reconcileStuckSessions({
      db,
      provider,
      now: NOW,
      healer: {
        thresholds: DEFAULT_KYC_THRESHOLDS,
        blindIndexKey: Buffer.alloc(32, 31),
        encryptor,
      },
      ...overrides,
    });
  }

  test("a missed result is applied, not just reported", async () => {
    const id = await seedInProgress({ ageMinutes: 120, vendorKnowsIt: true });

    const report = await heal();

    expect(report.healed).toBe(1);

    const rows = await owner.sql<{ status: string }[]>`
      SELECT status FROM kyc_records WHERE id = ${id}
    `;
    expect(rows[0]!.status).toBe("VERIFIED");
  });

  test("healing writes the checks, the outbox event and the audit row", async () => {
    await seedInProgress({ ageMinutes: 120, vendorKnowsIt: true });

    await heal();

    const checks = await owner.sql<{ c: string }[]>`SELECT count(*)::text AS c FROM kyc_checks`;
    const outbox = await owner.sql<{ event_type: string }[]>`SELECT event_type FROM outbox_events`;
    const audit = await owner.sql<{ action: string }[]>`SELECT action FROM audit_log`;

    expect(Number(checks[0]!.c)).toBeGreaterThan(0);
    expect(outbox[0]!.event_type).toBe("kyc.verified");
    expect(audit[0]!.action).toBe("kyc.decided");
  });

  /** So the customer finds out, through the ordinary notification path. */
  test("the customer gets told, because the outbox event is real", async () => {
    await seedInProgress({ ageMinutes: 120, vendorKnowsIt: true });

    await heal();

    const rows = await owner.sql<{ status: string }[]>`
      SELECT status FROM outbox_events
    `;
    expect(rows[0]!.status).toBe("PENDING");
  });

  test("a session the vendor knows nothing about is left alone", async () => {
    const id = await seedInProgress({ ageMinutes: 120, vendorKnowsIt: false });

    const report = await heal();

    expect(report.healed).toBe(0);
    const rows = await owner.sql<{ status: string }[]>`
      SELECT status FROM kyc_records WHERE id = ${id}
    `;
    expect(rows[0]!.status).toBe("IN_PROGRESS");
  });

  /**
   * One stuck session that cannot be healed must not stop the others. The
   * commonest cause is a record somebody has already decided by hand while the
   * sweep was running.
   */
  test("a session that fails to heal does not block the rest", async () => {
    const healthy = await seedInProgress({ ageMinutes: 120, vendorKnowsIt: true });
    const settledMeanwhile = await seedInProgress({ ageMinutes: 120, vendorKnowsIt: true });

    await owner.sql`UPDATE kyc_records SET status = 'IN_PROGRESS' WHERE id = ${settledMeanwhile}`;

    const lines: string[] = [];
    const report = await heal({ log: (l) => lines.push(l) });

    expect(report.healed).toBe(2);
    expect(healthy).toBeTruthy();
  });

  test("it reports what it could not heal", async () => {
    const id = await seedInProgress({ ageMinutes: 120, vendorKnowsIt: true });
    /** Settle it, so the state machine refuses the transition. */
    await owner.sql`UPDATE kyc_records SET status = 'VERIFIED' WHERE id = ${id}`;

    const report = await heal();

    /** Already settled, so it is no longer a stuck session at all. */
    expect(report.checked).toBe(0);
    expect(report.healed).toBe(0);
  });
});

/* ------------------------------------------------------------------ */

/**
 * The healer and the API must decide the same case the same way.
 *
 * This is the bug these tests exist for, not the loader. The healer used the
 * compiled defaults while the API read the settings table, so retuning the
 * face-match bar changed the webhook path and left the healing path alone: one
 * case, two answers, decided by which path happened to reach it.
 */
describe("the healer decides against the same thresholds as the API", () => {
  const encryptor = new PlaceholderPanEncryptor("test");

  async function setThreshold(key: string, value: unknown): Promise<void> {
    await owner.sql`
      INSERT INTO settings (key, value)
      VALUES (${`kyc.threshold.${key}`}, ${JSON.stringify(value)}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `;
  }

  /**
   * The factory main.ts uses, not a copy of it.
   *
   * This matters more than it looks. The previous version of this helper built
   * its own healer with the same shape, which meant the test passed while
   * main.ts was assembling a healer that used the compiled defaults — the test
   * covered the loader and not the wiring, and the wiring was the bug.
   */
  let factory: ReturnType<typeof healerFactory> | null = null;

  /** Built on first use: `db` is only assigned in beforeAll. */
  function healerFromSettings() {
    factory ??= healerFactory({
      db,
      blindIndexKeyBase64: Buffer.alloc(32, 31).toString("base64"),
      nodeEnv: "test",
      log: () => {},
    });
    return factory();
  }

  test("with no override it uses the defaults, as before", async () => {
    const healer = await healerFromSettings();
    expect(healer.thresholds).toEqual(DEFAULT_KYC_THRESHOLDS);
  });

  /**
   * The face-match bar raised above what the fake's passing scenario returns.
   * The same session that verifies at the default bar must now go to review —
   * if it still verifies, the healer is not reading the table.
   */
  test("raising the face-match bar changes what healing decides", async () => {
    const atDefault = await seedInProgress({ ageMinutes: 120, vendorKnowsIt: true });
    await reconcileStuckSessions({
      db, provider, now: NOW, healer: await healerFromSettings(),
    });

    const before = await owner.sql<{ status: string }[]>`
      SELECT status FROM kyc_records WHERE id = ${atDefault}
    `;
    expect(before[0]!.status).toBe("VERIFIED");

    /** Now Ops raises it to something the passing scenario cannot clear. */
    await setThreshold("faceMatch", 0.99);

    const raised = await seedInProgress({ ageMinutes: 120, vendorKnowsIt: true });
    await reconcileStuckSessions({
      db, provider, now: NOW, healer: await healerFromSettings(),
    });

    const after = await owner.sql<{ status: string; decision_reasons: { code: string }[] }[]>`
      SELECT status, decision_reasons FROM kyc_records WHERE id = ${raised}
    `;
    expect(after[0]!.status).toBe("MANUAL_REVIEW");
    expect(after[0]!.decision_reasons.map((r) => r.code)).toContain("FACE_MATCH_LOW");
  });

  /**
   * And the thresholds that were actually used are recorded on the record, so
   * a decision can be reproduced later. Without this, "why was this approved?"
   * is unanswerable once somebody retunes.
   */
  test("the thresholds used are stored with the decision", async () => {
    await setThreshold("faceMatch", 0.81);

    const id = await seedInProgress({ ageMinutes: 120, vendorKnowsIt: true });
    await reconcileStuckSessions({
      db, provider, now: NOW, healer: await healerFromSettings(),
    });

    const rows = await owner.sql<{ thresholds_used: Record<string, number> }[]>`
      SELECT thresholds_used FROM kyc_records WHERE id = ${id}
    `;
    expect(rows[0]!.thresholds_used.faceMatch).toBe(0.81);
  });

  /**
   * A setting that would disable a check is refused by the loader, so the
   * healer never sees it. A face-match bar of zero passes every face.
   */
  test("a threshold that would disable a check never reaches the healer", async () => {
    await setThreshold("faceMatch", 0);

    const healer = await healerFromSettings();
    expect(healer.thresholds.faceMatch).toBe(DEFAULT_KYC_THRESHOLDS.faceMatch);
  });
});
