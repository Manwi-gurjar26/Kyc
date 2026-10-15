import { createClient, type Database, type DatabaseHandle } from "@kilowattx/db";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  JOB_STALENESS_SECONDS,
  readHeartbeats,
  recordHeartbeat,
  staleJobs,
} from "./heartbeat.js";

/**
 * Proof that a job is still running.
 *
 * The problem this solves is the second half of the old comment on the
 * setInterval loops: "if the process dies, nothing runs, and nothing tells
 * you". pg-boss fixes the first half. Nothing fixes the second half by itself,
 * because the failure is an absence — no error, no log line, no alert, just a
 * job that silently stopped happening.
 *
 * So each pass writes down that it finished. "When did reconciliation last
 * complete?" then has an answer that is a fact rather than a silence, and the
 * alert is a query anybody can run.
 */

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://kilowattx_app:local_dev_only@localhost:5434/kilowattx_worker_test";
const OWNER_URL =
  process.env.OWNER_DATABASE_URL ??
  "postgresql://kilowattx:local_dev_only@localhost:5434/kilowattx_worker_test";

const NOW = new Date("2026-10-14T12:00:00.000Z");

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

const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

/* ------------------------------------------------------------------ */

describe("recording a pass", () => {
  test("a completed pass is written down", async () => {
    await recordHeartbeat(db, { job: "outbox.drain", now: NOW, ok: true });

    const rows = await readHeartbeats(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.job).toBe("outbox.drain");
    expect(rows[0]!.lastSuccessAt).toEqual(NOW);
  });

  test("a second pass replaces the first rather than piling up", async () => {
    await recordHeartbeat(db, { job: "outbox.drain", now: ago(600), ok: true });
    await recordHeartbeat(db, { job: "outbox.drain", now: NOW, ok: true });

    const rows = await readHeartbeats(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lastSuccessAt).toEqual(NOW);
  });

  test("passes are counted, so a job doing nothing is distinguishable from one not running", async () => {
    await recordHeartbeat(db, { job: "outbox.drain", now: ago(120), ok: true });
    await recordHeartbeat(db, { job: "outbox.drain", now: ago(60), ok: true });
    await recordHeartbeat(db, { job: "outbox.drain", now: NOW, ok: true });

    const rows = await readHeartbeats(db);
    expect(rows[0]!.runs).toBe(3);
  });

  /**
   * A failing pass still proves the job is alive, which is a different fact
   * from the job succeeding. Both are recorded, because a job that has been
   * failing for an hour and a job that has not run for an hour need different
   * people woken up.
   */
  test("a failed pass updates the attempt but not the success", async () => {
    await recordHeartbeat(db, { job: "kyc.reconcile", now: ago(300), ok: true });
    await recordHeartbeat(db, {
      job: "kyc.reconcile",
      now: NOW,
      ok: false,
      error: "connection reset",
    });

    const rows = await readHeartbeats(db);
    expect(rows[0]!.lastRunAt).toEqual(NOW);
    expect(rows[0]!.lastSuccessAt).toEqual(ago(300));
    expect(rows[0]!.lastError).toBe("connection reset");
  });

  test("a success after a failure clears the error", async () => {
    await recordHeartbeat(db, {
      job: "kyc.reconcile",
      now: ago(60),
      ok: false,
      error: "connection reset",
    });
    await recordHeartbeat(db, { job: "kyc.reconcile", now: NOW, ok: true });

    const rows = await readHeartbeats(db);
    expect(rows[0]!.lastError).toBeNull();
    expect(rows[0]!.consecutiveFailures).toBe(0);
  });

  test("consecutive failures are counted", async () => {
    for (const seconds of [180, 120, 60]) {
      await recordHeartbeat(db, {
        job: "kyc.reconcile",
        now: ago(seconds),
        ok: false,
        error: "still broken",
      });
    }

    const rows = await readHeartbeats(db);
    expect(rows[0]!.consecutiveFailures).toBe(3);
  });

  test("each job is tracked separately", async () => {
    await recordHeartbeat(db, { job: "outbox.drain", now: NOW, ok: true });
    await recordHeartbeat(db, { job: "webhooks.purge", now: NOW, ok: true });

    expect(await readHeartbeats(db)).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */

describe("noticing that a job has stopped", () => {
  test("a job that ran recently is not stale", async () => {
    await recordHeartbeat(db, { job: "outbox.drain", now: ago(30), ok: true });

    /**
     * Asserted on this job, not on an empty list. The other two have never
     * run in this test and are correctly reported — which is the behaviour
     * the "never run" test below exists for.
     */
    const stale = await staleJobs(db, NOW);
    expect(stale.map((s) => s.job)).not.toContain("outbox.drain");
  });

  test("with every job reporting, nothing is stale", async () => {
    for (const job of Object.keys(JOB_STALENESS_SECONDS)) {
      await recordHeartbeat(db, { job, now: ago(30), ok: true });
    }

    expect(await staleJobs(db, NOW)).toEqual([]);
  });

  test("a job past its tolerance is reported", async () => {
    const tolerance = JOB_STALENESS_SECONDS["outbox.drain"]!;
    await recordHeartbeat(db, {
      job: "outbox.drain",
      now: ago(tolerance + 60),
      ok: true,
    });

    const stale = await staleJobs(db, NOW);
    expect(stale.map((s) => s.job)).toContain("outbox.drain");
  });

  /**
   * The case that matters most and is easiest to miss: a job that has never
   * run at all. An empty table is not "everything is fine", it is "nothing has
   * started" — and a check that only looks at rows it finds would report
   * silence as health.
   */
  test("a job that has never run is reported, not assumed healthy", async () => {
    const stale = await staleJobs(db, NOW);

    expect(stale.map((s) => s.job).sort()).toEqual(
      Object.keys(JOB_STALENESS_SECONDS).sort(),
    );
    expect(stale.every((s) => s.lastSuccessAt === null)).toBe(true);
  });

  /**
   * Still failing is still stale. A job that runs every minute and fails every
   * minute has a fresh attempt and a stale success, and it is the success that
   * matters — nothing is getting done.
   */
  test("a job that keeps failing is stale even though it keeps running", async () => {
    const tolerance = JOB_STALENESS_SECONDS["kyc.reconcile"]!;

    await recordHeartbeat(db, {
      job: "kyc.reconcile",
      now: ago(tolerance + 60),
      ok: true,
    });
    await recordHeartbeat(db, { job: "kyc.reconcile", now: ago(5), ok: false });

    const stale = await staleJobs(db, NOW);
    expect(stale.map((s) => s.job)).toContain("kyc.reconcile");
  });

  test("the report says how long it has been and what the last error was", async () => {
    await recordHeartbeat(db, { job: "outbox.drain", now: ago(3600), ok: true });
    await recordHeartbeat(db, {
      job: "outbox.drain",
      now: ago(10),
      ok: false,
      error: "deadlock detected",
    });

    const stale = await staleJobs(db, NOW);
    const outbox = stale.find((s) => s.job === "outbox.drain")!;

    expect(outbox.secondsSinceSuccess).toBe(3600);
    expect(outbox.lastError).toBe("deadlock detected");
  });

  /**
   * The tolerances have to be looser than the schedules, or every alert fires
   * on the first slightly-late pass and gets ignored.
   */
  test("every tolerance is looser than the interval it covers", () => {
    expect(JOB_STALENESS_SECONDS["outbox.drain"]).toBeGreaterThan(60);
    expect(JOB_STALENESS_SECONDS["kyc.reconcile"]).toBeGreaterThan(300);
    expect(JOB_STALENESS_SECONDS["webhooks.purge"]).toBeGreaterThan(3600);
  });
});
