import { createClient, type Database, type DatabaseHandle } from "@kilowattx/db";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { OutboxDispatcher } from "./dispatcher.js";
import {
  FailingNotificationSender,
  RecordingNotificationSender,
} from "./notifications.js";

/**
 * The worker, against a real database.
 *
 * Every claim worth making here is about what happens when things go wrong:
 * the same event delivered twice, a provider outage, a worker killed
 * mid-handler, an event type nobody handles yet. None of that can be tested
 * without a real outbox table and real transactions.
 */

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://kilowattx_app:local_dev_only@localhost:5434/kilowattx_worker_test";
const OWNER_URL =
  process.env.OWNER_DATABASE_URL ??
  "postgresql://kilowattx:local_dev_only@localhost:5434/kilowattx_worker_test";

const NOW = new Date("2026-10-09T16:00:00.000Z");

let app: DatabaseHandle;
let owner: DatabaseHandle;
let db: Database;

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
});

/* ------------------------------------------------------------------ */

async function seedVerifiedCase(options: {
  locale?: string;
  eventType?: string;
  reasonCode?: string;
  withUser?: boolean;
} = {}): Promise<{ userId: string | null; recordId: string; eventId: string }> {
  let userId: string | null = null;

  if (options.withUser !== false) {
    const people = await owner.sql<{ id: string }[]>`
      INSERT INTO users (phone_e164, display_name, locale, phone_verified_at)
      VALUES (${"+9198200" + Math.floor(Math.random() * 90000 + 10000)},
              'Ramesh Kumar Sharma', ${options.locale ?? "en"}, now())
      RETURNING id
    `;
    userId = people[0]!.id;
  }

  const records = await owner.sql<{ id: string }[]>`
    INSERT INTO kyc_records (subject_type, user_id, level, status, vendor, vendor_session_id)
    VALUES (${userId ? "PERSON" : "ORGANISATION"}, ${userId}, 'FULL', 'VERIFIED',
            'fake', ${"sess_" + Math.random().toString(36).slice(2, 12)})
    RETURNING id
  `;
  const recordId = records[0]!.id;

  const payload = JSON.stringify({
    kycRecordId: recordId,
    status: "VERIFIED",
    ...(options.reasonCode ? { reasonCode: options.reasonCode } : {}),
  });

  const events = await owner.sql<{ id: string }[]>`
    INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload, available_at)
    VALUES (${options.eventType ?? "kyc.verified"}, 'kyc_record', ${recordId},
            ${payload}::jsonb, ${NOW.toISOString()}::timestamptz)
    RETURNING id
  `;

  return { userId, recordId, eventId: events[0]!.id };
}

function dispatcher() {
  const sender = new RecordingNotificationSender();
  return {
    sender,
    instance: new OutboxDispatcher({ db, sender, clock: () => NOW }),
  };
}

/** Separate helper, so `sender.history` stays available on the other one. */
function failingDispatcher(message?: string) {
  const sender = new FailingNotificationSender(message);
  return {
    sender,
    instance: new OutboxDispatcher({ db, sender, clock: () => NOW }),
  };
}

async function count(table: string): Promise<number> {
  const rows = await owner.sql.unsafe<{ c: string }[]>(
    `SELECT count(*)::text AS c FROM ${table}`,
  );
  return Number(rows[0]!.c);
}

/* ------------------------------------------------------------------ */

describe("the happy path", () => {
  test("drains a pending event and marks it DONE", async () => {
    const { eventId } = await seedVerifiedCase();
    const { instance } = dispatcher();

    const result = await instance.runOnce();

    expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0, dead: 0 });

    const rows = await owner.sql<{ status: string }[]>`
      SELECT status FROM outbox_events WHERE id = ${eventId}
    `;
    expect(rows[0]!.status).toBe("DONE");
  });

  test("sends on every channel the rule names", async () => {
    await seedVerifiedCase();
    const { sender, instance } = dispatcher();

    await instance.runOnce();

    expect(sender.history.map((m) => m.channel).sort()).toEqual(["PUSH", "WHATSAPP"]);
  });

  test("records a delivery row per channel, marked SENT", async () => {
    await seedVerifiedCase();
    const { instance } = dispatcher();

    await instance.runOnce();

    const rows = await owner.sql<
      { channel: string; status: string; provider: string; provider_message_id: string }[]
    >`SELECT channel, status, provider, provider_message_id FROM notification_deliveries ORDER BY channel`;

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "SENT")).toBe(true);
    expect(rows.every((r) => r.provider_message_id !== null)).toBe(true);
  });

  /** The reason the table exists: "did you tell me?" has an answer. */
  test("the delivery row ties back to the event that caused it", async () => {
    const { eventId } = await seedVerifiedCase();
    const { instance } = dispatcher();

    await instance.runOnce();

    const rows = await owner.sql<{ outbox_event_id: string }[]>`
      SELECT outbox_event_id FROM notification_deliveries
    `;
    expect(rows.every((r) => r.outbox_event_id === eventId)).toBe(true);
  });

  test("messages go out in the person's own language", async () => {
    await seedVerifiedCase({ locale: "hi" });
    const { sender, instance } = dispatcher();

    await instance.runOnce();

    expect(sender.history.every((m) => m.locale === "hi")).toBe(true);
  });

  test("a resubmission request carries the reason, so the message can say why", async () => {
    await seedVerifiedCase({
      eventType: "kyc.resubmission_requested",
      reasonCode: "SELFIE_TOO_DARK",
    });
    const { sender, instance } = dispatcher();

    await instance.runOnce();

    expect(sender.history[0]!.variables.reasonCode).toBe("SELFIE_TOO_DARK");
    /** It asks the person to act, so it goes on SMS too. */
    expect(sender.history.map((m) => m.channel).sort()).toEqual([
      "PUSH",
      "SMS",
      "WHATSAPP",
    ]);
  });

  test("nothing to do is not an error", async () => {
    const { instance } = dispatcher();
    const result = await instance.runOnce();
    expect(result).toMatchObject({ claimed: 0, completed: 0 });
  });

  test("drains several events in one pass", async () => {
    await seedVerifiedCase();
    await seedVerifiedCase();
    await seedVerifiedCase();
    const { instance } = dispatcher();

    const result = await instance.runOnce();
    expect(result.completed).toBe(3);
    expect(await count("notification_deliveries")).toBe(6);
  });
});

/* ------------------------------------------------------------------ */

/**
 * The guarantee that matters most. Vendors retry, workers restart, and the
 * same event WILL be processed twice. Twice must not mean two WhatsApp
 * messages.
 */
describe("sending twice is impossible", () => {
  test("a second pass over the same event sends nothing more", async () => {
    const { eventId } = await seedVerifiedCase();
    const { sender, instance } = dispatcher();

    await instance.runOnce();
    expect(sender.history).toHaveLength(2);

    /** Force the event back to PENDING, as a crashed worker would leave it. */
    await owner.sql`
      UPDATE outbox_events SET status = 'PENDING', available_at = ${NOW.toISOString()}::timestamptz
      WHERE id = ${eventId}
    `;

    await instance.runOnce();

    /** The delivery rows already exist, so the sends are skipped. */
    expect(sender.history).toHaveLength(2);
    expect(await count("notification_deliveries")).toBe(2);
  });

  test("the unique index is what enforces it, not the code path", async () => {
    const { eventId, userId } = await seedVerifiedCase();

    await expect(
      owner.sql`
        INSERT INTO notification_deliveries (outbox_event_id, user_id, channel, template)
        VALUES (${eventId}, ${userId}, 'PUSH', 'kyc_verified'),
               (${eventId}, ${userId}, 'PUSH', 'kyc_verified')
      `,
    ).rejects.toThrow(/notification_once_per_event_channel/);
  });
});

/* ------------------------------------------------------------------ */

describe("when the provider is down", () => {
  test("the event goes back to PENDING with the error recorded", async () => {
    const { eventId } = await seedVerifiedCase();
    const { instance } = failingDispatcher("WhatsApp 503");

    const result = await instance.runOnce();
    expect(result).toMatchObject({ completed: 0, failed: 1, dead: 0 });

    const rows = await owner.sql<{ status: string; last_error: string }[]>`
      SELECT status, last_error FROM outbox_events WHERE id = ${eventId}
    `;
    expect(rows[0]!.status).toBe("PENDING");
    expect(rows[0]!.last_error).toMatch(/WhatsApp 503/);
  });

  /**
   * The whole event rolls back, delivery rows included. That is correct: the
   * event will be retried in full, and a half-written delivery row would make
   * the retry skip a channel that never actually sent.
   */
  test("a failed send leaves no delivery rows behind", async () => {
    await seedVerifiedCase();
    const { instance } = failingDispatcher();

    await instance.runOnce();

    expect(await count("notification_deliveries")).toBe(0);
  });

  test("the retry is scheduled, not immediate", async () => {
    const { eventId } = await seedVerifiedCase();
    const { instance } = failingDispatcher();

    await instance.runOnce();

    const rows = await owner.sql<{ available_at: string }[]>`
      SELECT available_at FROM outbox_events WHERE id = ${eventId}
    `;
    expect(new Date(rows[0]!.available_at).getTime()).toBeGreaterThan(NOW.getTime());
  });

  test("a second pass immediately afterwards picks up nothing", async () => {
    await seedVerifiedCase();
    const { instance } = failingDispatcher();

    await instance.runOnce();
    const second = await instance.runOnce();

    expect(second.claimed).toBe(0);
  });

  /** It stops eventually, and the stop is visible. */
  test("it dead-letters after the attempt limit", async () => {
    const { eventId } = await seedVerifiedCase();
    const lines: string[] = [];
    const instance = new OutboxDispatcher({
      db,
      sender: new FailingNotificationSender(),
      clock: () => NOW,
      log: (line) => lines.push(line),
    });

    /** Drive it past the limit, ignoring the backoff. */
    for (let i = 0; i < 6; i += 1) {
      await owner.sql`
        UPDATE outbox_events SET status = 'PENDING', available_at = ${NOW.toISOString()}::timestamptz
        WHERE id = ${eventId} AND status <> 'DEAD'
      `;
      await instance.runOnce();
    }

    const rows = await owner.sql<{ status: string; attempts: number }[]>`
      SELECT status, attempts FROM outbox_events WHERE id = ${eventId}
    `;
    expect(rows[0]!.status).toBe("DEAD");
    expect(lines.some((l) => l.includes("DEAD"))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe("a worker that died mid-processing", () => {
  /**
   * A deploy, an OOM kill, a replaced container. The event is left in
   * PROCESSING, claimed by nobody and retried by nobody, and the customer is
   * never told anything.
   */
  test("an abandoned PROCESSING event is released and handled", async () => {
    const { eventId } = await seedVerifiedCase();

    await owner.sql`
      UPDATE outbox_events
      SET status = 'PROCESSING', created_at = ${new Date(NOW.getTime() - 3_600_000).toISOString()}::timestamptz
      WHERE id = ${eventId}
    `;

    const { instance } = dispatcher();
    const result = await instance.runOnce();

    expect(result.released).toBe(1);
    expect(result.completed).toBe(1);
  });

  test("a recently claimed event is left alone", async () => {
    const { eventId } = await seedVerifiedCase();

    await owner.sql`
      UPDATE outbox_events SET status = 'PROCESSING', created_at = ${NOW.toISOString()}::timestamptz
      WHERE id = ${eventId}
    `;

    const { instance } = dispatcher();
    const result = await instance.runOnce();

    expect(result.released).toBe(0);
    expect(result.claimed).toBe(0);
  });
});

/* ------------------------------------------------------------------ */

/**
 * Every outbox row these tests insert sets available_at explicitly.
 *
 * Left to the column default it is the database's own now(), while the
 * dispatcher under test runs on the frozen NOW above. The claim query compares
 * the two, so whether anything was claimed depended on which side of NOW the
 * real clock happened to be — these two tests passed for weeks and then both
 * failed at a date rollover, having proved nothing in between.
 */
describe("events nobody handles", () => {
  /**
   * The commonest cause is a rolling deploy: the API already emits something
   * the worker does not know yet. So it retries rather than dying instantly,
   * which gives the worker rollout time to catch up.
   */
  test("an unknown event type retries rather than dying at once", async () => {
    const { recordId } = await seedVerifiedCase();
    await owner.sql`
      INSERT INTO outbox_events (
        event_type, aggregate_type, aggregate_id, payload, available_at
      )
      VALUES ('kyc.something_new', 'kyc_record', ${recordId}, '{}'::jsonb,
              ${NOW.toISOString()}::timestamptz)
    `;

    const { instance } = dispatcher();
    const result = await instance.runOnce();

    expect(result.failed).toBe(1);

    const rows = await owner.sql<{ status: string; last_error: string }[]>`
      SELECT status, last_error FROM outbox_events WHERE event_type = 'kyc.something_new'
    `;
    expect(rows[0]!.status).toBe("PENDING");
    expect(rows[0]!.last_error).toMatch(/No handler/);
  });

  /**
   * One bad event must not take the batch with it. A batch-wide transaction
   * would roll back the good ones too, and they would then be retried — which
   * means duplicate notifications once the bad one is fixed.
   */
  test("one poisonous event does not stop the others", async () => {
    await seedVerifiedCase();
    await seedVerifiedCase();
    const { recordId } = await seedVerifiedCase();
    await owner.sql`
      INSERT INTO outbox_events (
        event_type, aggregate_type, aggregate_id, payload, available_at
      )
      VALUES ('kyc.not_a_thing', 'kyc_record', ${recordId}, '{}'::jsonb,
              ${NOW.toISOString()}::timestamptz)
    `;

    const { instance } = dispatcher();
    const result = await instance.runOnce();

    expect(result.completed).toBe(3);
    expect(result.failed).toBe(1);
  });
});

/* ------------------------------------------------------------------ */

/**
 * An event describes something that HAPPENED. The worker may run seconds or
 * minutes later, by which time the record has moved on — a reviewer approves
 * a case while its "under review" notification is still queued.
 */
describe("the message describes the event, not the record's state now", () => {
  test("a stale event still reports the status it was emitted for", async () => {
    const { recordId } = await seedVerifiedCase({
      eventType: "kyc.review_required",
    });

    /** Emitted while under review... */
    await owner.sql`
      UPDATE outbox_events SET payload = jsonb_set(payload, '{status}', '"MANUAL_REVIEW"')
      WHERE aggregate_id = ${recordId}
    `;
    /** ...and a reviewer approves it before the worker gets there. */
    await owner.sql`UPDATE kyc_records SET status = 'VERIFIED' WHERE id = ${recordId}`;

    const { sender, instance } = dispatcher();
    await instance.runOnce();

    /**
     * The template says "under review", so the variable must too. Reading the
     * record live produces a message whose wording and whose data disagree.
     */
    expect(sender.history[0]!.template).toBe("kyc_under_review");
    expect(sender.history[0]!.variables.status).toBe("MANUAL_REVIEW");
  });

  test("it falls back to the record when the event carries no status", async () => {
    const { recordId } = await seedVerifiedCase();
    await owner.sql`
      UPDATE outbox_events SET payload = '{}'::jsonb WHERE aggregate_id = ${recordId}
    `;

    const { sender, instance } = dispatcher();
    await instance.runOnce();

    expect(sender.history[0]!.variables.status).toBe("VERIFIED");
  });
});

/* ------------------------------------------------------------------ */

describe("events with nobody to notify", () => {
  /**
   * A KYB case belongs to an organisation, and no person has a phone number
   * yet. There is nobody to message, so the event is complete — throwing
   * would retry forever and then dead-letter something that was never wrong.
   */
  test("an organisation case completes without sending anything", async () => {
    await seedVerifiedCase({ withUser: false });
    const { sender, instance } = dispatcher();

    const result = await instance.runOnce();

    expect(result.completed).toBe(1);
    expect(sender.history).toHaveLength(0);
  });
});
