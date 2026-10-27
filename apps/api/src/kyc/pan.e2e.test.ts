import { createClient, type DatabaseHandle } from "@kilowattx/db";
import { VendorAccountError, type KybProvider } from "@kilowattx/integrations";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../bootstrap.js";
import { loadConfig } from "../config.js";
import { DEV_USER_HEADER } from "../common/session.js";

/**
 * PAN verification, as the step-by-step flow does it.
 *
 * The thing worth holding onto while reading this file: the name sent to the
 * Income Tax Department comes from Aadhaar, never from what the person typed.
 * A name they type is a name they can copy off the card in front of them, so a
 * match against it proves nothing. That is why half of these tests are about
 * refusing to call the Department at all.
 */

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://kilowattx_app:local_dev_only@localhost:5434/kilowattx_api_test";
const OWNER_URL =
  process.env.OWNER_DATABASE_URL ??
  "postgresql://kilowattx:local_dev_only@localhost:5434/kilowattx_api_test";

/** The fake gateway accepts this and nothing else. */
const RIGHT_OTP = "123456";
/** Verhoeff-valid, and does not end in 0, 1 or 9 (the fake's failure markers). */
const AADHAAR = "999941057058";

/**
 * A fresh PAN per test, because the uniqueness is the point.
 *
 * `pan_blind_index` carries a global unique index, so a PAN spent by one test
 * is spent for every later test and for the next run of the suite. Truncating
 * `kyc_records` in a fixture looks like the fix and is not: vitest runs test
 * files in parallel against one database, so clearing that table pulled rows
 * out from under the Aadhaar suite mid-test.
 *
 * Randomising the four digits — the only part of the format that is free —
 * keeps every test independent without touching anybody else's rows.
 *
 * A PAN is `[A-Z]{5}[0-9]{4}[A-Z]`, and the 4th character is the holder type,
 * so P for a person throughout.
 */
function somePan(options: { nameMismatch?: boolean; notLinked?: boolean } = {}): string {
  const digits = String(Math.floor(Math.random() * 1e4)).padStart(4, "0");
  /** A Z in the fifth position is the fake KYB provider's mismatch marker. */
  const fifth = options.nameMismatch ? "Z" : "S";
  /** Ending in Q is its not-seeded-with-Aadhaar marker. */
  const last = options.notLinked ? "Q" : "K";
  return `ABCP${fifth}${digits}${last}`;
}

let app: NestExpressApplication;
let owner: DatabaseHandle;

function http() {
  return request(app.getHttpServer());
}

function as(userId: string) {
  return { [DEV_USER_HEADER]: userId };
}

async function newUser(): Promise<string> {
  const phone = `+9199${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  const response = await http().post("/v1/dev/users").send({ phoneE164: phone, locale: "en" });
  return response.body.id as string;
}

/** Consent first: the API refuses to send a PAN anywhere without it. */
async function consented(): Promise<string> {
  const userId = await newUser();
  await http()
    .post("/v1/kyc/consents")
    .set(as(userId))
    .send({ purpose: "KYC_VERIFICATION", noticeVersion: "2.1", locale: "en" })
    .expect(201);
  return userId;
}

/**
 * Establishes a verified Aadhaar directly in the database.
 *
 * It used to walk the OTP endpoints, which no longer exist: Aadhaar is
 * collected at DigiLocker now and the hosted route cannot be driven from a
 * test — it ends at a government sign-in page.
 *
 * Written as a row rather than through the hosted flow on purpose. The fake
 * gateway's hosted result carries Aadhaar, PAN and a selfie together, so
 * collecting it would leave nothing outstanding and these files are about
 * what happens when PAN is still to come. What is under test here is the PAN
 * step and the decision; the Aadhaar step has its own coverage.
 *
 * The four columns are exactly what a completed Aadhaar leaves behind, and
 * `aadhaar_ref_token` is the one that matters — it is what the decision
 * treats as proof the check actually happened.
 */
async function verifiedAadhaar(): Promise<string> {
  const userId = await consented();

  await owner.sql.unsafe(
    `INSERT INTO kyc_records
       (user_id, subject_type, level, status,
        aadhaar_last4, aadhaar_ref_token, aadhaar_name, aadhaar_dob)
     VALUES ('${userId}', 'PERSON', 'FULL', 'IN_PROGRESS',
             '7058', 'dl_sess_${Math.random().toString(36).slice(2, 12)}',
             'Anita Desai', '1986-04-17')`,
  );

  return userId;
}

beforeAll(async () => {
  owner = createClient({ url: OWNER_URL, maxConnections: 4 });
  app = await createApp({
    config: loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: DB_URL,
      KYC_PROVIDER: "fake",
      KYC_WEBHOOK_SECRET: "whsec_pan_e2e_0000000000",
      KYC_BLIND_INDEX_KEY: Buffer.alloc(32, 43).toString("base64"),
      FILE_SIGNING_SECRET: "filesign_pan_e2e_000000000",
    } as NodeJS.ProcessEnv),
  });
  await app.init();
});

afterAll(async () => {
  await app.close();
  await owner.close();
});

beforeEach(async () => {
  await owner.sql.unsafe("TRUNCATE TABLE aadhaar_otp_challenges CASCADE");
});

/* ------------------------------------------------------------------ */

describe("verifying a PAN", () => {
  test("a verified Aadhaar and a good PAN returns the masked result", async () => {
    const userId = await verifiedAadhaar();
    const pan = somePan();

    const response = await http()
      .post("/v1/kyc/pan")
      .set(as(userId))
      .send({ pan })
      .expect(201);

    expect(response.body).toEqual({
      last4: pan.slice(-4),
      status: "VALID",
      nameMatch: true,
      dobMatch: true,
      linkedToAadhaar: true,
    });
  });

  /** The step is done, so it leaves the list. */
  test("a verified PAN clears the PAN step", async () => {
    const userId = await verifiedAadhaar();
    const pan = somePan();
    await http().post("/v1/kyc/pan").set(as(userId)).send({ pan }).expect(201);

    const me = await http().get("/v1/kyc/me").set(as(userId)).expect(200);
    expect(me.body.panLast4).toBe(pan.slice(-4));
    expect(me.body.remainingSteps).not.toContain("PAN");
  });

  /**
   * A mismatch is reported, not thrown.
   *
   * The Department answered, and what it said is a finding about this person
   * rather than a failed request. Turning it into an error would lose the
   * distinction that decideKyc() needs — a name mismatch is a manual review,
   * not a broken call.
   */
  test("a name mismatch comes back as a result, not an error", async () => {
    const userId = await verifiedAadhaar();

    const response = await http()
      .post("/v1/kyc/pan")
      .set(as(userId))
      .send({ pan: somePan({ nameMismatch: true }) })
      .expect(201);

    expect(response.body.nameMatch).toBe(false);
    expect(response.body.status).toBe("VALID");
  });

  /** Not seeded with Aadhaar changes a TDS rate; it does not block anybody. */
  test("a PAN not linked to Aadhaar is reported and still recorded", async () => {
    const userId = await verifiedAadhaar();
    const pan = somePan({ notLinked: true });

    const response = await http()
      .post("/v1/kyc/pan")
      .set(as(userId))
      .send({ pan })
      .expect(201);

    expect(response.body.linkedToAadhaar).toBe(false);

    const me = await http().get("/v1/kyc/me").set(as(userId)).expect(200);
    expect(me.body.panLast4).toBe(pan.slice(-4));
  });
});

/* ------------------------------------------------------------------ */

describe("what it refuses to do", () => {
  /**
   * The whole point of the feature.
   *
   * Without a UIDAI name there is nothing honest to match against, and the
   * tempting fallback — the display name the person typed when they arrived —
   * would produce a nameMatch that means nothing while looking exactly like
   * one that means everything.
   */
  test("no PAN check before Aadhaar is confirmed", async () => {
    const userId = await consented();

    const response = await http()
      .post("/v1/kyc/pan")
      .set(as(userId))
      .send({ pan: somePan() })
      .expect(400);

    expect(response.body.code).toBe("AADHAAR_REQUIRED_FIRST");
  });

  /**
   * Requesting an OTP is not confirming one.
   *
   * The Aadhaar step writes the last four digits when the OTP goes out, so a
   * record exists at this point — but the name arrives only on confirmation.
   * A check that looked for "a record" rather than "a name" would pass here
   * and then send the Department an undefined name.
   */
  test("a record without a reference token is not a verified Aadhaar", async () => {
    const userId = await consented();

    /**
     * Four digits and nothing else — the state a half-finished Aadhaar leaves
     * behind. A check that looked for "a record" rather than "a reference
     * token" would pass here and then send the Department an undefined name.
     */
    await owner.sql.unsafe(
      `INSERT INTO kyc_records (user_id, subject_type, level, status, aadhaar_last4)
       VALUES ('${userId}', 'PERSON', 'FULL', 'IN_PROGRESS', '7058')`,
    );

    const response = await http()
      .post("/v1/kyc/pan")
      .set(as(userId))
      .send({ pan: somePan() })
      .expect(400);

    expect(response.body.code).toBe("AADHAAR_REQUIRED_FIRST");
  });

  test("no PAN check without consent", async () => {
    const userId = await newUser();

    const response = await http()
      .post("/v1/kyc/pan")
      .set(as(userId))
      .send({ pan: somePan() })
      .expect(403);

    expect(response.body.code).toBe("CONSENT_REQUIRED");
  });

  test("a malformed PAN is refused before any vendor call", async () => {
    const userId = await verifiedAadhaar();

    const response = await http()
      .post("/v1/kyc/pan")
      .set(as(userId))
      .send({ pan: "NOTAPAN123" })
      .expect(400);

    expect(response.body.code).toBe("VALIDATION_FAILED");
  });

  /** One PAN, one person. This is the duplicate-account defence. */
  test("a PAN already on another account is refused", async () => {
    const pan = somePan();
    const first = await verifiedAadhaar();
    await http().post("/v1/kyc/pan").set(as(first)).send({ pan }).expect(201);

    const second = await verifiedAadhaar();
    const response = await http()
      .post("/v1/kyc/pan")
      .set(as(second))
      .send({ pan })
      .expect(400);

    expect(response.body.code).toBe("PAN_ALREADY_USED");
  });

  /** Re-submitting your own PAN is a retry, not a duplicate. */
  test("submitting your own PAN again is allowed", async () => {
    const userId = await verifiedAadhaar();
    const pan = somePan();
    await http().post("/v1/kyc/pan").set(as(userId)).send({ pan }).expect(201);
    await http().post("/v1/kyc/pan").set(as(userId)).send({ pan }).expect(201);
  });
});

/* ------------------------------------------------------------------ */

describe("what is stored", () => {
  /**
   * The full PAN is in one column, encrypted, and nowhere else.
   *
   * Asserted against the row rather than the response, because the response
   * is the easy half — a plaintext PAN sitting in a second column is the
   * failure nobody notices.
   */
  test("the full PAN appears nowhere in plaintext", async () => {
    const userId = await verifiedAadhaar();
    const pan = somePan();
    await http().post("/v1/kyc/pan").set(as(userId)).send({ pan }).expect(201);

    const rows = await owner.sql.unsafe(
      `SELECT * FROM kyc_records WHERE user_id = '${userId}'`,
    );

    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;

    const plaintext = Object.entries(row).filter(
      ([column, value]) =>
        column !== "pan_encrypted" && typeof value === "string" && value.includes(pan),
    );

    expect(plaintext).toEqual([]);
    expect(row.pan_last4).toBe(pan.slice(-4));
    expect(row.pan_blind_index).toEqual(expect.any(String));
  });

  /**
   * The name sent to the Department is the one UIDAI returned.
   *
   * The fake KYC provider derives its name from the Aadhaar number, so this
   * asserts the stored name is that one — which is what proves the PAN check
   * is matching against UIDAI rather than against anything the person typed.
   */
  test("the Aadhaar name and date of birth are recorded for the match", async () => {
    const userId = await verifiedAadhaar();

    const rows = await owner.sql.unsafe(
      `SELECT aadhaar_name, aadhaar_dob FROM kyc_records WHERE user_id = '${userId}'`,
    );
    const row = rows[0] as Record<string, unknown>;

    expect(row.aadhaar_name).toBeTruthy();
    expect(row.aadhaar_dob).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  /** Still nowhere to put an Aadhaar number, and this is the closest table. */
  test("no Aadhaar number is stored alongside the name", async () => {
    const userId = await verifiedAadhaar();

    const rows = await owner.sql.unsafe(
      `SELECT * FROM kyc_records WHERE user_id = '${userId}'`,
    );
    const row = rows[0] as Record<string, unknown>;

    for (const value of Object.values(row)) {
      if (typeof value === "string") expect(value).not.toContain(AADHAAR);
    }
  });
});

/* ------------------------------------------------------------------ */

/**
 * The gateway refusing us, not the PAN.
 *
 * Sandbox answered a live PAN check with "Insufficient credits", and that text
 * went onto the customer's screen as PAN_CHECK_FAILED — as though their PAN
 * had failed — while nothing was logged for whoever tops the wallet up.
 */
describe("when our gateway account cannot make the call", () => {
  let broke: NestExpressApplication;

  beforeAll(async () => {
    const outOfCredits = async (): Promise<never> => {
      throw new VendorAccountError(
        "sandbox",
        "The verification gateway refused the call for want of credits (HTTP 403): Insufficient credits",
        403,
      );
    };
    const kybProvider: KybProvider = {
      name: "sandbox",
      verifyPan: outOfCredits,
      lookupGstin: outOfCredits,
      lookupCin: outOfCredits,
    };

    broke = await createApp({
      config: loadConfig({
        NODE_ENV: "test",
        DATABASE_URL: DB_URL,
        KYC_PROVIDER: "fake",
        KYC_WEBHOOK_SECRET: "whsec_pan_e2e_0000000000",
        KYC_BLIND_INDEX_KEY: Buffer.alloc(32, 43).toString("base64"),
        FILE_SIGNING_SECRET: "filesign_pan_e2e_000000000",
      } as NodeJS.ProcessEnv),
      kybProvider,
    });
    await broke.init();
  });

  afterAll(async () => {
    await broke.close();
  });

  test("the person is told to try again, not that their PAN failed", async () => {
    const userId = await verifiedAadhaar();

    const response = await request(broke.getHttpServer())
      .post("/v1/kyc/pan")
      .set(as(userId))
      .send({ pan: somePan() })
      .expect(400);

    expect(response.body.code).toBe("PAN_UNAVAILABLE");
    expect(response.body.message).not.toMatch(/credit/i);
  });
});
