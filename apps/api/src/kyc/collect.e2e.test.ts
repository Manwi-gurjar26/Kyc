import { createClient, type DatabaseHandle } from "@kilowattx/db";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../bootstrap.js";
import { loadConfig } from "../config.js";
import { DEV_USER_HEADER } from "../common/session.js";

/**
 * Collecting the result of a hosted session.
 *
 * The person comes back from the gateway and the browser tells us so. That is
 * all the browser is trusted for: this endpoint then asks the gateway itself
 * what happened, which is the same rule the deleted hosted-vendor path
 * observed and the reason a webhook body is never believed either.
 *
 * It exists for DigiLocker, where there is no webhook at all — the person
 * returning IS the notification. The fake gateway is used here because it can
 * produce every outcome on demand; DigiLocker needs a real person at a
 * government site, which no test can supply.
 */

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://kilowattx_app:local_dev_only@localhost:5434/kilowattx_api_test";
const OWNER_URL =
  process.env.OWNER_DATABASE_URL ??
  "postgresql://kilowattx:local_dev_only@localhost:5434/kilowattx_api_test";

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
  const r = await http().post("/v1/dev/users").send({ phoneE164: phone, locale: "en" });
  return r.body.id as string;
}

/** Consent, then an open vendor session. Returns the session the gateway gave. */
async function openSession(
  userId: string,
  testScenario = "pass",
): Promise<string> {
  const consent = await http()
    .post("/v1/kyc/consents")
    .set(as(userId))
    .send({ purpose: "KYC_VERIFICATION", noticeVersion: "2.1", locale: "en" })
    .expect(201);

  const session = await http()
    .post("/v1/kyc/sessions")
    .set(as(userId))
    .set("Idempotency-Key", `idem-${Math.random().toString(36).slice(2, 12)}`)
    .send({
      level: "FULL",
      role: "LAND_OWNER",
      locale: "en",
      consentId: consent.body.id,
      testScenario,
    })
    .expect(201);

  return session.body.vendorSessionId as string;
}

beforeAll(async () => {
  owner = createClient({ url: OWNER_URL, maxConnections: 4 });
  app = await createApp({
    config: loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: DB_URL,
      KYC_PROVIDER: "fake",
      KYC_WEBHOOK_SECRET: "whsec_collect_e2e_00000000",
      KYC_BLIND_INDEX_KEY: Buffer.alloc(32, 53).toString("base64"),
      FILE_SIGNING_SECRET: "filesign_collect_e2e_000000",
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

describe("collecting a finished session", () => {
  test("the result is fetched from the gateway and decided", async () => {
    const userId = await newUser();
    const vendorSessionId = await openSession(userId);

    const response = await http()
      .post(`/v1/kyc/sessions/${vendorSessionId}/collect`)
      .set(as(userId))
      .expect(201);

    expect(response.body.status).toBe("VERIFIED");

    const me = await http().get("/v1/kyc/me").set(as(userId)).expect(200);
    expect(me.body.status).toBe("VERIFIED");
  });

  /**
   * A failing outcome is still a collected one.
   *
   * The call succeeded and the gateway answered; what it said is a finding
   * about this person, not a broken request. Turning it into an error would
   * lose the reasons the reviewer needs.
   */
  test("a rejection is reported, not thrown", async () => {
    const userId = await newUser();
    const vendorSessionId = await openSession(userId, "minor");

    const response = await http()
      .post(`/v1/kyc/sessions/${vendorSessionId}/collect`)
      .set(as(userId))
      .expect(201);

    expect(response.body.status).toBe("REJECTED");
    expect(response.body.reasonCodes).toContain("AGE_UNDER_18");
  });

  /**
   * Refreshing the return page must not re-decide.
   *
   * `applyKycDecision` refuses a transition to the status already held, so a
   * second collect would turn a 201 into a 500 on a page somebody might
   * reload out of simple impatience. The second call returns the decision
   * that was already made, without troubling — or paying — the gateway again.
   */
  test("collecting twice is safe and does not re-decide", async () => {
    const userId = await newUser();
    const vendorSessionId = await openSession(userId);

    const first = await http()
      .post(`/v1/kyc/sessions/${vendorSessionId}/collect`)
      .set(as(userId))
      .expect(201);
    const second = await http()
      .post(`/v1/kyc/sessions/${vendorSessionId}/collect`)
      .set(as(userId))
      .expect(201);

    expect(second.body.status).toBe(first.body.status);

    const checks = await owner.sql.unsafe(
      `SELECT count(*) AS n FROM kyc_checks c
         JOIN kyc_records r ON r.id = c.kyc_record_id
        WHERE r.user_id = '${userId}' AND c.check_type = 'AADHAAR'`,
    );
    expect(Number((checks[0] as Record<string, unknown>).n)).toBe(1);
  });
});

/* ------------------------------------------------------------------ */

describe("what it refuses", () => {
  /**
   * The session id travels through the browser, so it is a claim and not a
   * credential. Collecting somebody else's session would write their
   * verification onto your record.
   */
  test("another person's session cannot be collected", async () => {
    const owner1 = await newUser();
    const vendorSessionId = await openSession(owner1);

    const intruder = await newUser();
    const response = await http()
      .post(`/v1/kyc/sessions/${vendorSessionId}/collect`)
      .set(as(intruder))
      .expect(404);

    expect(response.body.code).toBe("SESSION_NOT_FOUND");
  });

  test("an unknown session is refused", async () => {
    const userId = await newUser();

    const response = await http()
      .post("/v1/kyc/sessions/no-such-session/collect")
      .set(as(userId))
      .expect(404);

    expect(response.body.code).toBe("SESSION_NOT_FOUND");
  });

  test("collecting without a session is refused", async () => {
    await http()
      .post("/v1/kyc/sessions/anything/collect")
      .expect(401);
  });
});
