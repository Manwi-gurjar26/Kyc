import { createClient, type DatabaseHandle } from "@kilowattx/db";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../bootstrap.js";
import { loadConfig } from "../config.js";
import { DEV_USER_HEADER, DEV_STAFF_ROLES_HEADER } from "../common/session.js";

/**
 * The decision point in the step-by-step flow.
 *
 * Before this existed, finishing every step a person could actually do left
 * them at IN_PROGRESS — permanently, and invisible to anyone. The record held
 * a verified Aadhaar and a verified PAN and still said "in progress", because
 * nothing in this flow ever called decideKyc(). Only the webhook path did.
 *
 * What these tests pin down is that the decision now happens, that it is
 * stored with the thresholds that produced it, and that the case reaches the
 * review queue. Note what they do NOT assert: VERIFIED. A FULL verification
 * needs a selfie, there is no selfie step yet, and decideKyc is right to send
 * that to a human rather than pass it.
 */

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://kilowattx_app:local_dev_only@localhost:5434/kilowattx_api_test";
const OWNER_URL =
  process.env.OWNER_DATABASE_URL ??
  "postgresql://kilowattx:local_dev_only@localhost:5434/kilowattx_api_test";

const RIGHT_OTP = "123456";
/** Verhoeff-valid, and does not end in 0, 1 or 9 (the fake's failure markers). */
const AADHAAR = "999941057058";

/**
 * A fresh PAN per test: `pan_blind_index` is globally unique, so a PAN spent
 * by one test is spent for the whole suite and the next run of it.
 */
function somePan(options: { nameMismatch?: boolean } = {}): string {
  const digits = String(Math.floor(Math.random() * 1e4)).padStart(4, "0");
  return `ABCP${options.nameMismatch ? "Z" : "S"}${digits}K`;
}

let app: NestExpressApplication;
let owner: DatabaseHandle;

function http() {
  return request(app.getHttpServer());
}

function as(userId: string) {
  return { [DEV_USER_HEADER]: userId };
}

function asStaff(userId: string) {
  return {
    [DEV_USER_HEADER]: userId,
    [DEV_STAFF_ROLES_HEADER]: "compliance",
  };
}

async function newUser(): Promise<string> {
  const phone = `+9199${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  const response = await http().post("/v1/dev/users").send({ phoneE164: phone, locale: "en" });
  return response.body.id as string;
}

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
      KYC_WEBHOOK_SECRET: "whsec_decision_e2e_0000000",
      KYC_BLIND_INDEX_KEY: Buffer.alloc(32, 47).toString("base64"),
      FILE_SIGNING_SECRET: "filesign_decision_e2e_00000",
    } as NodeJS.ProcessEnv),
  });
  await app.init();
});

afterAll(async () => {
  await app.close();
  await owner.close();
});

/**
 * Puts a selfie through the real documents pipeline.
 *
 * There is no selfie endpoint of its own: the generic upload already accepts
 * a SELFIE docType and already virus-scans it, so using anything else here
 * would be testing a path nobody walks.
 */
async function uploadSelfie(
  userId: string,
  options: { markers?: string[] } = {},
): Promise<void> {
  const target = await http()
    .post("/v1/documents/upload-url")
    .set(as(userId))
    .send({
      docType: "SELFIE",
      fileName: "selfie.jpg",
      contentType: "image/jpeg",
      sizeBytes: 2048,
      ...(options.markers ? { testMarkers: options.markers } : {}),
    })
    .expect(201);

  await http()
    .put(`/v1/files${new URL(target.body.url).search}`)
    .set("content-type", "image/jpeg")
    .send(Buffer.from("\xff\xd8\xff selfie bytes"))
    .expect(200);

  await http()
    .post("/v1/documents/confirm")
    .set(as(userId))
    .send({ storageKey: target.body.key, sha256: "e".repeat(64) })
    .expect(201);
}

beforeEach(async () => {
  await owner.sql.unsafe("TRUNCATE TABLE aadhaar_otp_challenges CASCADE");
});

/* ------------------------------------------------------------------ */

describe("finishing the steps produces a decision", () => {
  /**
   * The bug this closes, written as the behaviour that was missing.
   *
   * MANUAL_REVIEW rather than VERIFIED, and SELFIE_MISSING is why. That is
   * the correct answer for a FULL verification with no selfie, and asserting
   * it rather than working around it is the point: the status is now true.
   */
  test("a verified Aadhaar and PAN reaches a decision instead of sitting in progress", async () => {
    const userId = await verifiedAadhaar();

    await http().post("/v1/kyc/pan").set(as(userId)).send({ pan: somePan() }).expect(201);

    const me = await http().get("/v1/kyc/me").set(as(userId)).expect(200);

    expect(me.body.status).toBe("MANUAL_REVIEW");
    expect(me.body.reasonCodes).toContain("SELFIE_MISSING");
  });

  /**
   * The thresholds in force are stored with the decision.
   *
   * Without them the reasons are unreproducible: "face match too low" means
   * nothing in eighteen months if nobody can say what the bar was that day,
   * and Ops can retune these from the settings table at any time.
   */
  test("the decision is stored with the thresholds that produced it", async () => {
    const userId = await verifiedAadhaar();
    await http().post("/v1/kyc/pan").set(as(userId)).send({ pan: somePan() }).expect(201);

    const rows = await owner.sql.unsafe(
      `SELECT status, decision_reasons, thresholds_used
         FROM kyc_records WHERE user_id = '${userId}'`,
    );
    const row = rows[0] as Record<string, unknown>;

    expect(row.status).toBe("MANUAL_REVIEW");

    const reasons = row.decision_reasons as { code: string; severity: string }[];
    expect(reasons.map((r) => r.code)).toContain("SELFIE_MISSING");
    /** Carried verbatim, severity included, so a reviewer sees what decided it. */
    expect(reasons.every((r) => typeof r.severity === "string")).toBe(true);

    const thresholds = row.thresholds_used as Record<string, number>;
    expect(thresholds.faceMatch).toBeGreaterThan(0);
    expect(thresholds.minimumAge).toBe(18);
  });

  /** One kyc_checks row per check actually performed, append-only. */
  test("the checks that ran are recorded", async () => {
    const userId = await verifiedAadhaar();
    await http().post("/v1/kyc/pan").set(as(userId)).send({ pan: somePan() }).expect(201);

    const rows = await owner.sql.unsafe(
      `SELECT c.check_type, c.status
         FROM kyc_checks c
         JOIN kyc_records r ON r.id = c.kyc_record_id
        WHERE r.user_id = '${userId}'
        ORDER BY c.check_type`,
    );

    const checks = (rows as unknown as { check_type: string; status: string }[]).map(
      (r) => `${r.check_type}:${r.status}`,
    );

    expect(checks).toContain("AADHAAR:PASSED");
    expect(checks).toContain("PAN:PASSED");
  });

  /**
   * The case has to be visible to whoever has to act on it.
   *
   * MANUAL_REVIEW that nobody can find is the same as IN_PROGRESS. This is
   * the assertion that the work actually achieved something.
   */
  test("the case appears in the review queue", async () => {
    const userId = await verifiedAadhaar();
    await http().post("/v1/kyc/pan").set(as(userId)).send({ pan: somePan() }).expect(201);

    /** The queue is keyed by kyc_record id, not by user. */
    const idRows = await owner.sql.unsafe(
      `SELECT id FROM kyc_records WHERE user_id = '${userId}'`,
    );
    const recordId = (idRows[0] as Record<string, unknown>).id as string;

    const staff = await newUser();
    const queue = await http()
      .get("/v1/admin/kyc/reviews")
      .set(asStaff(staff))
      .expect(200);

    const mine = (queue.body.rows as { id: string; reasonCodes: string[] }[]).filter(
      (row) => row.id === recordId,
    );

    expect(mine).toHaveLength(1);
    /** And it arrives carrying the reason, so the reviewer knows why. */
    expect(mine[0]!.reasonCodes).toContain("SELFIE_MISSING");
  });
});

/* ------------------------------------------------------------------ */

describe("a selfie that was collected but not scored", () => {
  /**
   * The honest reason, when a selfie is actually on file.
   *
   * This gateway sells no liveness or face-match check, so the selfie is
   * collected, scanned and stored and nothing has compared it to anything.
   * Saying SELFIE_MISSING there sends a reviewer hunting for a file that is
   * sitting in front of them.
   */
  test("a clean selfie reviews as not scored rather than missing", async () => {
    const userId = await verifiedAadhaar();
    await uploadSelfie(userId);

    await http().post("/v1/kyc/pan").set(as(userId)).send({ pan: somePan() }).expect(201);

    const me = await http().get("/v1/kyc/me").set(as(userId)).expect(200);

    expect(me.body.status).toBe("MANUAL_REVIEW");
    expect(me.body.reasonCodes).toContain("SELFIE_NOT_SCORED");
    expect(me.body.reasonCodes).not.toContain("SELFIE_MISSING");
  });

  /**
   * The step has to stop being listed as outstanding.
   *
   * `remainingSteps` asked whether liveness had passed, and nothing ever sets
   * that — there is no liveness vendor to set it. So a person who uploaded a
   * selfie was still told the selfie step was outstanding, permanently, and
   * the only sensible response to that screen is to take another one.
   */
  test("a clean selfie clears the selfie step", async () => {
    const userId = await verifiedAadhaar();
    await uploadSelfie(userId);

    const me = await http().get("/v1/kyc/me").set(as(userId)).expect(200);
    expect(me.body.remainingSteps).not.toContain("SELFIE");
  });

  /** An unscannable one does not, for the same reason it is not evidence. */
  test("an infected selfie leaves the step outstanding", async () => {
    const userId = await verifiedAadhaar();
    await uploadSelfie(userId, { markers: ["infected"] });

    const me = await http().get("/v1/kyc/me").set(as(userId)).expect(200);
    expect(me.body.remainingSteps).toContain("SELFIE");
  });

  /** And it is still not a pass. An unscored face is not a matched face. */
  test("an unscored selfie does not verify anybody", async () => {
    const userId = await verifiedAadhaar();
    await uploadSelfie(userId);

    await http().post("/v1/kyc/pan").set(as(userId)).send({ pan: somePan() }).expect(201);

    const me = await http().get("/v1/kyc/me").set(as(userId)).expect(200);
    expect(me.body.status).not.toBe("VERIFIED");
  });

  /**
   * A file we could not scan is not evidence.
   *
   * An infected upload is quarantined, and treating it as "a selfie is on
   * file" would let a reviewer believe there is something to look at. It
   * counts as absent.
   */
  test("an infected selfie counts as no selfie at all", async () => {
    const userId = await verifiedAadhaar();
    await uploadSelfie(userId, { markers: ["infected"] });

    await http().post("/v1/kyc/pan").set(as(userId)).send({ pan: somePan() }).expect(201);

    const me = await http().get("/v1/kyc/me").set(as(userId)).expect(200);
    expect(me.body.reasonCodes).toContain("SELFIE_MISSING");
    expect(me.body.reasonCodes).not.toContain("SELFIE_NOT_SCORED");
  });

  /** Same for a scanner that could not be reached: not clean is not evidence. */
  test("a selfie whose scan errored counts as no selfie", async () => {
    const userId = await verifiedAadhaar();
    await uploadSelfie(userId, { markers: ["scanfail"] });

    await http().post("/v1/kyc/pan").set(as(userId)).send({ pan: somePan() }).expect(201);

    const me = await http().get("/v1/kyc/me").set(as(userId)).expect(200);
    expect(me.body.reasonCodes).toContain("SELFIE_MISSING");
  });
});

/* ------------------------------------------------------------------ */

describe("the Aadhaar photograph", () => {
  /**
   * The fake gateway returns no photograph, which is the point of asserting
   * this: a missing photo must be an absent key, not an empty string or a
   * placeholder. The review screen falls back to a drawn stand-in, and it can
   * only do that if it can tell there is nothing to show.
   */
  test("no photograph from the gateway means no key", async () => {
    const userId = await verifiedAadhaar();

    const rows = await owner.sql.unsafe(
      `SELECT aadhaar_photo_key FROM kyc_records WHERE user_id = '${userId}'`,
    );

    expect((rows[0] as Record<string, unknown>).aadhaar_photo_key).toBeNull();
  });

  /**
   * And wherever a photograph does arrive, the row must hold a key and never
   * the image.
   *
   * Asserted as a negative on the whole row because the failure worth
   * catching is a base64 JPEG landing in some column — it would work, and it
   * would then be copied into every backup and replica.
   */
  test("no base64 image is stored on the record", async () => {
    const userId = await verifiedAadhaar();

    const rows = await owner.sql.unsafe(
      `SELECT * FROM kyc_records WHERE user_id = '${userId}'`,
    );
    const row = rows[0] as Record<string, unknown>;

    for (const [column, value] of Object.entries(row)) {
      if (typeof value === "string") {
        expect(value, `${column} holds image data`).not.toMatch(/^data:image\//);
        expect(value.length, `${column} is suspiciously large`).toBeLessThan(512);
      }
    }
  });
});

/* ------------------------------------------------------------------ */

describe("deciding more than once", () => {
  /**
   * Re-submitting a PAN is a supported retry, and it must not 500.
   *
   * `canTransition` treats from === to as illegal and `applyKycDecision`
   * throws on an illegal move, so a second PAN submission re-deciding to the
   * same MANUAL_REVIEW would have become a server error on a request that
   * used to succeed. This is that regression, written down.
   */
  test("submitting the same PAN again does not fail", async () => {
    const userId = await verifiedAadhaar();
    const pan = somePan();

    await http().post("/v1/kyc/pan").set(as(userId)).send({ pan }).expect(201);
    await http().post("/v1/kyc/pan").set(as(userId)).send({ pan }).expect(201);

    const me = await http().get("/v1/kyc/me").set(as(userId)).expect(200);
    expect(me.body.status).toBe("MANUAL_REVIEW");
  });

  /**
   * A cleared subject cannot be reopened by typing a PAN again.
   *
   * This is the serious half of the same bug. `rememberPan` used to set
   * IN_PROGRESS on every call with a bare UPDATE — no lock, no
   * `canTransition` — so a VERIFIED record could be dragged backwards by a
   * repeat submission, which is exactly the move the status machine exists to
   * forbid. Re-KYC starts a new record; reopening a cleared one is a
   * deliberate, logged action.
   *
   * The status is set directly here because the step flow cannot reach
   * VERIFIED yet (no selfie step), and the guard has to be proven now rather
   * than when it is load-bearing.
   */
  test("a verified record is not reopened by resubmitting a PAN", async () => {
    const userId = await verifiedAadhaar();
    const pan = somePan();
    await http().post("/v1/kyc/pan").set(as(userId)).send({ pan }).expect(201);

    await owner.sql.unsafe(
      `UPDATE kyc_records SET status = 'VERIFIED' WHERE user_id = '${userId}'`,
    );

    await http().post("/v1/kyc/pan").set(as(userId)).send({ pan }).expect(201);

    const rows = await owner.sql.unsafe(
      `SELECT status FROM kyc_records WHERE user_id = '${userId}'`,
    );
    expect((rows[0] as Record<string, unknown>).status).toBe("VERIFIED");
  });

  /** And the no-op decision is not written as a second decision. */
  test("an unchanged decision is not recorded twice", async () => {
    const userId = await verifiedAadhaar();
    const pan = somePan();

    await http().post("/v1/kyc/pan").set(as(userId)).send({ pan }).expect(201);
    await http().post("/v1/kyc/pan").set(as(userId)).send({ pan }).expect(201);

    const rows = await owner.sql.unsafe(
      `SELECT count(*) AS n
         FROM kyc_checks c
         JOIN kyc_records r ON r.id = c.kyc_record_id
        WHERE r.user_id = '${userId}' AND c.check_type = 'PAN'`,
    );

    /** The first submission decided; the second had nothing new to say. */
    expect(Number((rows[0] as Record<string, unknown>).n)).toBe(1);
  });
});

/* ------------------------------------------------------------------ */

describe("what does not reach a decision", () => {
  /**
   * PAN is the trigger, so a person who has only done Aadhaar is untouched.
   *
   * Deciding after every step would put half-finished people in the review
   * queue, which is noise for Ops and alarming for the person.
   */
  test("Aadhaar alone leaves the record in progress", async () => {
    const userId = await verifiedAadhaar();

    const me = await http().get("/v1/kyc/me").set(as(userId)).expect(200);

    expect(me.body.status).toBe("IN_PROGRESS");
    expect(me.body.reasonCodes).toEqual([]);
    expect(me.body.remainingSteps).toContain("PAN");
  });

  /** A refused PAN never reached the Department, so there is nothing to decide. */
  test("a PAN refused before the vendor call leaves the status alone", async () => {
    const userId = await consented();

    await http()
      .post("/v1/kyc/pan")
      .set(as(userId))
      .send({ pan: somePan() })
      .expect(400);

    const me = await http().get("/v1/kyc/me").set(as(userId)).expect(200);
    expect(me.body.status).toBe("NOT_STARTED");
  });
});
