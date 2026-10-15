import { DEFAULT_KYC_THRESHOLDS } from "@kilowattx/core";
import { createClient, type Database, type DatabaseHandle } from "@kilowattx/db";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { THRESHOLD_SETTING_PREFIX, loadThresholds } from "./thresholds.js";

/**
 * The thresholds Ops can retune without a release.
 *
 * One loader, used by the API on a webhook and by the worker when
 * reconciliation heals a case. Two copies would mean the same case got a
 * different answer depending on which path reached it — the bug this replaces,
 * where the worker used the compiled defaults and the API read the table.
 *
 * The important behaviour is not reading a number. It is refusing a number
 * that would quietly disable a check: a face-match threshold of 0 passes every
 * face, and somebody typing 75 for "75%" is a far likelier accident than
 * somebody meaning it.
 */

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://kilowattx_app:local_dev_only@localhost:5434/kilowattx_pipeline_test";
const OWNER_URL =
  process.env.OWNER_DATABASE_URL ??
  "postgresql://kilowattx:local_dev_only@localhost:5434/kilowattx_pipeline_test";

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
  await owner.sql.unsafe(`TRUNCATE TABLE settings`);
});

async function set(key: string, value: unknown): Promise<void> {
  await owner.sql`
    INSERT INTO settings (key, value) VALUES (
      ${`${THRESHOLD_SETTING_PREFIX}${key}`}, ${JSON.stringify(value)}::jsonb
    )
  `;
}

/* ------------------------------------------------------------------ */

describe("an empty settings table", () => {
  test("falls back to the compiled defaults", async () => {
    const { thresholds } = await loadThresholds(db);
    expect(thresholds).toEqual(DEFAULT_KYC_THRESHOLDS);
  });

  test("reports nothing wrong, because nothing is", async () => {
    const { rejected } = await loadThresholds(db);
    expect(rejected).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */

describe("reading an override", () => {
  test("a stricter face-match bar is used", async () => {
    await set("faceMatch", 0.88);

    const { thresholds } = await loadThresholds(db);
    expect(thresholds.faceMatch).toBe(0.88);
  });

  test("the other thresholds keep their defaults", async () => {
    await set("faceMatch", 0.88);

    const { thresholds } = await loadThresholds(db);
    expect(thresholds.nameMatch).toBe(DEFAULT_KYC_THRESHOLDS.nameMatch);
  });

  test("a value stored as a JSON string is still read", async () => {
    /** Ops editing a row by hand types a string more often than not. */
    await set("nameMatch", "0.8");

    const { thresholds } = await loadThresholds(db);
    expect(thresholds.nameMatch).toBe(0.8);
  });

  test("every threshold can be overridden", async () => {
    await set("faceMatch", 0.8);
    await set("nameMatch", 0.7);
    await set("documentConfidence", 0.9);
    await set("maxLowConfidenceFields", 3);
    await set("minimumAge", 21);

    const { thresholds } = await loadThresholds(db);
    expect(thresholds).toEqual({
      faceMatch: 0.8,
      nameMatch: 0.7,
      documentConfidence: 0.9,
      maxLowConfidenceFields: 3,
      minimumAge: 21,
    });
  });
});

/* ------------------------------------------------------------------ */

describe("refusing a value that would disable a check", () => {
  /**
   * The one that matters. A face-match threshold of zero means every face
   * passes, including a photograph of a photograph — the check would still
   * appear in the audit trail, reporting success, having tested nothing.
   */
  test("a score threshold of zero is refused", async () => {
    await set("faceMatch", 0);

    const { thresholds, rejected } = await loadThresholds(db);
    expect(thresholds.faceMatch).toBe(DEFAULT_KYC_THRESHOLDS.faceMatch);
    expect(rejected.map((r) => r.key)).toContain("faceMatch");
  });

  /**
   * 75 meaning "75%". A likelier accident than somebody meaning 7500%, and
   * silently impossible to satisfy — every single case would go to review.
   */
  test("a score above one is refused", async () => {
    await set("faceMatch", 75);

    const { thresholds, rejected } = await loadThresholds(db);
    expect(thresholds.faceMatch).toBe(DEFAULT_KYC_THRESHOLDS.faceMatch);
    expect(rejected[0]!.reason).toMatch(/between/i);
  });

  test("a negative score is refused", async () => {
    await set("nameMatch", -0.5);

    const { thresholds } = await loadThresholds(db);
    expect(thresholds.nameMatch).toBe(DEFAULT_KYC_THRESHOLDS.nameMatch);
  });

  test("text where a number belongs is refused, not read as zero", async () => {
    await set("documentConfidence", "quite high");

    const { thresholds, rejected } = await loadThresholds(db);
    expect(thresholds.documentConfidence).toBe(
      DEFAULT_KYC_THRESHOLDS.documentConfidence,
    );
    expect(rejected.map((r) => r.key)).toContain("documentConfidence");
  });

  test("null is refused rather than coerced", async () => {
    await set("faceMatch", null);

    const { thresholds } = await loadThresholds(db);
    expect(thresholds.faceMatch).toBe(DEFAULT_KYC_THRESHOLDS.faceMatch);
  });

  /**
   * An empty string coerces to 0 in JavaScript, which is exactly the value
   * that disables a check. It has to be caught before the comparison.
   */
  test("an empty string is refused rather than coerced to zero", async () => {
    await set("faceMatch", "");

    const { thresholds, rejected } = await loadThresholds(db);
    expect(thresholds.faceMatch).toBe(DEFAULT_KYC_THRESHOLDS.faceMatch);
    expect(rejected.map((r) => r.key)).toContain("faceMatch");
  });

  test("a fractional count of fields is refused", async () => {
    await set("maxLowConfidenceFields", 1.5);

    const { thresholds } = await loadThresholds(db);
    expect(thresholds.maxLowConfidenceFields).toBe(
      DEFAULT_KYC_THRESHOLDS.maxLowConfidenceFields,
    );
  });

  /** Tolerating every field being illegible is tolerating no OCR at all. */
  test("an absurd count of tolerated fields is refused", async () => {
    await set("maxLowConfidenceFields", 500);

    const { thresholds } = await loadThresholds(db);
    expect(thresholds.maxLowConfidenceFields).toBe(
      DEFAULT_KYC_THRESHOLDS.maxLowConfidenceFields,
    );
  });

  /**
   * A minimum age of zero would let a child be onboarded. Under 18 is not a
   * tunable business preference — it is the law the guide cites.
   */
  test("a minimum age below eighteen is refused", async () => {
    await set("minimumAge", 15);

    const { thresholds, rejected } = await loadThresholds(db);
    expect(thresholds.minimumAge).toBe(DEFAULT_KYC_THRESHOLDS.minimumAge);
    expect(rejected.map((r) => r.key)).toContain("minimumAge");
  });

  test("a minimum age above eighteen is allowed", async () => {
    await set("minimumAge", 21);

    const { thresholds } = await loadThresholds(db);
    expect(thresholds.minimumAge).toBe(21);
  });

  /** A bad setting must not take the good ones down with it. */
  test("one bad value does not discard the others", async () => {
    await set("faceMatch", 0);
    await set("nameMatch", 0.82);

    const { thresholds, rejected } = await loadThresholds(db);
    expect(thresholds.nameMatch).toBe(0.82);
    expect(thresholds.faceMatch).toBe(DEFAULT_KYC_THRESHOLDS.faceMatch);
    expect(rejected).toHaveLength(1);
  });

  /**
   * Every rejection is reported with the value that caused it. A threshold
   * silently ignored is worse than one that was never set: Ops would believe
   * the new bar was in force.
   */
  test("a rejection names the key, the value and the reason", async () => {
    await set("faceMatch", 75);

    const { rejected } = await loadThresholds(db);
    expect(rejected[0]).toMatchObject({ key: "faceMatch" });
    expect(String(rejected[0]!.value)).toContain("75");
    expect(rejected[0]!.reason.length).toBeGreaterThan(10);
  });
});

/* ------------------------------------------------------------------ */

describe("settings that are not thresholds", () => {
  test("an unrelated setting is ignored", async () => {
    await owner.sql`
      INSERT INTO settings (key, value)
      VALUES ('notifications.whatsapp.enabled', 'true'::jsonb)
    `;

    const { thresholds, rejected } = await loadThresholds(db);
    expect(thresholds).toEqual(DEFAULT_KYC_THRESHOLDS);
    expect(rejected).toEqual([]);
  });

  /**
   * A typo in a key is not an override. Treating `kyc.threshold.facematch` as
   * faceMatch would mean a setting nobody can find is in force.
   */
  test("a misspelled threshold key is ignored rather than guessed at", async () => {
    await owner.sql`
      INSERT INTO settings (key, value)
      VALUES ('kyc.threshold.facematch', '0.1'::jsonb)
    `;

    const { thresholds } = await loadThresholds(db);
    expect(thresholds.faceMatch).toBe(DEFAULT_KYC_THRESHOLDS.faceMatch);
  });
});
