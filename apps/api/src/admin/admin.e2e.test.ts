import { createClient, type DatabaseHandle } from "@kilowattx/db";
import { FakeKycProvider } from "@kilowattx/integrations";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../bootstrap.js";
import { loadConfig } from "../config.js";
import { DEV_STAFF_ROLES_HEADER, DEV_USER_HEADER } from "../common/session.js";

/**
 * The review queue over HTTP.
 *
 * The permission matrix is the point of this file. Support may clear a weak
 * face match; only Legal may decide a board resolution or a sale deed. Getting
 * that wrong means a support agent approving a company's authority to sign a
 * 25-year contract.
 */

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://kilowattx_app:local_dev_only@localhost:5434/kilowattx_api_test";
const OWNER_URL =
  process.env.OWNER_DATABASE_URL ??
  "postgresql://kilowattx:local_dev_only@localhost:5434/kilowattx_api_test";

const WEBHOOK_SECRET = "whsec_admin_testing_0000";
const BLIND_INDEX_KEY = Buffer.alloc(32, 17).toString("base64");

let app: NestExpressApplication;
let owner: DatabaseHandle;
let provider: FakeKycProvider;

function http() {
  return request(app.getHttpServer());
}

function asStaff(userId: string, roles: string) {
  return {
    [DEV_USER_HEADER]: userId,
    [DEV_STAFF_ROLES_HEADER]: roles,
  };
}

beforeAll(async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: DB_URL,
    KYC_PROVIDER: "fake",
    KYC_WEBHOOK_SECRET: WEBHOOK_SECRET,
    KYC_BLIND_INDEX_KEY: BLIND_INDEX_KEY,
    FILE_SIGNING_SECRET: "filesign_admin_testing_00000",
  } as NodeJS.ProcessEnv);

  provider = new FakeKycProvider({ webhookSecret: WEBHOOK_SECRET });
  app = await createApp({ config, kycProvider: provider });
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
});

/* ------------------------------------------------------------------ */

async function makeUser(phone: string, name: string): Promise<string> {
  const rows = await owner.sql<{ id: string }[]>`
    INSERT INTO users (phone_e164, display_name, phone_verified_at)
    VALUES (${phone}, ${name}, now()) RETURNING id
  `;
  return rows[0]!.id;
}

/**
 * Drives a real verification to MANUAL_REVIEW through the actual flow, rather
 * than inserting a row — so the case under review is one the system produced.
 */
async function caseInReview(
  scenario = "low_face_score",
): Promise<{ subjectId: string; recordId: string }> {
  const subjectId = await makeUser(
    `+9198160${Math.floor(Math.random() * 90000 + 10000)}`,
    "Ramesh Kumar Sharma",
  );

  const consent = await http()
    .post("/v1/kyc/consents")
    .set(DEV_USER_HEADER, subjectId)
    .send({ purpose: "KYC_VERIFICATION", noticeVersion: "2.1", locale: "en" })
    .expect(201);

  const session = await http()
    .post("/v1/kyc/sessions")
    .set(DEV_USER_HEADER, subjectId)
    .set("Idempotency-Key", `idem-admin-${Math.random().toString(36).slice(2)}`)
    .send({
      level: "FULL",
      role: "LAND_OWNER",
      consentId: consent.body.id,
      locale: "en",
      testScenario: scenario,
    })
    .expect(201);

  await http()
    .post(`/v1/dev/kyc-sessions/${session.body.vendorSessionId}/complete`)
    .expect(201);

  return { subjectId, recordId: session.body.kycRecordId };
}

/** Attaches a sale deed, which makes the case Legal's rather than support's. */
async function attachLandDeed(recordId: string, ownerUserId: string): Promise<void> {
  await owner.sql`
    INSERT INTO documents (owner_user_id, kyc_record_id, doc_type, storage_key, scan_status)
    VALUES (${ownerUserId}, ${recordId}, 'SALE_DEED',
            ${"kyc-docs/" + recordId + "/deed.pdf"}, 'CLEAN')
  `;
}

/* ------------------------------------------------------------------ */

describe("who can even see the queue", () => {
  test("a customer gets 404, not 403 — the path should not advertise itself", async () => {
    const subjectId = await makeUser("+919816000001", "Just A Customer");

    const response = await http()
      .get("/v1/admin/kyc/reviews")
      .set(DEV_USER_HEADER, subjectId)
      .expect(404);

    expect(response.body.code).toBe("NOT_FOUND");
  });

  test("an unauthenticated request is refused", async () => {
    await http().get("/v1/admin/kyc/reviews").expect(401);
  });

  test("staff see the queue", async () => {
    await caseInReview();
    const staffId = await makeUser("+919816000002", "R Iyer");

    const response = await http()
      .get("/v1/admin/kyc/reviews")
      .set(asStaff(staffId, "compliance"))
      .expect(200);

    expect(response.body.rows).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */

describe("the queue itself", () => {
  test("carries the reason, the score and how long it has waited", async () => {
    await caseInReview("low_face_score");
    const staffId = await makeUser("+919816000010", "R Iyer");

    const response = await http()
      .get("/v1/admin/kyc/reviews")
      .set(asStaff(staffId, "compliance"))
      .expect(200);

    const row = response.body.rows[0];
    expect(row.reasonCodes).toContain("FACE_MATCH_LOW");
    expect(row.faceMatchScore).toBeCloseTo(0.68, 2);
    expect(row.waitingHours).toBeGreaterThanOrEqual(0);
    expect(row.subjectName).toBe("Ramesh Kumar Sharma");
  });

  /** The reviewer needs the bar the score was judged against, not just the score. */
  test("serves the thresholds in force alongside it", async () => {
    await caseInReview();
    const staffId = await makeUser("+919816000011", "R Iyer");

    const response = await http()
      .get("/v1/admin/kyc/reviews")
      .set(asStaff(staffId, "compliance"))
      .expect(200);

    expect(response.body.thresholds.faceMatch).toBe(0.75);
  });

  test("reports queue size and the oldest case, for alerting", async () => {
    await caseInReview();
    await caseInReview();
    const staffId = await makeUser("+919816000012", "R Iyer");

    const response = await http()
      .get("/v1/admin/kyc/reviews")
      .set(asStaff(staffId, "compliance"))
      .expect(200);

    expect(response.body.health.open).toBe(2);
    expect(response.body.health.oldestHours).toBeGreaterThanOrEqual(0);
  });

  test("only MANUAL_REVIEW cases appear", async () => {
    await caseInReview("pass"); // ends VERIFIED
    const staffId = await makeUser("+919816000013", "R Iyer");

    const response = await http()
      .get("/v1/admin/kyc/reviews")
      .set(asStaff(staffId, "compliance"))
      .expect(200);

    expect(response.body.rows).toHaveLength(0);
  });

  /**
   * Shown rather than hidden. A reviewer who can see Legal's backlog without
   * being able to touch it is more useful than one for whom those cases do not
   * exist — otherwise nobody notices a week-old pile.
   */
  test("a case outside your remit is listed but marked unactionable", async () => {
    const { subjectId, recordId } = await caseInReview();
    await attachLandDeed(recordId, subjectId);

    const supportId = await makeUser("+919816000014", "S Rao");

    const response = await http()
      .get("/v1/admin/kyc/reviews")
      .set(asStaff(supportId, "support"))
      .expect(200);

    expect(response.body.rows).toHaveLength(1);
    expect(response.body.rows[0].caseType).toBe("LAND_DOCUMENTS");
    expect(response.body.rows[0].actionable).toBe(false);
  });

  test("the same case is actionable for Legal", async () => {
    const { subjectId, recordId } = await caseInReview();
    await attachLandDeed(recordId, subjectId);

    const legalId = await makeUser("+919816000015", "L Mehta");

    const response = await http()
      .get("/v1/admin/kyc/reviews")
      .set(asStaff(legalId, "legal"))
      .expect(200);

    expect(response.body.rows[0].actionable).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

/**
 * A KYB case belongs to an organisation, not a person, so `kyc_records.user_id`
 * is null. The queue joined only `users`, which meant every business case
 * showed a blank name — and a reviewer cannot pick a case out of a queue of
 * blanks.
 */
describe("business cases in the queue", () => {
  async function seedKybInReview(): Promise<string> {
    const orgs = await owner.sql<{ id: string }[]>`
      INSERT INTO organisations (legal_name, gstin, constitution, gst_status, kyb_status)
      VALUES ('Shreeji Textiles Private Limited',
              ${"08AADCS9012F1Z" + Math.random().toString(36).slice(2, 3).toUpperCase()},
              'Private Limited Company', 'ACTIVE', 'MANUAL_REVIEW')
      RETURNING id
    `;

    const records = await owner.sql<{ id: string }[]>`
      INSERT INTO kyc_records (subject_type, org_id, level, status, vendor, vendor_session_id, decision_reasons)
      VALUES ('ORGANISATION', ${orgs[0]!.id}, 'KYB', 'MANUAL_REVIEW', 'fake-kyb',
              ${"kyb:" + Math.random().toString(36).slice(2, 12)},
              ${JSON.stringify([{ code: "SIGNATORY_NOT_VERIFIED", detail: "The signatory has not finished their own KYC.", severity: "REVIEW" }])}::jsonb)
      RETURNING id
    `;

    return records[0]!.id;
  }

  test("the queue shows the business's legal name", async () => {
    await seedKybInReview();
    const legalId = await makeUser("+919817000001", "L Mehta");

    const response = await http()
      .get("/v1/admin/kyc/reviews")
      .set(asStaff(legalId, "legal"))
      .expect(200);

    expect(response.body.rows).toHaveLength(1);
    expect(response.body.rows[0].subjectName).toBe(
      "Shreeji Textiles Private Limited",
    );
  });

  test("it is typed as a business case, so only Legal can act", async () => {
    await seedKybInReview();
    const supportId = await makeUser("+919817000002", "S Rao");

    const response = await http()
      .get("/v1/admin/kyc/reviews")
      .set(asStaff(supportId, "support"))
      .expect(200);

    expect(response.body.rows[0].caseType).toBe("KYB");
    expect(response.body.rows[0].actionable).toBe(false);
  });

  test("the detail screen also names the business", async () => {
    const recordId = await seedKybInReview();
    const legalId = await makeUser("+919817000003", "L Mehta");

    const response = await http()
      .get(`/v1/admin/kyc/reviews/${recordId}`)
      .set(asStaff(legalId, "legal"))
      .expect(200);

    expect(response.body.subjectName).toBe("Shreeji Textiles Private Limited");
    expect(response.body.caseType).toBe("KYB");
  });

  test("a personal case still shows the person's name", async () => {
    await caseInReview();
    await seedKybInReview();
    const adminId = await makeUser("+919817000004", "Super Admin");

    const response = await http()
      .get("/v1/admin/kyc/reviews")
      .set(asStaff(adminId, "super_admin"))
      .expect(200);

    const names = response.body.rows.map((r: { subjectName: string }) => r.subjectName);
    expect(names).toContain("Ramesh Kumar Sharma");
    expect(names).toContain("Shreeji Textiles Private Limited");
  });
});

/* ------------------------------------------------------------------ */

describe("the case detail", () => {
  test("carries the evidence a reviewer decides on", async () => {
    const { recordId } = await caseInReview("low_face_score");
    const staffId = await makeUser("+919816000020", "R Iyer");

    const response = await http()
      .get(`/v1/admin/kyc/reviews/${recordId}`)
      .set(asStaff(staffId, "compliance"))
      .expect(200);

    const detail = response.body;
    expect(detail.status).toBe("MANUAL_REVIEW");
    expect(detail.reasons[0].detail).toMatch(/0\.68/);
    expect(detail.thresholdsUsed.faceMatch).toBe(0.75);
    /** One row per check performed, including the ones that failed. */
    expect(detail.checks.length).toBe(4);
    expect(detail.checks.some((c: { checkType: string }) => c.checkType === "FACE_MATCH")).toBe(true);
  });

  test("shows the activity timeline from the audit log", async () => {
    const { recordId } = await caseInReview();
    const staffId = await makeUser("+919816000021", "R Iyer");

    const response = await http()
      .get(`/v1/admin/kyc/reviews/${recordId}`)
      .set(asStaff(staffId, "compliance"))
      .expect(200);

    expect(response.body.timeline[0].action).toBe("kyc.decided");
  });

  test("masks the identifiers, even for staff", async () => {
    const { recordId } = await caseInReview();
    const staffId = await makeUser("+919816000022", "R Iyer");

    const response = await http()
      .get(`/v1/admin/kyc/reviews/${recordId}`)
      .set(asStaff(staffId, "compliance"))
      .expect(200);

    expect(response.body.panLast4).toMatch(/^[A-Z0-9]{4}$/);
    const serialised = JSON.stringify(response.body);
    /** Any full PAN, not just one literal. */
    expect(serialised).not.toMatch(/[A-Z]{5}[0-9]{4}[A-Z]/);
    expect(serialised).not.toMatch(/\b[2-9][0-9]{11}\b/);
  });

  test("an unknown case is a 404", async () => {
    const staffId = await makeUser("+919816000023", "R Iyer");

    await http()
      .get("/v1/admin/kyc/reviews/00000000-0000-0000-0000-000000000000")
      .set(asStaff(staffId, "compliance"))
      .expect(404);
  });
});

/* ------------------------------------------------------------------ */

describe("deciding a case", () => {
  test("approving moves it to VERIFIED", async () => {
    const { recordId } = await caseInReview();
    const staffId = await makeUser("+919816000030", "R Iyer");

    const response = await http()
      .post(`/v1/admin/kyc/reviews/${recordId}`)
      .set(asStaff(staffId, "compliance"))
      .send({
        action: "APPROVE",
        reasonCode: "FACE_MATCH_ACCEPTED_ON_REVIEW",
        note: "Aadhaar photo is from 2013. Same person.",
      })
      .expect(201);

    expect(response.body.status).toBe("VERIFIED");
  });

  test("the customer's own status reflects it immediately", async () => {
    const { subjectId, recordId } = await caseInReview();
    const staffId = await makeUser("+919816000031", "R Iyer");

    await http()
      .post(`/v1/admin/kyc/reviews/${recordId}`)
      .set(asStaff(staffId, "compliance"))
      .send({ action: "APPROVE", reasonCode: "OK" })
      .expect(201);

    const mine = await http()
      .get("/v1/kyc/me")
      .set(DEV_USER_HEADER, subjectId)
      .expect(200);

    expect(mine.body.status).toBe("VERIFIED");
  });

  test("rejecting moves it to REJECTED", async () => {
    const { recordId } = await caseInReview();
    const staffId = await makeUser("+919816000032", "R Iyer");

    const response = await http()
      .post(`/v1/admin/kyc/reviews/${recordId}`)
      .set(asStaff(staffId, "compliance"))
      .send({ action: "REJECT", reasonCode: "DOCUMENT_NOT_GENUINE" })
      .expect(201);

    expect(response.body.status).toBe("REJECTED");
  });

  test("asking for a re-upload returns the case to IN_PROGRESS", async () => {
    const { recordId } = await caseInReview();
    const staffId = await makeUser("+919816000033", "R Iyer");

    const response = await http()
      .post(`/v1/admin/kyc/reviews/${recordId}`)
      .set(asStaff(staffId, "compliance"))
      .send({ action: "REQUEST_RESUBMISSION", reasonCode: "SELFIE_TOO_DARK" })
      .expect(201);

    expect(response.body.status).toBe("IN_PROGRESS");
  });

  /** A reason code is what makes the audit log worth keeping. */
  test("a decision with no reason code is refused", async () => {
    const { recordId } = await caseInReview();
    const staffId = await makeUser("+919816000034", "R Iyer");

    const response = await http()
      .post(`/v1/admin/kyc/reviews/${recordId}`)
      .set(asStaff(staffId, "compliance"))
      .send({ action: "APPROVE" })
      .expect(400);

    expect(response.body.code).toBe("VALIDATION_FAILED");
  });

  test("an unknown action is refused", async () => {
    const { recordId } = await caseInReview();
    const staffId = await makeUser("+919816000035", "R Iyer");

    await http()
      .post(`/v1/admin/kyc/reviews/${recordId}`)
      .set(asStaff(staffId, "compliance"))
      .send({ action: "DELETE_EVERYTHING", reasonCode: "WHY_NOT" })
      .expect(400);
  });

  test("every decision leaves an audit row naming the reviewer", async () => {
    const { recordId } = await caseInReview();
    const staffId = await makeUser("+919816000036", "R Iyer");

    await http()
      .post(`/v1/admin/kyc/reviews/${recordId}`)
      .set(asStaff(staffId, "compliance"))
      .send({ action: "APPROVE", reasonCode: "OK", note: "Checked both photos." })
      .expect(201);

    const rows = await owner.sql<
      { action: string; actor_user_id: string; reason_code: string }[]
    >`SELECT action, actor_user_id, reason_code FROM audit_log WHERE action = 'kyc.reviewed'`;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_user_id).toBe(staffId);
    expect(rows[0]!.reason_code).toBe("OK");
  });
});

/* ------------------------------------------------------------------ */

describe("the permission matrix, over HTTP", () => {
  test("support can clear a personal case", async () => {
    const { recordId } = await caseInReview();
    const supportId = await makeUser("+919816000040", "S Rao");

    await http()
      .post(`/v1/admin/kyc/reviews/${recordId}`)
      .set(asStaff(supportId, "support"))
      .send({ action: "APPROVE", reasonCode: "OK" })
      .expect(201);
  });

  /**
   * The one that matters. A support agent must not be able to approve a sale
   * deed or a board resolution.
   */
  test("support cannot decide a land documents case", async () => {
    const { subjectId, recordId } = await caseInReview();
    await attachLandDeed(recordId, subjectId);

    const supportId = await makeUser("+919816000041", "S Rao");

    const response = await http()
      .post(`/v1/admin/kyc/reviews/${recordId}`)
      .set(asStaff(supportId, "support"))
      .send({ action: "APPROVE", reasonCode: "LOOKS_FINE" })
      .expect(403);

    expect(response.body.code).toBe("REVIEW_NOT_PERMITTED");
  });

  test("a refused decision changes nothing", async () => {
    const { subjectId, recordId } = await caseInReview();
    await attachLandDeed(recordId, subjectId);

    const supportId = await makeUser("+919816000042", "S Rao");

    await http()
      .post(`/v1/admin/kyc/reviews/${recordId}`)
      .set(asStaff(supportId, "support"))
      .send({ action: "APPROVE", reasonCode: "LOOKS_FINE" })
      .expect(403);

    const rows = await owner.sql<{ status: string }[]>`
      SELECT status FROM kyc_records WHERE id = ${recordId}
    `;
    expect(rows[0]!.status).toBe("MANUAL_REVIEW");
    expect(
      (await owner.sql`SELECT 1 FROM audit_log WHERE action = 'kyc.reviewed'`).length,
    ).toBe(0);
  });

  test("legal can decide the same land documents case", async () => {
    const { subjectId, recordId } = await caseInReview();
    await attachLandDeed(recordId, subjectId);

    const legalId = await makeUser("+919816000043", "L Mehta");

    await http()
      .post(`/v1/admin/kyc/reviews/${recordId}`)
      .set(asStaff(legalId, "legal"))
      .send({ action: "APPROVE", reasonCode: "DEED_VERIFIED" })
      .expect(201);
  });

  test("an engineer can decide nothing", async () => {
    const { recordId } = await caseInReview();
    const engineerId = await makeUser("+919816000044", "E Khan");

    await http()
      .post(`/v1/admin/kyc/reviews/${recordId}`)
      .set(asStaff(engineerId, "engineer"))
      .send({ action: "APPROVE", reasonCode: "SURE" })
      .expect(403);
  });

  test("a super admin can decide anything", async () => {
    const { subjectId, recordId } = await caseInReview();
    await attachLandDeed(recordId, subjectId);

    const adminId = await makeUser("+919816000045", "Super Admin");

    await http()
      .post(`/v1/admin/kyc/reviews/${recordId}`)
      .set(asStaff(adminId, "super_admin"))
      .send({ action: "APPROVE", reasonCode: "ESCALATED" })
      .expect(201);
  });
});

/* ------------------------------------------------------------------ */

describe("two reviewers, one queue", () => {
  /**
   * A stale queue page. The first reviewer decides; the second clicks approve
   * on a row that no longer needs deciding. The state machine refuses it, and
   * the API says so in a way the UI can act on.
   */
  test("the second decision on a settled case is a conflict", async () => {
    const { recordId } = await caseInReview();
    const firstId = await makeUser("+919816000050", "R Iyer");
    const secondId = await makeUser("+919816000051", "P Shah");

    await http()
      .post(`/v1/admin/kyc/reviews/${recordId}`)
      .set(asStaff(firstId, "compliance"))
      .send({ action: "APPROVE", reasonCode: "OK" })
      .expect(201);

    const response = await http()
      .post(`/v1/admin/kyc/reviews/${recordId}`)
      .set(asStaff(secondId, "compliance"))
      .send({ action: "REJECT", reasonCode: "ACTUALLY_NO" })
      .expect(409);

    expect(response.body.code).toBe("CASE_ALREADY_DECIDED");
  });

  /** Nobody approves their own verification, even holding the permission. */
  test("a reviewer cannot decide their own case", async () => {
    const { subjectId, recordId } = await caseInReview();

    const response = await http()
      .post(`/v1/admin/kyc/reviews/${recordId}`)
      .set(asStaff(subjectId, "compliance"))
      .send({ action: "APPROVE", reasonCode: "LOOKS_FINE_TO_ME" })
      .expect(403);

    expect(response.body.code).toBe("SELF_REVIEW_REFUSED");
  });
});
