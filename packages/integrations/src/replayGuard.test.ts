import { describe, expect, test } from "vitest";
import {
  InMemorySeenEventStore,
  ReplayGuard,
  type SeenEventStore,
} from "./replayGuard.js";

const NOW = new Date("2026-10-08T12:00:00.000Z");

function guard(store: SeenEventStore = new InMemorySeenEventStore()): ReplayGuard {
  return new ReplayGuard(store);
}

describe("ReplayGuard", () => {
  test("the first delivery of an event is fresh", async () => {
    const result = await guard().check("hyperverge", "evt_01HQZX", NOW);
    expect(result.fresh).toBe(true);
  });

  test("the same event delivered twice is a replay the second time", async () => {
    const g = guard();
    expect((await g.check("hyperverge", "evt_01HQZX", NOW)).fresh).toBe(true);
    expect((await g.check("hyperverge", "evt_01HQZX", NOW)).fresh).toBe(false);
  });

  test("a third delivery is still a replay", async () => {
    const g = guard();
    await g.check("hyperverge", "evt_01HQZX", NOW);
    await g.check("hyperverge", "evt_01HQZX", NOW);
    expect((await g.check("hyperverge", "evt_01HQZX", NOW)).fresh).toBe(false);
  });

  test("different events are independent", async () => {
    const g = guard();
    expect((await g.check("hyperverge", "evt_A", NOW)).fresh).toBe(true);
    expect((await g.check("hyperverge", "evt_B", NOW)).fresh).toBe(true);
  });

  /**
   * Event ids are only unique within a vendor. A KYC vendor and a KYB vendor
   * both issuing "evt_1" must not make the second one look like a replay of
   * the first.
   */
  test("the same event id from two vendors does not collide", async () => {
    const g = guard();
    expect((await g.check("hyperverge", "evt_1", NOW)).fresh).toBe(true);
    expect((await g.check("signzy", "evt_1", NOW)).fresh).toBe(true);
  });

  test("records an expiry so the table does not grow forever", async () => {
    const store = new InMemorySeenEventStore();
    await guard(store).check("hyperverge", "evt_01HQZX", NOW);

    const expiry = store.expiryOf("hyperverge:evt_01HQZX");
    expect(expiry).toBeInstanceOf(Date);
    expect(expiry!.getTime()).toBeGreaterThan(NOW.getTime());
  });

  test("rejects a blank event id rather than treating it as an event", async () => {
    await expect(guard().check("hyperverge", "", NOW)).rejects.toThrow(/event id/i);
  });

  test("rejects a blank vendor", async () => {
    await expect(guard().check("", "evt_01HQZX", NOW)).rejects.toThrow(/vendor/i);
  });

  /**
   * THE RACE. Vendors retry hard, and two deliveries of the same event can
   * land on two API containers at the same millisecond. A guard built as
   * "has it been seen? no? then remember it" lets both through, and the
   * handler runs twice.
   *
   * Only one of these ten concurrent checks may come back fresh.
   */
  test("only one of many concurrent deliveries is fresh", async () => {
    const g = guard();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => g.check("hyperverge", "evt_race", NOW)),
    );
    expect(results.filter((r) => r.fresh)).toHaveLength(1);
  });

  /**
   * The same race, against a store whose write is deliberately slow. A
   * read-then-write implementation passes the test above by accident on a
   * synchronous store, and fails this one.
   */
  test("stays correct when the store is slow", async () => {
    const slow = new InMemorySeenEventStore({ writeDelayMs: 5 });
    const g = guard(slow);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => g.check("hyperverge", "evt_slow", NOW)),
    );
    expect(results.filter((r) => r.fresh)).toHaveLength(1);
  });
});

describe("InMemorySeenEventStore", () => {
  /**
   * The primitive the guard is built on: one atomic call that both tests and
   * records. In Postgres this is INSERT ... ON CONFLICT DO NOTHING, and the
   * boolean is whether a row was actually inserted.
   */
  test("rememberIfNew returns true only the first time", async () => {
    const store = new InMemorySeenEventStore();
    expect(await store.rememberIfNew("k", NOW)).toBe(true);
    expect(await store.rememberIfNew("k", NOW)).toBe(false);
  });

  test("forgets entries whose expiry has passed", async () => {
    const store = new InMemorySeenEventStore();
    const expiry = new Date(NOW.getTime() + 1000);
    await store.rememberIfNew("k", expiry);

    store.purgeExpired(new Date(expiry.getTime() + 1));
    expect(await store.rememberIfNew("k", expiry)).toBe(true);
  });

  test("keeps entries whose expiry has not passed", async () => {
    const store = new InMemorySeenEventStore();
    const expiry = new Date(NOW.getTime() + 10_000);
    await store.rememberIfNew("k", expiry);

    store.purgeExpired(NOW);
    expect(await store.rememberIfNew("k", expiry)).toBe(false);
  });
});
