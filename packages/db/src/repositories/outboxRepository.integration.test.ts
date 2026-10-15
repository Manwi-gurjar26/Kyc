import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { withContext, type DatabaseHandle } from "../client.js";
import {
  countOf,
  openOwnerDatabase,
  openTestDatabase,
  resetTables,
} from "../testing/harness.js";
import {
  BACKOFF_SECONDS,
  MAX_ATTEMPTS,
  claimOutboxBatch,
  completeOutboxEvent,
  failOutboxEvent,
  outboxStats,
} from "./outboxRepository.js";

/**
 * Draining the outbox.
 *
 * The transactional outbox is what makes "data saved but notification never
 * sent" impossible: the event row is written in the same transaction as the
 * business change. That guarantee is worth nothing unless something actually
 * drains it, and draining it safely across several workers is the whole
 * difficulty.
 */

const NOW = new Date("2026-10-09T15:00:00.000Z");

let app: DatabaseHandle;
let owner: DatabaseHandle;

beforeAll(() => {
  app = openTestDatabase();
  owner = openOwnerDatabase();
});

afterAll(async () => {
  await app.close();
  await owner.close();
});

beforeEach(async () => {
  await resetTables(owner);
});

/* ------------------------------------------------------------------ */

/**
 * created_at is seeded explicitly rather than left to the column default.
 *
 * It used to default to the database's own now(), which meant any assertion
 * about an event's age compared the real wall clock against this file's frozen
 * NOW — a value whose sign depended on what day the suite ran. It passed for
 * weeks and then failed at a date rollover, having never tested anything.
 */
async function seedEvents(
  count: number,
  availableAt = NOW,
  createdAt = NOW,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await owner.sql`
      INSERT INTO outbox_events (
        event_type, aggregate_type, aggregate_id, payload, available_at, created_at
      )
      VALUES (
        'kyc.verified', 'kyc_record', gen_random_uuid(),
        ${JSON.stringify({ seq: i })}::jsonb,
        ${availableAt.toISOString()}::timestamptz,
        ${createdAt.toISOString()}::timestamptz
      )
    `;
  }
}

/* ------------------------------------------------------------------ */

describe("claiming work", () => {
  test("claims up to the batch size", async () => {
    await seedEvents(5);

    const claimed = await withContext(app.db, { role: "system" }, (tx) =>
      claimOutboxBatch(tx, { limit: 3, now: NOW }),
    );

    expect(claimed).toHaveLength(3);
  });

  test("claims fewer when fewer are due", async () => {
    await seedEvents(2);

    const claimed = await withContext(app.db, { role: "system" }, (tx) =>
      claimOutboxBatch(tx, { limit: 10, now: NOW }),
    );

    expect(claimed).toHaveLength(2);
  });

  test("marks what it claimed as PROCESSING and counts the attempt", async () => {
    await seedEvents(1);

    const claimed = await withContext(app.db, { role: "system" }, (tx) =>
      claimOutboxBatch(tx, { limit: 1, now: NOW }),
    );

    const rows = await owner.sql<{ status: string; attempts: number }[]>`
      SELECT status, attempts FROM outbox_events WHERE id = ${claimed[0]!.id}
    `;
    expect(rows[0]!.status).toBe("PROCESSING");
    expect(rows[0]!.attempts).toBe(1);
  });

  /** Backoff: an event scheduled for later is not work yet. */
  test("does not claim an event that is not due", async () => {
    await seedEvents(1, new Date(NOW.getTime() + 60_000));

    const claimed = await withContext(app.db, { role: "system" }, (tx) =>
      claimOutboxBatch(tx, { limit: 10, now: NOW }),
    );

    expect(claimed).toHaveLength(0);
  });

  test("oldest first, so nothing starves", async () => {
    await owner.sql`
      INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload, available_at, created_at)
      VALUES
        ('kyc.verified','kyc_record',gen_random_uuid(),'{"n":"newer"}'::jsonb,
         ${NOW.toISOString()}::timestamptz, ${new Date(NOW.getTime() - 1000).toISOString()}::timestamptz),
        ('kyc.verified','kyc_record',gen_random_uuid(),'{"n":"older"}'::jsonb,
         ${NOW.toISOString()}::timestamptz, ${new Date(NOW.getTime() - 60000).toISOString()}::timestamptz)
    `;

    const claimed = await withContext(app.db, { role: "system" }, (tx) =>
      claimOutboxBatch(tx, { limit: 1, now: NOW }),
    );

    expect((claimed[0]!.payload as { n: string }).n).toBe("older");
  });

  test("ignores events that are already DONE or DEAD", async () => {
    await owner.sql`
      INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload, status)
      VALUES ('kyc.verified','kyc_record',gen_random_uuid(),'{}'::jsonb,'DONE'),
             ('kyc.verified','kyc_record',gen_random_uuid(),'{}'::jsonb,'DEAD')
    `;

    const claimed = await withContext(app.db, { role: "system" }, (tx) =>
      claimOutboxBatch(tx, { limit: 10, now: NOW }),
    );

    expect(claimed).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */

/**
 * THE TEST THIS FILE EXISTS FOR.
 *
 * Several workers run at once — two containers minimum, more under load.
 * Without SKIP LOCKED, the second worker's claim query blocks on the first
 * worker's locked rows and then returns the same events once the first
 * commits, so every notification goes out twice. With it, the second worker
 * steps over what is already claimed and takes different work.
 */
describe("several workers at once", () => {
  test("two concurrent claims never take the same event", async () => {
    await seedEvents(10);

    const [first, second] = await Promise.all([
      withContext(app.db, { role: "system" }, (tx) =>
        claimOutboxBatch(tx, { limit: 5, now: NOW }),
      ),
      withContext(app.db, { role: "system" }, (tx) =>
        claimOutboxBatch(tx, { limit: 5, now: NOW }),
      ),
    ]);

    const ids = [...first, ...second].map((e) => e.id);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
  });

  test("five workers racing for three events share them out", async () => {
    await seedEvents(3);

    const batches = await Promise.all(
      Array.from({ length: 5 }, () =>
        withContext(app.db, { role: "system" }, (tx) =>
          claimOutboxBatch(tx, { limit: 2, now: NOW }),
        ),
      ),
    );

    const ids = batches.flat().map((e) => e.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  test("a claimed event is not claimable again until it is released", async () => {
    await seedEvents(1);

    const first = await withContext(app.db, { role: "system" }, (tx) =>
      claimOutboxBatch(tx, { limit: 1, now: NOW }),
    );
    expect(first).toHaveLength(1);

    const second = await withContext(app.db, { role: "system" }, (tx) =>
      claimOutboxBatch(tx, { limit: 1, now: NOW }),
    );
    expect(second).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */

describe("finishing work", () => {
  test("completing marks it DONE with a timestamp", async () => {
    await seedEvents(1);
    const [event] = await withContext(app.db, { role: "system" }, (tx) =>
      claimOutboxBatch(tx, { limit: 1, now: NOW }),
    );

    await withContext(app.db, { role: "system" }, (tx) =>
      completeOutboxEvent(tx, event!.id, NOW),
    );

    const rows = await owner.sql<{ status: string; processed_at: string | null }[]>`
      SELECT status, processed_at FROM outbox_events WHERE id = ${event!.id}
    `;
    expect(rows[0]!.status).toBe("DONE");
    expect(rows[0]!.processed_at).not.toBeNull();
  });

  test("a completed event is never claimed again", async () => {
    await seedEvents(1);
    const [event] = await withContext(app.db, { role: "system" }, (tx) =>
      claimOutboxBatch(tx, { limit: 1, now: NOW }),
    );
    await withContext(app.db, { role: "system" }, (tx) =>
      completeOutboxEvent(tx, event!.id, NOW),
    );

    const again = await withContext(app.db, { role: "system" }, (tx) =>
      claimOutboxBatch(tx, { limit: 10, now: NOW }),
    );
    expect(again).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */

describe("failing work", () => {
  test("a failure goes back to PENDING with the error recorded", async () => {
    await seedEvents(1);
    const [event] = await withContext(app.db, { role: "system" }, (tx) =>
      claimOutboxBatch(tx, { limit: 1, now: NOW }),
    );

    await withContext(app.db, { role: "system" }, (tx) =>
      failOutboxEvent(tx, {
        id: event!.id,
        attempts: event!.attempts,
        error: "WhatsApp returned 503",
        now: NOW,
      }),
    );

    const rows = await owner.sql<{ status: string; last_error: string }[]>`
      SELECT status, last_error FROM outbox_events WHERE id = ${event!.id}
    `;
    expect(rows[0]!.status).toBe("PENDING");
    expect(rows[0]!.last_error).toBe("WhatsApp returned 503");
  });

  /**
   * Exponential backoff. Retrying a failing vendor immediately, in a tight
   * loop, is how one vendor outage becomes a self-inflicted denial of service
   * against them and a bill for us.
   */
  test("the retry is pushed into the future, further each time", async () => {
    await seedEvents(1);
    const [event] = await withContext(app.db, { role: "system" }, (tx) =>
      claimOutboxBatch(tx, { limit: 1, now: NOW }),
    );

    await withContext(app.db, { role: "system" }, (tx) =>
      failOutboxEvent(tx, { id: event!.id, attempts: 1, error: "boom", now: NOW }),
    );
    const afterFirst = await owner.sql<{ available_at: string }[]>`
      SELECT available_at FROM outbox_events WHERE id = ${event!.id}
    `;

    await withContext(app.db, { role: "system" }, (tx) =>
      failOutboxEvent(tx, { id: event!.id, attempts: 3, error: "boom", now: NOW }),
    );
    const afterThird = await owner.sql<{ available_at: string }[]>`
      SELECT available_at FROM outbox_events WHERE id = ${event!.id}
    `;

    const first = new Date(afterFirst[0]!.available_at).getTime();
    const third = new Date(afterThird[0]!.available_at).getTime();

    expect(first).toBeGreaterThan(NOW.getTime());
    expect(third).toBeGreaterThan(first);
    expect(first - NOW.getTime()).toBe(BACKOFF_SECONDS[1]! * 1000);
  });

  test("an event that is not due again is not claimed", async () => {
    await seedEvents(1);
    const [event] = await withContext(app.db, { role: "system" }, (tx) =>
      claimOutboxBatch(tx, { limit: 1, now: NOW }),
    );
    await withContext(app.db, { role: "system" }, (tx) =>
      failOutboxEvent(tx, { id: event!.id, attempts: 1, error: "boom", now: NOW }),
    );

    const immediately = await withContext(app.db, { role: "system" }, (tx) =>
      claimOutboxBatch(tx, { limit: 10, now: NOW }),
    );
    expect(immediately).toHaveLength(0);

    const later = await withContext(app.db, { role: "system" }, (tx) =>
      claimOutboxBatch(tx, {
        limit: 10,
        now: new Date(NOW.getTime() + BACKOFF_SECONDS[1]! * 1000 + 1000),
      }),
    );
    expect(later).toHaveLength(1);
  });

  /**
   * After enough attempts the event stops being retried and starts being
   * somebody's problem. An event retrying forever is worse than a dead one:
   * it is invisible, it costs money, and nobody is told.
   */
  test("it goes to the dead-letter state after the attempt limit", async () => {
    await seedEvents(1);
    const [event] = await withContext(app.db, { role: "system" }, (tx) =>
      claimOutboxBatch(tx, { limit: 1, now: NOW }),
    );

    await withContext(app.db, { role: "system" }, (tx) =>
      failOutboxEvent(tx, {
        id: event!.id,
        attempts: MAX_ATTEMPTS,
        error: "still broken",
        now: NOW,
      }),
    );

    const rows = await owner.sql<{ status: string }[]>`
      SELECT status FROM outbox_events WHERE id = ${event!.id}
    `;
    expect(rows[0]!.status).toBe("DEAD");
  });

  test("a dead event is never claimed again, however long you wait", async () => {
    await seedEvents(1);
    const [event] = await withContext(app.db, { role: "system" }, (tx) =>
      claimOutboxBatch(tx, { limit: 1, now: NOW }),
    );
    await withContext(app.db, { role: "system" }, (tx) =>
      failOutboxEvent(tx, {
        id: event!.id,
        attempts: MAX_ATTEMPTS,
        error: "still broken",
        now: NOW,
      }),
    );

    const later = await withContext(app.db, { role: "system" }, (tx) =>
      claimOutboxBatch(tx, {
        limit: 10,
        now: new Date(NOW.getTime() + 86_400_000),
      }),
    );
    expect(later).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */

describe("what the dashboard and the alerts read", () => {
  test("counts by status, and the oldest pending event", async () => {
    /**
     * Two pending events of different ages, so the assertion covers "oldest"
     * rather than merely "an age". The alert that pages somebody fires on this
     * number, and reporting the newest event's age would mean a backlog hours
     * deep looked fresh.
     */
    await seedEvents(1, NOW, new Date(NOW.getTime() - 90_000));
    await seedEvents(1, NOW, new Date(NOW.getTime() - 30_000));
    await owner.sql`
      INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload, status)
      VALUES ('kyc.verified','kyc_record',gen_random_uuid(),'{}'::jsonb,'DEAD')
    `;

    const stats = await withContext(app.db, { role: "system" }, (tx) =>
      outboxStats(tx, NOW),
    );

    expect(stats.pending).toBe(2);
    expect(stats.dead).toBe(1);
    expect(stats.oldestPendingAgeSeconds).toBe(90);
  });

  /** A non-zero dead count is the thing that should page somebody. */
  test("reports zero dead when nothing has failed", async () => {
    await seedEvents(1);

    const stats = await withContext(app.db, { role: "system" }, (tx) =>
      outboxStats(tx, NOW),
    );
    expect(stats.dead).toBe(0);
  });

  test("an empty outbox reports no oldest age rather than zero", async () => {
    const stats = await withContext(app.db, { role: "system" }, (tx) =>
      outboxStats(tx, NOW),
    );
    expect(stats.pending).toBe(0);
    expect(stats.oldestPendingAgeSeconds).toBeNull();
    expect(await countOf(owner, "outbox_events")).toBe(0);
  });
});
