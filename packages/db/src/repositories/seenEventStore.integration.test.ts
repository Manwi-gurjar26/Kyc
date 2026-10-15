import { ReplayGuard } from "@kilowattx/integrations";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { DatabaseHandle } from "../client.js";
import { countOf, openOwnerDatabase, openTestDatabase, resetTables } from "../testing/harness.js";
import { PostgresSeenEventStore } from "./seenEventStore.js";

/**
 * Replay protection, against a real database.
 *
 * The in-memory test for this proved atomicity with respect to the event
 * loop, which is a weaker claim than it sounds: a single-threaded store is
 * atomic for free. The claim that matters is that two separate Postgres
 * sessions — standing in for two API containers — cannot both win. Only the
 * database's unique index can provide that, so only a real database can test
 * it.
 */

const NOW = new Date("2026-10-09T09:00:00.000Z");

let app: DatabaseHandle;
let owner: DatabaseHandle;
let store: PostgresSeenEventStore;

beforeAll(() => {
  app = openTestDatabase();
  owner = openOwnerDatabase();
  store = new PostgresSeenEventStore(app.sql);
});

afterAll(async () => {
  await app.close();
  await owner.close();
});

beforeEach(async () => {
  await resetTables(owner);
});

describe("PostgresSeenEventStore", () => {
  test("records a key the first time", async () => {
    expect(await store.rememberIfNew("hyperverge:evt_1", NOW)).toBe(true);
  });

  test("refuses the same key the second time", async () => {
    await store.rememberIfNew("hyperverge:evt_1", NOW);
    expect(await store.rememberIfNew("hyperverge:evt_1", NOW)).toBe(false);
  });

  test("stores exactly one row for a repeated key", async () => {
    await store.rememberIfNew("hyperverge:evt_1", NOW);
    await store.rememberIfNew("hyperverge:evt_1", NOW);
    await store.rememberIfNew("hyperverge:evt_1", NOW);
    expect(await countOf(owner, "seen_webhook_events")).toBe(1);
  });

  test("different keys are independent", async () => {
    expect(await store.rememberIfNew("hyperverge:evt_1", NOW)).toBe(true);
    expect(await store.rememberIfNew("signzy:evt_1", NOW)).toBe(true);
    expect(await countOf(owner, "seen_webhook_events")).toBe(2);
  });

  /**
   * THE TEST THIS FILE EXISTS FOR.
   *
   * Twenty concurrent inserts from a connection pool, so genuinely different
   * Postgres backends racing for the same primary key. Exactly one may win.
   *
   * A read-then-write implementation passes the in-memory version of this test
   * and fails here, which is the whole point of running it against a real
   * database.
   */
  test("only one of twenty concurrent sessions wins", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.rememberIfNew("hyperverge:evt_race", NOW)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await countOf(owner, "seen_webhook_events")).toBe(1);
  });

  test("concurrent inserts of distinct keys all win", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.rememberIfNew(`hyperverge:evt_${i}`, NOW),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(20);
    expect(await countOf(owner, "seen_webhook_events")).toBe(20);
  });

  test("records the expiry it was given", async () => {
    const expiry = new Date(NOW.getTime() + 7 * 24 * 3600 * 1000);
    await store.rememberIfNew("hyperverge:evt_1", expiry);

    const rows = await owner.sql<{ expires_at: string }[]>`
      SELECT expires_at FROM seen_webhook_events WHERE key = 'hyperverge:evt_1'
    `;
    expect(new Date(rows[0]!.expires_at).getTime()).toBe(expiry.getTime());
  });

  test("purges only the entries that have expired", async () => {
    await store.rememberIfNew("old", new Date(NOW.getTime() - 1000));
    await store.rememberIfNew("fresh", new Date(NOW.getTime() + 86_400_000));

    const removed = await store.purgeExpired(NOW);
    expect(removed).toBe(1);
    expect(await countOf(owner, "seen_webhook_events")).toBe(1);
  });
});

/**
 * The guard and the store together, which is how the webhook handler uses
 * them.
 */
describe("ReplayGuard over the Postgres store", () => {
  test("the first delivery is fresh and the retry is not", async () => {
    const guard = new ReplayGuard(store);

    expect((await guard.check("hyperverge", "evt_01HQZX", NOW)).fresh).toBe(true);
    expect((await guard.check("hyperverge", "evt_01HQZX", NOW)).fresh).toBe(false);
  });

  test("two vendors using the same event id do not collide", async () => {
    const guard = new ReplayGuard(store);

    expect((await guard.check("hyperverge", "evt_1", NOW)).fresh).toBe(true);
    expect((await guard.check("signzy", "evt_1", NOW)).fresh).toBe(true);
  });

  test("ten concurrent deliveries of one retried event yield one winner", async () => {
    const guard = new ReplayGuard(store);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => guard.check("hyperverge", "evt_retried", NOW)),
    );
    expect(results.filter((r) => r.fresh)).toHaveLength(1);
  });
});
