import { createClient, type DatabaseHandle } from "@kilowattx/db";
import { FakeKycProvider } from "@kilowattx/integrations";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../bootstrap.js";
import { loadConfig, type AppConfig } from "../config.js";
import { DEV_STAFF_ROLES_HEADER, DEV_USER_HEADER } from "../common/session.js";

/**
 * End-to-end tests over the real HTTP stack, a real Postgres and the fake
 * vendor.
 *
 * These exercise the middleware the server actually runs, which matters most
 * for the raw-body handling: a webhook signature covers the exact bytes sent,
 * and that is the piece most likely to work in a unit test and fail in
 * production.
 */

/**
 * This package has its own test database.
 *
 * Turborepo runs `db:test` and `api:test` in parallel, and both suites
 * truncate tables between tests. Sharing one database means each deletes the
 * other's rows mid-test, which surfaces as foreign key violations and counts
 * off by one — failures that look like bugs in the code rather than a
 * collision between two test runs. `scripts/setup-test-databases.mjs` creates
 * and migrates both.
 */
const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://kilowattx_app:local_dev_only@localhost:5434/kilowattx_api_test";
const OWNER_URL =
  process.env.OWNER_DATABASE_URL ??
  "postgresql://kilowattx:local_dev_only@localhost:5434/kilowattx_api_test";

const WEBHOOK_SECRET = "whsec_e2e_testing_only_000";
/** 32 non-zero bytes, base64. */
const BLIND_INDEX_KEY = Buffer.alloc(32, 7).toString("base64");

const NOW = new Date("2026-10-09T12:00:00.000Z");
const clock = () => NOW;

let app: NestExpressApplication;
let owner: DatabaseHandle;
let provider: FakeKycProvider;
let config: AppConfig;
let userId: string;

function http() {
  return request(app.getHttpServer());
}

function asUser(id: string) {
  return { [DEV_USER_HEADER]: id };
}

beforeAll(async () => {
  config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: DB_URL,
    KYC_PROVIDER: "fake",
    KYC_WEBHOOK_SECRET: WEBHOOK_SECRET,
    KYC_BLIND_INDEX_KEY: BLIND_INDEX_KEY,
    FILE_SIGNING_SECRET: "filesign_kyc_testing_00000",
  } as NodeJS.ProcessEnv);

  provider = new FakeKycProvider({ webhookSecret: WEBHOOK_SECRET, clock });

  app = await createApp({ config, clock, kycProvider: provider });
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
    VALUES ('+919812000001', 'Ramesh Kumar Sharma', now()) RETURNING id
  `;
  userId = rows[0]!.id;
});

/* ------------------------------------------------------------------ */

async function giveConsent(): Promise<string> {
  const response = await http()
    .post("/v1/kyc/consents")
    .set(asUser(userId))
    .send({ purpose: "KYC_VERIFICATION", noticeVersion: "2.1", locale: "en" })
    .expect(201);
  return response.body.id as string;
}

async function openSession(
  idempotencyKey = "idem-e2e-0001",
): Promise<{ kycRecordId: string; vendorSessionId: string }> {
  const consentId = await giveConsent();
  const response = await http()
    .post("/v1/kyc/sessions")
    .set(asUser(userId))
    .set("Idempotency-Key", idempotencyKey)
    .send({ level: "FULL", role: "LAND_OWNER", consentId, locale: "en" })
    .expect(201);
  return response.body;
}

/* ------------------------------------------------------------------ */

describe("authentication", () => {
  test("a request with no session is refused", async () => {
    const response = await http().get("/v1/kyc/me").expect(401);
    expect(response.body.code).toBe("AUTH_REQUIRED");
  });

  test("the error shape is code, message, details everywhere", async () => {
    const response = await http().get("/v1/kyc/me").expect(401);
    expect(response.body).toHaveProperty("code");
    expect(response.body).toHaveProperty("message");
  });
});

/* ------------------------------------------------------------------ */

describe("consent comes before anything else", () => {
  test("consent is recorded with its notice version", async () => {
    const consentId = await giveConsent();

    const rows = await owner.sql<{ notice_version: string; purpose: string }[]>`
      SELECT notice_version, purpose FROM consent_records WHERE id = ${consentId}
    `;
    expect(rows[0]!.notice_version).toBe("2.1");
    expect(rows[0]!.purpose).toBe("KYC_VERIFICATION");
  });

  test("a purpose outside the declared list is rejected", async () => {
    const response = await http()
      .post("/v1/kyc/consents")
      .set(asUser(userId))
      .send({ purpose: "SELL_THEIR_DATA", noticeVersion: "2.1" })
      .expect(400);

    expect(response.body.code).toBe("VALIDATION_FAILED");
    expect(response.body.details[0].field).toBe("purpose");
  });

  /** No consent, no vendor call — and therefore no vendor cost either. */
  test("a session cannot be opened without consent", async () => {
    const response = await http()
      .post("/v1/kyc/sessions")
      .set(asUser(userId))
      .set("Idempotency-Key", "idem-no-consent")
      .send({
        level: "FULL",
        role: "LAND_OWNER",
        consentId: "00000000-0000-0000-0000-000000000000",
        locale: "en",
      })
      .expect(400);

    expect(response.body.code).toBe("CONSENT_REQUIRED");
  });
});

/* ------------------------------------------------------------------ */

describe("opening a vendor session", () => {
  test("returns a short-lived client token and a hosted URL", async () => {
    const consentId = await giveConsent();
    const response = await http()
      .post("/v1/kyc/sessions")
      .set(asUser(userId))
      .set("Idempotency-Key", "idem-session-1")
      .send({ level: "FULL", role: "LAND_OWNER", consentId, locale: "en" })
      .expect(201);

    expect(response.body.clientToken).toBeTruthy();
    expect(response.body.hostedUrl).toContain(response.body.vendorSessionId);
  });

  /** The vendor API key must never reach a client. */
  test("the response contains no vendor secret", async () => {
    const consentId = await giveConsent();
    const response = await http()
      .post("/v1/kyc/sessions")
      .set(asUser(userId))
      .set("Idempotency-Key", "idem-session-2")
      .send({ level: "FULL", role: "LAND_OWNER", consentId, locale: "en" })
      .expect(201);

    expect(JSON.stringify(response.body)).not.toContain(WEBHOOK_SECRET);
  });

  test("the idempotency key is required", async () => {
    const consentId = await giveConsent();
    const response = await http()
      .post("/v1/kyc/sessions")
      .set(asUser(userId))
      .send({ level: "FULL", role: "LAND_OWNER", consentId, locale: "en" })
      .expect(400);

    expect(response.body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  /**
   * A double-clicked button must not open two paid vendor sessions, nor create
   * two kyc_records.
   */
  test("the same idempotency key returns the same session", async () => {
    const consentId = await giveConsent();

    const first = await http()
      .post("/v1/kyc/sessions")
      .set(asUser(userId))
      .set("Idempotency-Key", "idem-double-click")
      .send({ level: "FULL", role: "LAND_OWNER", consentId, locale: "en" })
      .expect(201);

    const second = await http()
      .post("/v1/kyc/sessions")
      .set(asUser(userId))
      .set("Idempotency-Key", "idem-double-click")
      .send({ level: "FULL", role: "LAND_OWNER", consentId, locale: "en" })
      .expect(201);

    expect(second.body.vendorSessionId).toBe(first.body.vendorSessionId);
    expect(second.body.kycRecordId).toBe(first.body.kycRecordId);

    const rows = await owner.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM kyc_records
    `;
    expect(rows[0]!.count).toBe("1");
  });

  test("the record moves to IN_PROGRESS", async () => {
    await openSession();
    const response = await http().get("/v1/kyc/me").set(asUser(userId)).expect(200);
    expect(response.body.status).toBe("IN_PROGRESS");
  });
});

/* ------------------------------------------------------------------ */

describe("the webhook is the only thing that verifies anyone", () => {
  async function deliver(
    sessionId: string,
    mutate?: (body: string) => string,
  ): Promise<request.Response> {
    const webhook = await provider.buildWebhook(sessionId);
    const body = mutate ? mutate(webhook.rawBody) : webhook.rawBody;

    return http()
      .post("/v1/webhooks/kyc/fake")
      .set("X-Webhook-Signature", webhook.signatureHeader)
      .set("Content-Type", "application/json")
      .send(body);
  }

  test("a correctly signed webhook verifies the record", async () => {
    const { vendorSessionId } = await openSession();

    const response = await deliver(vendorSessionId);
    expect(response.status).toBe(200);
    expect(response.body.handled).toBe(true);
    expect(response.body.status).toBe("VERIFIED");
  });

  test("no signature is refused", async () => {
    const { vendorSessionId } = await openSession();
    const webhook = await provider.buildWebhook(vendorSessionId);

    const response = await http()
      .post("/v1/webhooks/kyc/fake")
      .set("Content-Type", "application/json")
      .send(webhook.rawBody)
      .expect(401);

    expect(response.body.code).toBe("WEBHOOK_UNAUTHORIZED");
  });

  test("a wrong signature is refused", async () => {
    const { vendorSessionId } = await openSession();

    const response = await http()
      .post("/v1/webhooks/kyc/fake")
      .set("X-Webhook-Signature", `t=${Math.floor(NOW.getTime() / 1000)},v1=${"a".repeat(64)}`)
      .set("Content-Type", "application/json")
      .send((await provider.buildWebhook(vendorSessionId)).rawBody)
      .expect(401);

    expect(response.body.code).toBe("WEBHOOK_UNAUTHORIZED");
  });

  /**
   * THE RAW BODY TEST.
   *
   * The signature covers the exact bytes. This delivers a body that is the
   * same JSON semantically but a different string, with the correct signature
   * for the original. It must fail — if it passes, the handler is verifying a
   * re-serialised object rather than what was received, and the signature
   * check has quietly stopped meaning anything.
   */
  test("a semantically identical but re-serialised body is refused", async () => {
    const { vendorSessionId } = await openSession();

    const response = await deliver(vendorSessionId, (raw) => {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // Same data, different key order and whitespace.
      return JSON.stringify(
        Object.fromEntries(Object.entries(parsed).reverse()),
        null,
        2,
      );
    });
    expect(response.status).toBe(401);

    expect(response.body.code).toBe("WEBHOOK_UNAUTHORIZED");
  });

  test("a rejection never says which check failed", async () => {
    const { vendorSessionId } = await openSession();
    const response = await deliver(vendorSessionId, (raw) =>
      raw.replace("completed", "tampered"),
    );
    expect(response.status).toBe(401);

    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toMatch(/TIMESTAMP|MISMATCH|MALFORMED/i);
  });

  /**
   * A replay is the vendor behaving correctly, so it answers 200. Answering
   * 4xx would make the vendor retry harder and eventually trip whatever
   * watches its error rate.
   */
  test("the same webhook twice is handled once", async () => {
    const { vendorSessionId } = await openSession();

    const first = await deliver(vendorSessionId);
    expect(first.status).toBe(200);
    const second = await deliver(vendorSessionId);
    expect(second.status).toBe(200);

    expect(first.body.handled).toBe(true);
    expect(second.body.handled).toBe(false);
    expect(second.body.reason).toBe("REPLAY");
  });

  test("a replayed webhook writes nothing the second time", async () => {
    const { vendorSessionId } = await openSession();

    expect((await deliver(vendorSessionId)).status).toBe(200);
    const after = await owner.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM outbox_events
    `;

    expect((await deliver(vendorSessionId)).status).toBe(200);
    const afterReplay = await owner.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM outbox_events
    `;

    expect(afterReplay[0]!.count).toBe(after[0]!.count);
    expect(after[0]!.count).toBe("1");
  });

  test("it writes the audit row and the outbox event together", async () => {
    const { vendorSessionId } = await openSession();
    expect((await deliver(vendorSessionId)).status).toBe(200);

    const audit = await owner.sql<{ action: string }[]>`
      SELECT action FROM audit_log
    `;
    const outbox = await owner.sql<{ event_type: string }[]>`
      SELECT event_type FROM outbox_events
    `;

    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe("kyc.decided");
    expect(outbox[0]!.event_type).toBe("kyc.verified");
  });

  test("a webhook for an unknown session is refused", async () => {
    const response = await http()
      .post("/v1/webhooks/kyc/fake")
      .set("X-Webhook-Signature", "t=1,v1=" + "a".repeat(64))
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ eventId: "evt_x", sessionId: "fake_sess_nope" }))
      .expect(401);

    expect(response.body.code).toBe("WEBHOOK_UNAUTHORIZED");
  });
});

/* ------------------------------------------------------------------ */

describe("a low face match goes to a person, not to a pass", () => {
  test("the record lands in MANUAL_REVIEW with the reason", async () => {
    const consentId = await giveConsent();

    /** Opened directly, so the scenario can be chosen. */
    const session = await provider.createSession({
      subjectId: userId,
      level: "FULL",
      role: "LAND_OWNER",
      locale: "en",
      redirectUrl: config.KYC_REDIRECT_URL,
      idempotencyKey: "idem-low-face",
      testScenario: "low_face_score",
    });

    await owner.sql`
      INSERT INTO kyc_records (subject_type, user_id, level, status, vendor, vendor_session_id, consent_id)
      VALUES ('PERSON', ${userId}, 'FULL', 'IN_PROGRESS', 'fake', ${session.vendorSessionId}, ${consentId})
    `;

    const webhook = await provider.buildWebhook(session.vendorSessionId);
    const response = await http()
      .post("/v1/webhooks/kyc/fake")
      .set("X-Webhook-Signature", webhook.signatureHeader)
      .set("Content-Type", "application/json")
      .send(webhook.rawBody)
      .expect(200);

    expect(response.body.status).toBe("MANUAL_REVIEW");

    const rows = await owner.sql<
      { decision_reasons: { code: string }[] }[]
    >`SELECT decision_reasons FROM kyc_records WHERE vendor_session_id = ${session.vendorSessionId}`;
    expect(rows[0]!.decision_reasons.map((r) => r.code)).toContain("FACE_MATCH_LOW");
  });
});

/* ------------------------------------------------------------------ */

describe("what the customer can see, and what gates open", () => {
  test("GET /me returns masked values only", async () => {
    const { vendorSessionId } = await openSession();
    await (async () => {
      const webhook = await provider.buildWebhook(vendorSessionId);
      await http()
        .post("/v1/webhooks/kyc/fake")
        .set("X-Webhook-Signature", webhook.signatureHeader)
        .set("Content-Type", "application/json")
        .send(webhook.rawBody)
        .expect(200);
    })();

    const response = await http().get("/v1/kyc/me").set(asUser(userId)).expect(200);

    expect(response.body.status).toBe("VERIFIED");
    expect(response.body.panLast4).toMatch(/^[A-Z0-9]{4}$/);
    expect(response.body.aadhaarLast4).toBe("7731");

    /** No full PAN, and no 12-digit Aadhaar number anywhere. */
    const serialised = JSON.stringify(response.body);
    /** Any full PAN, not just one literal. */
    expect(serialised).not.toMatch(/[A-Z]{5}[0-9]{4}[A-Z]/);
    expect(serialised).not.toMatch(/\b[2-9][0-9]{11}\b/);
  });

  test("investing is blocked before verification and open after", async () => {
    const before = await http()
      .get("/v1/kyc/can/INVEST")
      .set(asUser(userId))
      .expect(200);
    expect(before.body.allowed).toBe(false);
    expect(before.body.code).toBe("KYC_REQUIRED");

    const { vendorSessionId } = await openSession();
    const webhook = await provider.buildWebhook(vendorSessionId);
    await http()
      .post("/v1/webhooks/kyc/fake")
      .set("X-Webhook-Signature", webhook.signatureHeader)
      .set("Content-Type", "application/json")
      .send(webhook.rawBody)
      .expect(200);

    const after = await http()
      .get("/v1/kyc/can/INVEST")
      .set(asUser(userId))
      .expect(200);
    expect(after.body.allowed).toBe(true);
  });

  /**
   * The denial codes are a contract the app branches on, so an action this
   * service does not gate has to say so plainly rather than look like an
   * outage.
   *
   * This was a 500. `can()` is an exhaustive switch with no default branch —
   * which is what makes adding an action without writing its guard a compile
   * error — so an unrecognised string fell through, returned undefined, and
   * threw on the next line. Removing RECEIVE_PAYOUT is what surfaced it: a
   * client still holding the old string got "something went wrong on our
   * side", which was neither true nor actionable.
   */
  test("an action this service does not gate is a bad request, not a server error", async () => {
    const response = await http()
      .get("/v1/kyc/can/BANANA")
      .set(asUser(userId))
      .expect(400);

    expect(response.body.code).toBe("UNKNOWN_ACTION");
    /** The list, so a caller can see what it should have sent. */
    expect(response.body.details.actions).toContain("INVEST");
  });

  test("the removed payout action is refused the same way", async () => {
    const response = await http()
      .get("/v1/kyc/can/RECEIVE_PAYOUT")
      .set(asUser(userId))
      .expect(400);

    expect(response.body.code).toBe("UNKNOWN_ACTION");
    expect(response.body.details.actions).not.toContain("RECEIVE_PAYOUT");
  });

  /** Case matters: a guard that accepted "invest" would be guessing. */
  test("an action in the wrong case is refused rather than coerced", async () => {
    await http().get("/v1/kyc/can/invest").set(asUser(userId)).expect(400);
  });

  test("a customer cannot see another customer's status", async () => {
    await openSession();

    const others = await owner.sql<{ id: string }[]>`
      INSERT INTO users (phone_e164, display_name, phone_verified_at)
      VALUES ('+919812000002', 'Someone Else', now()) RETURNING id
    `;

    const response = await http()
      .get("/v1/kyc/me")
      .set(asUser(others[0]!.id))
      .expect(200);

    expect(response.body.status).toBe("NOT_STARTED");
  });

  test("staff headers do not grant a customer another record", async () => {
    await openSession();

    const others = await owner.sql<{ id: string }[]>`
      INSERT INTO users (phone_e164, display_name, phone_verified_at)
      VALUES ('+919812000003', 'Nosy Person', now()) RETURNING id
    `;

    const response = await http()
      .get("/v1/kyc/me")
      .set(asUser(others[0]!.id))
      .set(DEV_STAFF_ROLES_HEADER, "compliance")
      .expect(200);

    /** /me is always the caller's own record, whatever roles they hold. */
    expect(response.body.status).toBe("NOT_STARTED");
  });
});
