import { createClient, type Database, type DatabaseHandle } from "@kilowattx/db";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { drainOutbox, tracked } from "./jobs.js";
import { readHeartbeats } from "./heartbeat.js";

/**
 * The two pieces of logic inside a scheduled pass.
 *
 * Both were closures inside main() and therefore untested, which is how the
 * healer bug got in: a test that builds its own copy of the thing proves
 * nothing about the thing the process runs.
 */

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://kilowattx_app:local_dev_only@localhost:5434/kilowattx_worker_test";
const OWNER_URL =
  process.env.OWNER_DATABASE_URL ??
  "postgresql://kilowattx:local_dev_only@localhost:5434/kilowattx_worker_test";

const NOW = new Date("2026-10-14T15:00:00.000Z");

let app: DatabaseHandle;
let owner: DatabaseHandle;
let db: Database;

beforeAll(() => {
  app = createClient({ url: DB_URL, maxConnections: 4 });
  owner = createClient({ url: OWNER_URL, maxConnections: 4 });
  db = app.db;
});

afterAll(async () => {
  await app.close();
  await owner.close();
});

beforeEach(async () => {
  await owner.sql.unsafe(`TRUNCATE TABLE job_heartbeats`);
});

/* ------------------------------------------------------------------ */

/**
 * A dispatcher that hands out a fixed script of batch sizes.
 *
 * A fake rather than the real dispatcher: what is under test is the looping,
 * not the draining. The real dispatcher has its own integration tests against
 * real rows, and driving it here would need hundreds of seeded events to say
 * anything about the bound.
 */
function scriptedDispatcher(claims: number[]) {
  let call = 0;
  return {
    calls: () => call,
    runOnce: async () => {
      const claimed = claims[call] ?? 0;
      call += 1;
      return { claimed, completed: claimed, failed: 0, dead: 0, released: 0 };
    },
  };
}

/* ------------------------------------------------------------------ */

describe("draining the outbox in one pass", () => {
  test("an empty queue costs exactly one batch", async () => {
    const dispatcher = scriptedDispatcher([0]);

    const result = await drainOutbox(dispatcher, { maxBatches: 25 });

    expect(result.batches).toBe(1);
    expect(result.events).toBe(0);
    expect(dispatcher.calls()).toBe(1);
  });

  /**
   * The reason this loops at all. Cron's finest resolution is a minute, so one
   * batch per pass would trickle a backlog out twenty at a time — somebody
   * would wait half an hour to be told their KYC was approved.
   */
  test("it keeps going until a batch comes back empty", async () => {
    const dispatcher = scriptedDispatcher([20, 20, 7, 0]);

    const result = await drainOutbox(dispatcher, { maxBatches: 25 });

    expect(result.batches).toBe(4);
    expect(result.events).toBe(47);
    expect(result.hitLimit).toBe(false);
  });

  test("it does not keep calling after the queue is drained", async () => {
    const dispatcher = scriptedDispatcher([5, 0]);

    await drainOutbox(dispatcher, { maxBatches: 25 });

    expect(dispatcher.calls()).toBe(2);
  });

  /**
   * A pass that never returns holds its singleton lock indefinitely and blocks
   * its own next run. The bound is what stops a growing backlog turning into a
   * worker that never finishes a pass again.
   */
  test("it stops at the bound rather than running forever", async () => {
    const dispatcher = scriptedDispatcher(Array(100).fill(20));

    const result = await drainOutbox(dispatcher, { maxBatches: 5 });

    expect(result.batches).toBe(5);
    expect(result.events).toBe(100);
    expect(dispatcher.calls()).toBe(5);
  });

  /**
   * And it says so. Hitting the bound means the backlog is growing faster than
   * one worker drains it, which is a capacity fact rather than a glitch.
   */
  test("hitting the bound is reported", async () => {
    const dispatcher = scriptedDispatcher(Array(100).fill(20));

    const result = await drainOutbox(dispatcher, { maxBatches: 3 });

    expect(result.hitLimit).toBe(true);
  });

  /**
   * Using every allowed batch is not the same as being cut off. A queue that
   * drained on its last permitted batch finished, and reporting that as a
   * capacity problem would be crying wolf.
   */
  test("finishing on the last allowed batch is not reported as a limit", async () => {
    const dispatcher = scriptedDispatcher([20, 20, 0]);

    const result = await drainOutbox(dispatcher, { maxBatches: 3 });

    expect(result.batches).toBe(3);
    expect(result.hitLimit).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe("recording every pass", () => {
  test("a pass that works is recorded as a success", async () => {
    await tracked(db, "outbox.drain", async () => {}, () => NOW)();

    const rows = await readHeartbeats(db);
    expect(rows[0]!.lastSuccessAt).toEqual(NOW);
    expect(rows[0]!.lastError).toBeNull();
  });

  /**
   * The ordering that matters. pg-boss must still see the job as failed so its
   * retry policy applies — a swallowed error would leave the heartbeat saying
   * unhealthy while pg-boss believed the pass succeeded, and the one people
   * page on would be the wrong one.
   */
  test("a failure is recorded and then re-thrown", async () => {
    const job = tracked(
      db,
      "kyc.reconcile",
      async () => {
        throw new Error("vendor timed out");
      },
      () => NOW,
    );

    await expect(job()).rejects.toThrow("vendor timed out");

    const rows = await readHeartbeats(db);
    expect(rows[0]!.lastError).toBe("vendor timed out");
    expect(rows[0]!.lastSuccessAt).toBeNull();
  });

  test("a thrown non-Error is still recorded legibly", async () => {
    const job = tracked(
      db,
      "webhooks.purge",
      async () => {
        throw "just a string";
      },
      () => NOW,
    );

    await expect(job()).rejects.toBeTruthy();

    const rows = await readHeartbeats(db);
    expect(rows[0]!.lastError).toBe("just a string");
  });

  /**
   * If the bookkeeping write itself fails, the original error still has to
   * reach pg-boss. A heartbeat problem must not be able to disguise itself as
   * the job's problem — or worse, replace it.
   */
  test("a failing heartbeat write does not replace the job's error", async () => {
    const broken = {
      transaction: async () => {
        throw new Error("heartbeat table is gone");
      },
    } as unknown as Database;

    const job = tracked(broken, "outbox.drain", async () => {
      throw new Error("the real problem");
    });

    await expect(job()).rejects.toThrow("the real problem");
  });

  test("a success after a failure is recorded as recovery", async () => {
    const failing = tracked(
      db,
      "outbox.drain",
      async () => {
        throw new Error("transient");
      },
      () => NOW,
    );
    await expect(failing()).rejects.toThrow();

    await tracked(db, "outbox.drain", async () => {}, () => NOW)();

    const rows = await readHeartbeats(db);
    expect(rows[0]!.lastError).toBeNull();
    expect(rows[0]!.consecutiveFailures).toBe(0);
    expect(rows[0]!.runs).toBe(2);
  });
});
