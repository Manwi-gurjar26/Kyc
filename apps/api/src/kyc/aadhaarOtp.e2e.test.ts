import { createClient, type DatabaseHandle } from "@kilowattx/db";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../bootstrap.js";
import { loadConfig } from "../config.js";
import { DEV_USER_HEADER } from "../common/session.js";

/**
 * The Aadhaar OTP challenge, now that it lives in Postgres.
 *
 * This file exists because of one bug. The gateway's reference id was held in
 * a module-level variable in the web app — a single variable shared by every
 * request the process served. Two people verifying at the same moment
 * overwrote each other, and the second person's OTP was checked against the
 * first person's challenge. That is two strangers' identities crossing on one
 * server, not a scaling problem for later.
 *
 * The first test here is that one, written as two people interleaving.
 */

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://kilowattx_app:local_dev_only@localhost:5434/kilowattx_api_test";
const OWNER_URL =
  process.env.OWNER_DATABASE_URL ??
  "postgresql://kilowattx:local_dev_only@localhost:5434/kilowattx_api_test";

/** The fake gateway accepts this and nothing else. */
const RIGHT_OTP = "123456";
const WRONG_OTP = "000000";
/** Verhoeff-valid, and does not end in 0, 1 or 9 (the fake's failure markers). */
const AADHAAR = "999941057058";
/** Verhoeff-valid, ending in 9: the fake's gateway-outage marker on verify. */
const AADHAAR_GATEWAY_DOWN = "975810150919";

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

/** Consent first: the API refuses to send an Aadhaar anywhere without it. */
async function consented(): Promise<string> {
  const userId = await newUser();
  await http()
    .post("/v1/kyc/consents")
    .set(as(userId))
    .send({ purpose: "KYC_VERIFICATION", noticeVersion: "2.1", locale: "en" })
    .expect(201);
  return userId;
}

beforeAll(async () => {
  owner = createClient({ url: OWNER_URL, maxConnections: 4 });
  app = await createApp({
    config: loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: DB_URL,
      KYC_PROVIDER: "fake",
      KYC_WEBHOOK_SECRET: "whsec_aadhaarotp_e2e_000",
      KYC_BLIND_INDEX_KEY: Buffer.alloc(32, 41).toString("base64"),
      FILE_SIGNING_SECRET: "filesign_aadhaarotp_e2e_00000",
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

describe("two people verifying at the same time", () => {
  /**
   * The bug, written down. Both request an OTP, then both confirm — in the
   * order that previously broke it, where the second request overwrote the
   * first person's reference before the first person got to use it.
   */
  test("each person verifies against their own challenge", async () => {
    const alice = await consented();
    const bob = await consented();

    await http().post("/v1/kyc/aadhaar/otp").set(as(alice)).send({ aadhaarNumber: AADHAAR }).expect(201);
    await http().post("/v1/kyc/aadhaar/otp").set(as(bob)).send({ aadhaarNumber: AADHAAR }).expect(201);

    /** Alice goes second, after Bob's request would have clobbered hers. */
    await http().post("/v1/kyc/aadhaar/verify").set(as(bob)).send({ otp: RIGHT_OTP }).expect(201);
    await http().post("/v1/kyc/aadhaar/verify").set(as(alice)).send({ otp: RIGHT_OTP }).expect(201);

    /** And each record carries its own result. */
    for (const userId of [alice, bob]) {
      const me = await http().get("/v1/kyc/me").set(as(userId)).expect(200);
      expect(me.body.aadhaarLast4).toBe(AADHAAR.slice(-4));
    }
  });

  /**
   * The reference id must never reach the browser.
   *
   * While the client supplied it, the client chose which challenge to verify
   * against. Nothing in the response may hand that back.
   */
  test("the gateway reference is never returned to the client", async () => {
    const userId = await consented();

    const response = await http()
      .post("/v1/kyc/aadhaar/otp")
      .set(as(userId))
      .send({ aadhaarNumber: AADHAAR })
      .expect(201);

    const body = JSON.stringify(response.body);
    expect(body).not.toMatch(/reference/i);
    expect(response.body.sentTo).toMatch(/^X+\d{4}$/);
  });
});

/* ------------------------------------------------------------------ */

describe("the challenge is server state, not client state", () => {
  test("confirming without having asked is refused", async () => {
    const userId = await consented();

    const response = await http()
      .post("/v1/kyc/aadhaar/verify")
      .set(as(userId))
      .send({ otp: RIGHT_OTP })
      .expect(400);

    expect(response.body.code).toBe("NO_OTP_REQUESTED");
  });

  test("one person cannot use another person's live challenge", async () => {
    const alice = await consented();
    const bob = await consented();

    await http().post("/v1/kyc/aadhaar/otp").set(as(alice)).send({ aadhaarNumber: AADHAAR }).expect(201);

    /** Bob never asked for one, so there is nothing for him to ride on. */
    const response = await http()
      .post("/v1/kyc/aadhaar/verify")
      .set(as(bob))
      .send({ otp: RIGHT_OTP })
      .expect(400);

    expect(response.body.code).toBe("NO_OTP_REQUESTED");
  });

  /** Spent challenges must not be replayable. */
  test("a challenge cannot be used twice", async () => {
    const userId = await consented();

    await http().post("/v1/kyc/aadhaar/otp").set(as(userId)).send({ aadhaarNumber: AADHAAR }).expect(201);
    await http().post("/v1/kyc/aadhaar/verify").set(as(userId)).send({ otp: RIGHT_OTP }).expect(201);

    const again = await http()
      .post("/v1/kyc/aadhaar/verify")
      .set(as(userId))
      .send({ otp: RIGHT_OTP })
      .expect(400);

    expect(again.body.code).toBe("NO_OTP_REQUESTED");
  });
});

/* ------------------------------------------------------------------ */

describe("guessing the OTP", () => {
  /**
   * Six digits is a million values, which is nothing to a script. The gateway
   * limits on its side; this is the half we control, and it is enforced by
   * counting the attempt BEFORE the gateway is called — a wrong OTP that
   * threw on the way out would otherwise never be counted at all.
   */
  test("three wrong attempts end the challenge", async () => {
    const userId = await consented();
    await http().post("/v1/kyc/aadhaar/otp").set(as(userId)).send({ aadhaarNumber: AADHAAR }).expect(201);

    for (let i = 0; i < 3; i++) {
      const response = await http()
        .post("/v1/kyc/aadhaar/verify")
        .set(as(userId))
        .send({ otp: WRONG_OTP })
        .expect(400);
      expect(response.body.code).toBe("AADHAAR_CHECK_FAILED");
    }

    /** The fourth is refused by us, without troubling the gateway. */
    const blocked = await http()
      .post("/v1/kyc/aadhaar/verify")
      .set(as(userId))
      .send({ otp: WRONG_OTP })
      .expect(400);
    expect(blocked.body.code).toBe("TOO_MANY_ATTEMPTS");

    /** And the right OTP no longer helps — the challenge is gone. */
    const after = await http()
      .post("/v1/kyc/aadhaar/verify")
      .set(as(userId))
      .send({ otp: RIGHT_OTP })
      .expect(400);
    expect(after.body.code).toBe("NO_OTP_REQUESTED");
  });

  /**
   * A gateway that never looked at the OTP has not used up a try.
   *
   * This is the bug the live gateway found: it answered 503 "Source
   * Unavailable" — UIDAI unreachable on their side — and because the attempt
   * is counted before the call, each outage spent one of three. Three of them
   * and somebody was locked out of a challenge whose OTP had never once been
   * checked, told to request a new one, and met by the same outage again.
   *
   * Four outages here, which is more than the limit. If they counted, the
   * fourth would be TOO_MANY_ATTEMPTS and the right OTP afterwards would be
   * refused — so the correct OTP still working at the end is the whole
   * assertion.
   */
  test("a gateway outage does not spend an attempt", async () => {
    const userId = await consented();
    await http()
      .post("/v1/kyc/aadhaar/otp")
      .set(as(userId))
      .send({ aadhaarNumber: AADHAAR_GATEWAY_DOWN })
      .expect(201);

    for (let i = 0; i < 4; i++) {
      const response = await http()
        .post("/v1/kyc/aadhaar/verify")
        .set(as(userId))
        .send({ otp: RIGHT_OTP })
        .expect(400);

      /** Not AADHAAR_CHECK_FAILED: nothing was checked, so nothing failed. */
      expect(response.body.code).toBe("AADHAAR_UNAVAILABLE");
    }

    /**
     * The number ends in 9, so the fake keeps failing on verify. Asking for a
     * fresh OTP against a working number proves the challenge was never
     * exhausted — the attempts are back where they started.
     */
    await http()
      .post("/v1/kyc/aadhaar/otp")
      .set(as(userId))
      .send({ aadhaarNumber: AADHAAR })
      .expect(201);
    await http()
      .post("/v1/kyc/aadhaar/verify")
      .set(as(userId))
      .send({ otp: RIGHT_OTP })
      .expect(201);
  });

  /**
   * The counter must not be driven below zero by a run of outages.
   *
   * A negative count would read as "attempts remaining" forever and hand out
   * unlimited guesses at a six-digit secret, which is worse than the bug
   * being fixed. Outages first, then three wrong OTPs must still exhaust it.
   */
  test("outages cannot buy extra guesses", async () => {
    const userId = await consented();
    await http()
      .post("/v1/kyc/aadhaar/otp")
      .set(as(userId))
      .send({ aadhaarNumber: AADHAAR_GATEWAY_DOWN })
      .expect(201);

    for (let i = 0; i < 3; i++) {
      await http()
        .post("/v1/kyc/aadhaar/verify")
        .set(as(userId))
        .send({ otp: WRONG_OTP })
        .expect(400);
    }

    /**
     * A number ending in 9 fails before the OTP is ever compared, so those
     * three were outages and the count is still zero. Now a working challenge
     * and three genuinely wrong guesses, which must exhaust it on schedule.
     */
    await http()
      .post("/v1/kyc/aadhaar/otp")
      .set(as(userId))
      .send({ aadhaarNumber: AADHAAR })
      .expect(201);

    for (let i = 0; i < 3; i++) {
      const response = await http()
        .post("/v1/kyc/aadhaar/verify")
        .set(as(userId))
        .send({ otp: WRONG_OTP })
        .expect(400);
      expect(response.body.code).toBe("AADHAAR_CHECK_FAILED");
    }

    const blocked = await http()
      .post("/v1/kyc/aadhaar/verify")
      .set(as(userId))
      .send({ otp: WRONG_OTP })
      .expect(400);
    expect(blocked.body.code).toBe("TOO_MANY_ATTEMPTS");
  });

  /** Asking again is the way out, and it resets the count. */
  test("requesting a new OTP clears the attempts", async () => {
    const userId = await consented();
    await http().post("/v1/kyc/aadhaar/otp").set(as(userId)).send({ aadhaarNumber: AADHAAR }).expect(201);

    for (let i = 0; i < 2; i++) {
      await http().post("/v1/kyc/aadhaar/verify").set(as(userId)).send({ otp: WRONG_OTP }).expect(400);
    }

    await http().post("/v1/kyc/aadhaar/otp").set(as(userId)).send({ aadhaarNumber: AADHAAR }).expect(201);
    await http().post("/v1/kyc/aadhaar/verify").set(as(userId)).send({ otp: RIGHT_OTP }).expect(201);
  });
});

/* ------------------------------------------------------------------ */

describe("what is stored", () => {
  /**
   * The row holds a gateway handle and four digits. There is nowhere in this
   * database that could hold a full Aadhaar number, and this is the table
   * closest to one.
   */
  test("no Aadhaar number is anywhere in the challenge row", async () => {
    const userId = await consented();
    await http().post("/v1/kyc/aadhaar/otp").set(as(userId)).send({ aadhaarNumber: AADHAAR }).expect(201);

    const rows = await owner.sql.unsafe(
      "SELECT * FROM aadhaar_otp_challenges",
    );
    expect(rows).toHaveLength(1);

    const serialised = JSON.stringify(rows[0]);
    expect(serialised).not.toContain(AADHAAR);
    expect(serialised).not.toMatch(/\b[2-9][0-9]{11}\b/);
    expect(rows[0]!.last4).toBe(AADHAAR.slice(-4));
  });

  test("asking twice leaves one row, not two", async () => {
    const userId = await consented();

    await http().post("/v1/kyc/aadhaar/otp").set(as(userId)).send({ aadhaarNumber: AADHAAR }).expect(201);
    await http().post("/v1/kyc/aadhaar/otp").set(as(userId)).send({ aadhaarNumber: AADHAAR }).expect(201);

    const rows = await owner.sql.unsafe(
      "SELECT user_id FROM aadhaar_otp_challenges",
    );
    expect(rows).toHaveLength(1);
  });
});
