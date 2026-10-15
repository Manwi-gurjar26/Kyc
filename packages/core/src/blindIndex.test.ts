import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { BLIND_INDEX_MIN_KEY_BYTES, panBlindIndex } from "./blindIndex.js";

/** 32 bytes, as the secret store would hand us. */
const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);

describe("panBlindIndex", () => {
  test("produces a 64-character hex digest", () => {
    const index = panBlindIndex("ABCPS4412K", KEY);
    expect(index).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is stable — the same PAN always gives the same index", () => {
    expect(panBlindIndex("ABCPS4412K", KEY)).toBe(panBlindIndex("ABCPS4412K", KEY));
  });

  /**
   * This is the property the duplicate check depends on. Two users typing the
   * same PAN differently must collide, or the unique index would not catch
   * them.
   */
  test("normalises before hashing, so formatting does not create a duplicate", () => {
    const canonical = panBlindIndex("ABCPS4412K", KEY);
    expect(panBlindIndex("abcps4412k", KEY)).toBe(canonical);
    expect(panBlindIndex("ABCPS 4412 K", KEY)).toBe(canonical);
    expect(panBlindIndex("  ABCPS-4412-K  ", KEY)).toBe(canonical);
  });

  test("different PANs give different indexes", () => {
    expect(panBlindIndex("ABCPS4412K", KEY)).not.toBe(panBlindIndex("ABCPS4412L", KEY));
  });

  /**
   * Rotating the key must change every index, otherwise a leaked old key would
   * still let someone confirm whether a given PAN is in our database.
   */
  test("a different key gives a different index for the same PAN", () => {
    expect(panBlindIndex("ABCPS4412K", KEY)).not.toBe(
      panBlindIndex("ABCPS4412K", OTHER_KEY),
    );
  });

  /**
   * A plain hash of a PAN is brute-forceable: the format is fixed and the
   * space is small enough to enumerate. The index must be keyed.
   */
  test("is not a plain SHA-256 of the PAN", () => {
    const plain = createHash("sha256").update("ABCPS4412K").digest("hex");
    expect(panBlindIndex("ABCPS4412K", KEY)).not.toBe(plain);
  });

  test("refuses a malformed PAN rather than index garbage", () => {
    expect(() => panBlindIndex("NOTAPAN", KEY)).toThrow(/well-formed PAN/);
  });

  test("refuses a key shorter than the minimum", () => {
    const weak = Buffer.alloc(BLIND_INDEX_MIN_KEY_BYTES - 1, 1);
    expect(() => panBlindIndex("ABCPS4412K", weak)).toThrow(/key/i);
  });

  test("refuses an all-zero key, which is the classic uninitialised secret", () => {
    expect(() => panBlindIndex("ABCPS4412K", Buffer.alloc(32, 0))).toThrow(/key/i);
  });
});
