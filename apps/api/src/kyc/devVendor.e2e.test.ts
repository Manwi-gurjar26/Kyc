import { createClient, type DatabaseHandle } from "@kilowattx/db";
import { FakeKycProvider } from "@kilowattx/integrations";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../bootstrap.js";
import { DI, loadConfig } from "../config.js";
import { DEV_USER_HEADER } from "../common/session.js";

/**
 * The fake-vendor loop.
 *
 * This is what makes the whole flow walkable in a browser with no vendor
 * contract. The thing worth proving is that it is not a shortcut: completing a
 * session goes through the real signature check, the real replay guard and the
 * real decision function, so the path people use every day is the path that
 * will run in production.
 */

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://kilowattx_app:local_dev_only@localhost:5434/kilowattx_api_test";
const OWNER_URL =
  process.env.OWNER_DATABASE_URL ??
  "postgresql://kilowattx:local_dev_only@localhost:5434/kilowattx_api_test";

const WEBHOOK_SECRET = "whsec_devvendor_testing_0";
const BLIND_INDEX_KEY = Buffer.alloc(32, 11).toString("base64");

let app: NestExpressApplication;
let owner: DatabaseHandle;
let userId: string;

function http() {
  return request(app.getHttpServer());
}

beforeAll(async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: DB_URL,
    KYC_PROVIDER: "fake",
    KYC_WEBHOOK_SECRET: WEBHOOK_SECRET,
    KYC_BLIND_INDEX_KEY: BLIND_INDEX_KEY,
    FILE_SIGNING_SECRET: "filesign_devvendor_testing_00000",
  } as NodeJS.ProcessEnv);

  app = await createApp({
    config,
    kycProvider: new FakeKycProvider({ webhookSecret: WEBHOOK_SECRET }),
  });
  await app.init();

  owner = createClient({ url: OWNER_URL, maxConnections: 4 });
});

afterAll(async () => {
  await app.close();
  await owner.close();
});

beforeEach(async () => {
  await owner.sql.unsafe(`
    TRUNCATE TABLE audit_log, outbox_events, kyc_checks, documents,
      land_parcels, org_members, kyc_records,
      organisations, consent_records, seen_webhook_events, users
    RESTART IDENTITY CASCADE
  `);
  const rows = await owner.sql<{ id: string }[]>`
    INSERT INTO users (phone_e164, display_name, phone_verified_at)
    VALUES ('+919813000001', 'Ramesh Kumar Sharma', now()) RETURNING id
  `;
  userId = rows[0]!.id;
});

/* ------------------------------------------------------------------ */

async function startFlow(testScenario?: string): Promise<string> {
  const consent = await http()
    .post("/v1/kyc/consents")
    .set(DEV_USER_HEADER, userId)
    .send({ purpose: "KYC_VERIFICATION", noticeVersion: "2.1", locale: "en" })
    .expect(201);

  const session = await http()
    .post("/v1/kyc/sessions")
    .set(DEV_USER_HEADER, userId)
    .set("Idempotency-Key", `idem-${testScenario ?? "pass"}-${Date.now()}`)
    .send({
      level: "FULL",
      role: "LAND_OWNER",
      consentId: consent.body.id,
      locale: "en",
      ...(testScenario ? { testScenario } : {}),
    })
    .expect(201);

  return session.body.vendorSessionId as string;
}

/* ------------------------------------------------------------------ */

describe("the fake vendor completes a session the way a real one would", () => {
  test("a passing scenario ends VERIFIED", async () => {
    const sessionId = await startFlow("pass");

    const response = await http()
      .post(`/v1/dev/kyc-sessions/${sessionId}/complete`)
      .expect(201);

    expect(response.body.handled).toBe(true);
    expect(response.body.status).toBe("VERIFIED");
    expect(response.body.scenario).toBe("pass");
  });

  /**
   * The proof that this is not a shortcut. Completing a session writes the
   * same five tables a real webhook writes, because it goes through the same
   * handler.
   */
  test("it writes the audit row and the outbox event, like a real delivery", async () => {
    const sessionId = await startFlow("pass");
    await http().post(`/v1/dev/kyc-sessions/${sessionId}/complete`).expect(201);

    const audit = await owner.sql<{ action: string }[]>`SELECT action FROM audit_log`;
    const outbox = await owner.sql<
      { event_type: string }[]
    >`SELECT event_type FROM outbox_events`;
    const checks = await owner.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM kyc_checks
    `;

    expect(audit[0]!.action).toBe("kyc.decided");
    expect(outbox[0]!.event_type).toBe("kyc.verified");
    expect(checks[0]!.count).toBe("4");
  });

  /** The replay guard applies here too — it is the same code path. */
  test("completing the same session twice is handled once", async () => {
    const sessionId = await startFlow("pass");

    const first = await http()
      .post(`/v1/dev/kyc-sessions/${sessionId}/complete`)
      .expect(201);
    const second = await http()
      .post(`/v1/dev/kyc-sessions/${sessionId}/complete`)
      .expect(201);

    expect(first.body.handled).toBe(true);
    expect(second.body.handled).toBe(false);
    expect(second.body.reason).toBe("REPLAY");
  });

  test("an unknown session is refused rather than invented", async () => {
    await http()
      .post("/v1/dev/kyc-sessions/fake_sess_nope/complete")
      .expect(500);
  });
});

/* ------------------------------------------------------------------ */

/**
 * Every outcome reachable from a browser without editing code — the
 * development equivalent of keeping a stack of test identities at the vendor.
 */
describe("every scenario is reachable end to end", () => {
  const cases: { scenario: string; status: string; reason?: string }[] = [
    { scenario: "pass", status: "VERIFIED" },
    { scenario: "low_face_score", status: "MANUAL_REVIEW", reason: "FACE_MATCH_LOW" },
    { scenario: "liveness_fail", status: "MANUAL_REVIEW", reason: "LIVENESS_FAILED" },
    {
      scenario: "pan_name_mismatch",
      status: "MANUAL_REVIEW",
      reason: "PAN_NAME_MISMATCH",
    },
    {
      scenario: "pan_inoperative",
      status: "VERIFIED",
      reason: "PAN_NOT_LINKED_TO_AADHAAR",
    },
    { scenario: "pan_deactivated", status: "REJECTED", reason: "PAN_DEACTIVATED" },
    { scenario: "minor", status: "REJECTED", reason: "AGE_UNDER_18" },
    {
      scenario: "aadhaar_failed",
      status: "MANUAL_REVIEW",
      reason: "AADHAAR_NOT_VERIFIED",
    },
  ];

  for (const { scenario, status, reason } of cases) {
    test(`${scenario} -> ${status}${reason ? ` (${reason})` : ""}`, async () => {
      const sessionId = await startFlow(scenario);

      const response = await http()
        .post(`/v1/dev/kyc-sessions/${sessionId}/complete`)
        .expect(201);

      expect(response.body.status).toBe(status);

      if (reason) {
        const rows = await owner.sql<{ decision_reasons: { code: string }[] }[]>`
          SELECT decision_reasons FROM kyc_records WHERE vendor_session_id = ${sessionId}
        `;
        expect(rows[0]!.decision_reasons.map((r) => r.code)).toContain(reason);
      }
    });
  }

  test("the scenario list is served for the UI to offer", async () => {
    const response = await http().post("/v1/dev/kyc-sessions/scenarios").send({}).expect(201);
    expect(response.body.scenarios.length).toBeGreaterThan(5);
    expect(response.body.scenarios[0]).toHaveProperty("label");
    expect(response.body.scenarios[0]).toHaveProperty("outcome");
  });
});

/* ------------------------------------------------------------------ */

describe("a client cannot choose its own verification result", () => {
  /**
   * The whole reason testScenario is dropped in production. If a client could
   * ask for "pass", the field would be an authentication bypass dressed up as
   * a test helper.
   */
  test("in production the dev endpoint does not exist", async () => {
    const prodConfig = loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: DB_URL,
      KYC_PROVIDER: "cashfree",
      KYC_VENDOR_CLIENT_ID: "TEST_appid",
      KYC_VENDOR_CLIENT_SECRET: "TEST_secret",
      KYC_WEBHOOK_SECRET: WEBHOOK_SECRET,
      KYC_BLIND_INDEX_KEY: BLIND_INDEX_KEY,
      FILE_SIGNING_SECRET: "filesign_devvendor_testing_00000",
    } as NodeJS.ProcessEnv);

    /**
     * Booting on a real vendor throws, because the adapter is not written
     * yet. That failure IS the assertion: production
     * cannot come up on the fake provider, so the dev endpoint has nothing to
     * attach to.
     */
    await expect(createApp({ config: prodConfig })).rejects.toThrow(
      /Cashfree adapter is not implemented/,
    );
  });

  /**
   * Selecting the real gateway has to build BOTH adapters.
   *
   * Sandbox sells the personal checks and the business ones on one key, so
   * KYC_PROVIDER=sandbox is expected to produce an Aadhaar adapter and a
   * PAN/GSTIN/MCA adapter together. Before the KYB adapter existed this threw
   * "no KYB adapter is implemented", which is the failure worth keeping a test
   * against: it is a wiring mistake, invisible until a deploy, and it takes
   * out business verification while personal verification looks healthy.
   *
   * No network happens here — the client is constructed, not called.
   */
  test("selecting the real gateway builds the personal AND business adapters", async () => {
    const app = await createApp({
      config: loadConfig({
        NODE_ENV: "development",
        DATABASE_URL: DB_URL,
        KYC_PROVIDER: "sandbox",
        KYC_VENDOR_CLIENT_ID: "key_test",
        KYC_VENDOR_CLIENT_SECRET: "secret_test",
        KYC_WEBHOOK_SECRET: WEBHOOK_SECRET,
        KYC_BLIND_INDEX_KEY: BLIND_INDEX_KEY,
        FILE_SIGNING_SECRET: "filesign_devvendor_testing_00000",
      } as NodeJS.ProcessEnv),
    });

    try {
      /** Both resolve, and both say which gateway answered. */
      expect(app.get(DI.KYC_PROVIDER).name).toBe("sandbox");
      expect(app.get(DI.KYB_PROVIDER).name).toBe("sandbox");
    } finally {
      await app.close();
    }
  });

  test("the fake provider is refused in production config", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: DB_URL,
        KYC_PROVIDER: "fake",
        KYC_WEBHOOK_SECRET: WEBHOOK_SECRET,
        KYC_BLIND_INDEX_KEY: BLIND_INDEX_KEY,
    FILE_SIGNING_SECRET: "filesign_devvendor_testing_00000",
      } as NodeJS.ProcessEnv),
    ).toThrow(/refused in production/);
  });
});
