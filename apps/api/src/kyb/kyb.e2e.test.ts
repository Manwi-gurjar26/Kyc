import { createClient, type DatabaseHandle } from "@kilowattx/db";
import { FakeKybProvider, FakeKycProvider } from "@kilowattx/integrations";
import { gstinCheckDigit } from "@kilowattx/validation";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../bootstrap.js";
import { loadConfig } from "../config.js";
import { DEV_USER_HEADER } from "../common/session.js";

/**
 * The Commercial User path over HTTP.
 *
 * Two independent gates before a PPA can be signed: the business is real and
 * in good standing, and the person about to sign is allowed to bind it.
 */

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://kilowattx_app:local_dev_only@localhost:5434/kilowattx_api_test";
const OWNER_URL =
  process.env.OWNER_DATABASE_URL ??
  "postgresql://kilowattx:local_dev_only@localhost:5434/kilowattx_api_test";

const WEBHOOK_SECRET = "whsec_kyb_e2e_testing_0";
const BLIND_INDEX_KEY = Buffer.alloc(32, 41).toString("base64");

const kybProvider = new FakeKybProvider();

function gstinFor(stateCode: string, pan: string, entity = "1"): string {
  const first14 = `${stateCode}${pan}${entity}Z`;
  return first14 + gstinCheckDigit(first14);
}

const COMPANY_GSTIN = gstinFor("08", "AADCS9012F");
const PROPRIETOR_GSTIN = gstinFor("08", "ABCPS4412K");
/** A second company, so one person can be a signatory of two. */
const SECOND_COMPANY_GSTIN = gstinFor("06", "AAFCT1234M");
const CANCELLED_GSTIN = gstinFor("08", "AADCS9012F", "9");
const COMPANY_CIN = kybProvider.cinForGstin(COMPANY_GSTIN);
const STRUCK_OFF_CIN = kybProvider.cinForGstin(COMPANY_GSTIN, "NPL");
/** A valid CIN for a different company, so the names disagree. */
const UNRELATED_CIN = "U17299RJ2017PTC999999";

let app: NestExpressApplication;
let owner: DatabaseHandle;
let kycProvider: FakeKycProvider;

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
    FILE_SIGNING_SECRET: "filesign_kyb_testing_00000",
  } as NodeJS.ProcessEnv);

  kycProvider = new FakeKycProvider({ webhookSecret: WEBHOOK_SECRET });
  app = await createApp({ config, kycProvider, kybProvider });
  await app.init();

  owner = createClient({ url: OWNER_URL, maxConnections: 4 });
});

afterAll(async () => {
  await app.close();
  await owner.close();
});

beforeEach(async () => {
  await owner.sql.unsafe(`
    TRUNCATE TABLE notification_deliveries, audit_log, outbox_events, kyc_checks,
      documents, land_parcels, org_members, kyc_records,
      organisations, consent_records, seen_webhook_events, users
    RESTART IDENTITY CASCADE
  `);
});

/* ------------------------------------------------------------------ */

async function signedUpUser(): Promise<string> {
  const rows = await owner.sql<{ id: string }[]>`
    INSERT INTO users (phone_e164, display_name, phone_verified_at)
    VALUES (${"+9198270" + Math.floor(Math.random() * 90000 + 10000)}, 'Nikhil Desai', now())
    RETURNING id
  `;
  return rows[0]!.id;
}

/** Gives KYB consent, which every business step requires first. */
async function withKybConsent(userId: string): Promise<void> {
  await http()
    .post("/v1/kyc/consents")
    .set(DEV_USER_HEADER, userId)
    .send({ purpose: "KYB_VERIFICATION", noticeVersion: "2.1", locale: "en" })
    .expect(201);
}

/** Takes the caller's own personal KYC to VERIFIED through the real flow. */
async function verifyPersonally(userId: string): Promise<void> {
  const consent = await http()
    .post("/v1/kyc/consents")
    .set(DEV_USER_HEADER, userId)
    .send({ purpose: "KYC_VERIFICATION", noticeVersion: "2.1", locale: "en" })
    .expect(201);

  const session = await http()
    .post("/v1/kyc/sessions")
    .set(DEV_USER_HEADER, userId)
    .set("Idempotency-Key", `kyb-sig-${Math.random().toString(36).slice(2)}`)
    .send({
      level: "FULL",
      role: "SIGNATORY",
      consentId: consent.body.id,
      locale: "en",
      testScenario: "pass",
    })
    .expect(201);

  await http()
    .post(`/v1/dev/kyc-sessions/${session.body.vendorSessionId}/complete`)
    .expect(201);
}

async function startBusiness(userId: string, gstin = COMPANY_GSTIN) {
  return http()
    .post("/v1/kyb/organisations")
    .set(DEV_USER_HEADER, userId)
    .send({ gstin })
    .expect(201);
}

/* ------------------------------------------------------------------ */

describe("starting from a GSTIN", () => {
  test("consent is required first", async () => {
    const userId = await signedUpUser();

    const response = await http()
      .post("/v1/kyb/organisations")
      .set(DEV_USER_HEADER, userId)
      .send({ gstin: COMPANY_GSTIN })
      .expect(400);

    expect(response.body.code).toBe("CONSENT_REQUIRED");
  });

  test("one GSTIN is all we ask for", async () => {
    const userId = await signedUpUser();
    await withKybConsent(userId);

    const response = await startBusiness(userId);

    expect(response.body.legalName).toContain("Private Limited");
    expect(response.body.constitution).toMatch(/company/i);
    expect(response.body.gstStatus).toBe("ACTIVE");
    expect(response.body.stateCode).toBe("08");
  });

  /**
   * The business PAN lives inside the GSTIN; only its last four are stored as
   * a field of their own.
   *
   * The GSTIN itself is returned, and that is correct: it is the customer's
   * own identifier, printed on every invoice they issue and publicly
   * searchable on the GST portal. It is not a secret, and the business cannot
   * be identified without it.
   *
   * So the claim is narrower than "no PAN anywhere" — it is that no PAN
   * appears OUTSIDE the GSTIN, which is what a naive assertion gets wrong
   * because characters 3 to 12 of a GSTIN *are* a PAN.
   */
  test("the business PAN is derived and masked", async () => {
    const userId = await signedUpUser();
    await withKybConsent(userId);

    const response = await startBusiness(userId);

    expect(response.body.businessPanLast4).toBe("012F");

    const withoutGstin = JSON.stringify(response.body).replaceAll(
      response.body.gstin,
      "<gstin>",
    );
    expect(withoutGstin).not.toMatch(/[A-Z]{5}[0-9]{4}[A-Z]/);
  });

  test("a bad check digit is refused before any lookup", async () => {
    const userId = await signedUpUser();
    await withKybConsent(userId);

    const broken = COMPANY_GSTIN.slice(0, 14) + (COMPANY_GSTIN[14] === "A" ? "B" : "A");
    const response = await http()
      .post("/v1/kyb/organisations")
      .set(DEV_USER_HEADER, userId)
      .send({ gstin: broken })
      .expect(400);

    expect(response.body.code).toBe("VALIDATION_FAILED");
  });

  test("the same GSTIN twice is the same business", async () => {
    const userId = await signedUpUser();
    await withKybConsent(userId);

    const first = await startBusiness(userId);
    const second = await startBusiness(userId);

    expect(second.body.id).toBe(first.body.id);

    const rows = await owner.sql<{ c: string }[]>`
      SELECT count(*)::text AS c FROM organisations
    `;
    expect(rows[0]!.c).toBe("1");
  });

  test("a company is told it still needs its company register", async () => {
    const userId = await signedUpUser();
    await withKybConsent(userId);

    const response = await startBusiness(userId);

    expect(response.body.requiresCompanyRegister).toBe(true);
    expect(response.body.remainingSteps).toContain("COMPANY_REGISTER");
    expect(response.body.remainingSteps).toContain("SIGNATORY");
  });

  /** A proprietorship has no CIN, so it is never asked for one. */
  test("a proprietorship is not asked for a company register", async () => {
    const userId = await signedUpUser();
    await withKybConsent(userId);

    const response = await startBusiness(userId, PROPRIETOR_GSTIN);

    expect(response.body.requiresCompanyRegister).toBe(false);
    expect(response.body.remainingSteps).not.toContain("COMPANY_REGISTER");
  });

  /**
   * A cancelled registration is shown rather than thrown. "Your GST
   * registration shows as cancelled" is something the customer can act on; a
   * bare error is not.
   */
  test("a cancelled GSTIN is reported on screen, not refused outright", async () => {
    const userId = await signedUpUser();
    await withKybConsent(userId);

    const response = await startBusiness(userId, CANCELLED_GSTIN);

    expect(response.body.gstStatus).toBe("CANCELLED");
  });
});

/* ------------------------------------------------------------------ */

describe("the company register", () => {
  async function started() {
    const userId = await signedUpUser();
    await withKybConsent(userId);
    const org = await startBusiness(userId);
    return { userId, orgId: org.body.id as string };
  }

  test("records the CIN and clears that step", async () => {
    const { userId, orgId } = await started();

    const response = await http()
      .post(`/v1/kyb/organisations/${orgId}/company-register`)
      .set(DEV_USER_HEADER, userId)
      .send({ cin: COMPANY_CIN })
      .expect(201);

    expect(response.body.cinOrLlpin).toBe(COMPANY_CIN);
    expect(response.body.companyStatus).toBe("ACTIVE");
    expect(response.body.remainingSteps).not.toContain("COMPANY_REGISTER");
  });

  test("a struck-off company is recorded as such", async () => {
    const { userId, orgId } = await started();

    const response = await http()
      .post(`/v1/kyb/organisations/${orgId}/company-register`)
      .set(DEV_USER_HEADER, userId)
      .send({ cin: STRUCK_OFF_CIN })
      .expect(201);

    expect(response.body.companyStatus).toBe("STRUCK_OFF");
  });

  test("a malformed CIN is refused by validation", async () => {
    const { userId, orgId } = await started();

    await http()
      .post(`/v1/kyb/organisations/${orgId}/company-register`)
      .set(DEV_USER_HEADER, userId)
      .send({ cin: "nope" })
      .expect(400);
  });

  test("both a CIN and an LLPIN is refused", async () => {
    const { userId, orgId } = await started();

    const response = await http()
      .post(`/v1/kyb/organisations/${orgId}/company-register`)
      .set(DEV_USER_HEADER, userId)
      .send({ cin: COMPANY_CIN, llpin: "AAB-1234" })
      .expect(400);

    expect(response.body.code).toBe("VALIDATION_FAILED");
  });

  /**
   * An LLPIN is accepted by validation but has no lookup behind it. Storing it
   * and then deciding as though it had been checked would be worse than
   * refusing, so it refuses and says why.
   */
  test("an LLPIN says plainly that the lookup does not exist yet", async () => {
    const { userId, orgId } = await started();

    const response = await http()
      .post(`/v1/kyb/organisations/${orgId}/company-register`)
      .set(DEV_USER_HEADER, userId)
      .send({ llpin: "AAB-1234" })
      .expect(400);

    expect(response.body.code).toBe("LLP_LOOKUP_NOT_IMPLEMENTED");
  });

  test("a proprietorship is told the step does not apply", async () => {
    const userId = await signedUpUser();
    await withKybConsent(userId);
    const org = await startBusiness(userId, PROPRIETOR_GSTIN);

    const response = await http()
      .post(`/v1/kyb/organisations/${org.body.id}/company-register`)
      .set(DEV_USER_HEADER, userId)
      .send({ cin: COMPANY_CIN })
      .expect(400);

    expect(response.body.code).toBe("COMPANY_REGISTER_NOT_APPLICABLE");
  });

  test("an unknown business is a 404", async () => {
    const userId = await signedUpUser();
    await withKybConsent(userId);

    await http()
      .post("/v1/kyb/organisations/00000000-0000-0000-0000-000000000000/company-register")
      .set(DEV_USER_HEADER, userId)
      .send({ cin: COMPANY_CIN })
      .expect(404);
  });
});

/* ------------------------------------------------------------------ */

describe("the signatory", () => {
  async function readyForSignatory() {
    const userId = await signedUpUser();
    await withKybConsent(userId);
    const org = await startBusiness(userId);
    await http()
      .post(`/v1/kyb/organisations/${org.body.id}/company-register`)
      .set(DEV_USER_HEADER, userId)
      .send({ cin: COMPANY_CIN })
      .expect(201);
    return { userId, orgId: org.body.id as string };
  }

  test("the caller declares themselves", async () => {
    const { userId, orgId } = await readyForSignatory();

    const response = await http()
      .post(`/v1/kyb/organisations/${orgId}/signatory`)
      .set(DEV_USER_HEADER, userId)
      .send({})
      .expect(201);

    expect(response.body.signatory.userId).toBe(userId);
    expect(response.body.signatory.isCaller).toBe(true);
  });

  /**
   * Declaring intent is not the same as being verified. The UI needs to tell
   * the person which of the two is holding things up.
   */
  test("an unverified signatory shows as an outstanding step", async () => {
    const { userId, orgId } = await readyForSignatory();

    const response = await http()
      .post(`/v1/kyb/organisations/${orgId}/signatory`)
      .set(DEV_USER_HEADER, userId)
      .send({})
      .expect(201);

    expect(response.body.signatory.personalKycStatus).toBe("NOT_STARTED");
    expect(response.body.remainingSteps).toContain("SIGNATORY_PERSONAL_KYC");
  });

  test("once personally verified, nothing is outstanding", async () => {
    const { userId, orgId } = await readyForSignatory();
    await verifyPersonally(userId);

    const response = await http()
      .post(`/v1/kyb/organisations/${orgId}/signatory`)
      .set(DEV_USER_HEADER, userId)
      .send({})
      .expect(201);

    expect(response.body.signatory.personalKycStatus).toBe("VERIFIED");
    expect(response.body.remainingSteps).toHaveLength(0);
  });

  /** Linking a document is not approving it; Legal does that. */
  test("an authority document is recorded but not approved", async () => {
    const { userId, orgId } = await readyForSignatory();

    const docs = await owner.sql<{ id: string }[]>`
      INSERT INTO documents (owner_user_id, doc_type, storage_key)
      VALUES (${userId}, 'BOARD_RESOLUTION', ${"kyc-docs/" + orgId + "/board.pdf"})
      RETURNING id
    `;

    const response = await http()
      .post(`/v1/kyb/organisations/${orgId}/signatory`)
      .set(DEV_USER_HEADER, userId)
      .send({ authorityDocumentId: docs[0]!.id })
      .expect(201);

    expect(response.body.signatory.hasAuthorityDocument).toBe(true);
    expect(response.body.signatory.authorityApproved).toBe(false);
  });

  test("declaring twice does not create a second signatory", async () => {
    const { userId, orgId } = await readyForSignatory();

    await http()
      .post(`/v1/kyb/organisations/${orgId}/signatory`)
      .set(DEV_USER_HEADER, userId)
      .send({})
      .expect(201);
    await http()
      .post(`/v1/kyb/organisations/${orgId}/signatory`)
      .set(DEV_USER_HEADER, userId)
      .send({})
      .expect(201);

    const rows = await owner.sql<{ c: string }[]>`
      SELECT count(*)::text AS c FROM org_members WHERE org_id = ${orgId}
    `;
    expect(rows[0]!.c).toBe("1");
  });
});

/* ------------------------------------------------------------------ */

describe("submitting for a decision", () => {
  async function fullyPrepared(gstin = COMPANY_GSTIN, cin = COMPANY_CIN) {
    const userId = await signedUpUser();
    await withKybConsent(userId);
    await verifyPersonally(userId);

    const org = await startBusiness(userId, gstin);
    const orgId = org.body.id as string;

    if (org.body.requiresCompanyRegister) {
      await http()
        .post(`/v1/kyb/organisations/${orgId}/company-register`)
        .set(DEV_USER_HEADER, userId)
        .send({ cin })
        .expect(201);
    }

    await http()
      .post(`/v1/kyb/organisations/${orgId}/signatory`)
      .set(DEV_USER_HEADER, userId)
      .send({})
      .expect(201);

    return { userId, orgId };
  }

  test("a complete business check verifies", async () => {
    const { userId, orgId } = await fullyPrepared();

    const response = await http()
      .post(`/v1/kyb/organisations/${orgId}/submit`)
      .set(DEV_USER_HEADER, userId)
      .send({})
      .expect(201);

    expect(response.body.kybStatus).toBe("VERIFIED");
  });

  /**
   * Refused rather than decided on partial evidence. A KYB rejected for a
   * missing CIN nobody was asked for is a support call, not a decision.
   */
  test("submitting with a step outstanding is refused, and says which", async () => {
    const userId = await signedUpUser();
    await withKybConsent(userId);
    const org = await startBusiness(userId);

    const response = await http()
      .post(`/v1/kyb/organisations/${org.body.id}/submit`)
      .set(DEV_USER_HEADER, userId)
      .send({})
      .expect(400);

    expect(response.body.code).toBe("KYB_INCOMPLETE");
    expect(response.body.details.remainingSteps).toContain("COMPANY_REGISTER");
  });

  test("a cancelled GST registration is rejected", async () => {
    const { userId, orgId } = await fullyPrepared(CANCELLED_GSTIN);

    const response = await http()
      .post(`/v1/kyb/organisations/${orgId}/submit`)
      .set(DEV_USER_HEADER, userId)
      .send({})
      .expect(201);

    expect(response.body.kybStatus).toBe("REJECTED");
  });

  /** The check that did not exist before: active GSTIN, dead company. */
  test("a struck-off company is rejected despite an active GSTIN", async () => {
    const { userId, orgId } = await fullyPrepared(COMPANY_GSTIN, STRUCK_OFF_CIN);

    const response = await http()
      .post(`/v1/kyb/organisations/${orgId}/submit`)
      .set(DEV_USER_HEADER, userId)
      .send({})
      .expect(201);

    expect(response.body.kybStatus).toBe("REJECTED");
  });

  test("a company whose MCA name disagrees with GST goes to review", async () => {
    const { userId, orgId } = await fullyPrepared(COMPANY_GSTIN, UNRELATED_CIN);

    const response = await http()
      .post(`/v1/kyb/organisations/${orgId}/submit`)
      .set(DEV_USER_HEADER, userId)
      .send({})
      .expect(201);

    expect(response.body.kybStatus).toBe("MANUAL_REVIEW");
  });

  test("a proprietorship verifies with no company register", async () => {
    const { userId, orgId } = await fullyPrepared(PROPRIETOR_GSTIN);

    const response = await http()
      .post(`/v1/kyb/organisations/${orgId}/submit`)
      .set(DEV_USER_HEADER, userId)
      .send({})
      .expect(201);

    expect(response.body.kybStatus).toBe("VERIFIED");
  });

  test("submitting twice is a conflict", async () => {
    const { userId, orgId } = await fullyPrepared();

    await http()
      .post(`/v1/kyb/organisations/${orgId}/submit`)
      .set(DEV_USER_HEADER, userId)
      .send({})
      .expect(201);

    const response = await http()
      .post(`/v1/kyb/organisations/${orgId}/submit`)
      .set(DEV_USER_HEADER, userId)
      .send({})
      .expect(409);

    expect(response.body.code).toBe("KYB_ALREADY_DECIDED");
  });

  test("a review case reaches the review queue", async () => {
    const { userId, orgId } = await fullyPrepared(COMPANY_GSTIN, UNRELATED_CIN);
    await http()
      .post(`/v1/kyb/organisations/${orgId}/submit`)
      .set(DEV_USER_HEADER, userId)
      .send({})
      .expect(201);

    const legalId = await signedUpUser();
    const queue = await http()
      .get("/v1/admin/kyc/reviews")
      .set(DEV_USER_HEADER, legalId)
      .set("x-dev-staff-roles", "legal")
      .expect(200);

    const kybRow = queue.body.rows.find(
      (r: { caseType: string }) => r.caseType === "KYB",
    );
    expect(kybRow).toBeTruthy();
    expect(kybRow.subjectName).toContain("Private Limited");
    expect(kybRow.actionable).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe("reading a business", () => {
  test("an unauthenticated read is refused", async () => {
    await http()
      .get("/v1/kyb/organisations/00000000-0000-0000-0000-000000000000")
      .expect(401);
  });

  test("the view carries no PAN outside the GSTIN", async () => {
    const userId = await signedUpUser();
    await withKybConsent(userId);
    const org = await startBusiness(userId);

    const response = await http()
      .get(`/v1/kyb/organisations/${org.body.id}`)
      .set(DEV_USER_HEADER, userId)
      .expect(200);

    const withoutGstin = JSON.stringify(response.body).replaceAll(
      response.body.gstin,
      "<gstin>",
    );
    expect(withoutGstin).not.toMatch(/[A-Z]{5}[0-9]{4}[A-Z]/);
  });

  /**
   * The registered address is personal data and is stored encrypted, so it
   * must not come back in a view either — the placeholder marker would be a
   * dead giveaway if it did.
   */
  test("the view does not return the registered address", async () => {
    const userId = await signedUpUser();
    await withKybConsent(userId);
    const org = await startBusiness(userId);

    const response = await http()
      .get(`/v1/kyb/organisations/${org.body.id}`)
      .set(DEV_USER_HEADER, userId)
      .expect(200);

    expect(JSON.stringify(response.body)).not.toContain("PLACEHOLDER");
    expect(JSON.stringify(response.body)).not.toContain("RIICO");
  });
});

/* ------------------------------------------------------------------ */

/**
 * Signing the PPA — the gate the whole KYB flow leads to.
 *
 * Three facts have to be true, and they are genuinely three: the business is
 * verified, the person signing is verified, and somebody has approved that
 * person's authority to bind the business. The third was the one nothing
 * enforced — `org_members.authority_approved_at` existed and was shown in the
 * KYB view, so a verified finance clerk who had never been named on a board
 * resolution would have been allowed to commit their employer to a 25-year
 * agreement.
 */
describe("signing the PPA", () => {
  /**
   * Its own copy rather than the one in the describe above, which is not in
   * scope here. Kept to the shortest path that produces the state this block
   * is about.
   */
  async function business(gstin = COMPANY_GSTIN) {
    const userId = await signedUpUser();
    await withKybConsent(userId);
    await verifyPersonally(userId);

    const org = await startBusiness(userId, gstin);
    const orgId = org.body.id as string;

    if (org.body.requiresCompanyRegister) {
      await http()
        .post(`/v1/kyb/organisations/${orgId}/company-register`)
        .set(DEV_USER_HEADER, userId)
        .send({ cin: kybProvider.cinForGstin(gstin) })
        .expect(201);
    }

    await http()
      .post(`/v1/kyb/organisations/${orgId}/signatory`)
      .set(DEV_USER_HEADER, userId)
      .send({})
      .expect(201);

    return { userId, orgId };
  }

  async function verifiedBusiness() {
    const { userId, orgId } = await business();

    await http()
      .post(`/v1/kyb/organisations/${orgId}/submit`)
      .set(DEV_USER_HEADER, userId)
      .send({})
      .expect(201);

    return { userId, orgId };
  }

  async function canSign(userId: string, orgId?: string) {
    const response = await http()
      .get(`/v1/kyc/can/ESIGN_PPA${orgId ? `?orgId=${orgId}` : ""}`)
      .set(DEV_USER_HEADER, userId)
      .expect(200);
    return response.body as {
      allowed: boolean;
      code?: string;
      organisations?: { id: string }[];
    };
  }

  /** A second company for somebody who already has one. */
  async function secondBusinessFor(userId: string): Promise<string> {
    const org = await http()
      .post("/v1/kyb/organisations")
      .set(DEV_USER_HEADER, userId)
      .send({ gstin: SECOND_COMPANY_GSTIN })
      .expect(201);

    const orgId = org.body.id as string;

    if (org.body.requiresCompanyRegister) {
      await http()
        .post(`/v1/kyb/organisations/${orgId}/company-register`)
        .set(DEV_USER_HEADER, userId)
        .send({ cin: kybProvider.cinForGstin(SECOND_COMPANY_GSTIN) })
        .expect(201);
    }

    await http()
      .post(`/v1/kyb/organisations/${orgId}/signatory`)
      .set(DEV_USER_HEADER, userId)
      .send({})
      .expect(201);

    return orgId;
  }

  /** Approves the signatory's authority, the way Legal would. */
  async function approveAuthority(orgId: string, userId: string) {
    await owner.sql`
      UPDATE org_members SET authority_approved_at = now()
      WHERE org_id = ${orgId} AND user_id = ${userId} AND role = 'SIGNATORY'
    `;
  }

  test("somebody with no business cannot sign a PPA", async () => {
    const userId = await signedUpUser();

    const verdict = await canSign(userId);
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe("KYB_REQUIRED");
  });

  test("a verified business is not enough on its own", async () => {
    const { userId } = await verifiedBusiness();

    const verdict = await canSign(userId);
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe("SIGNATORY_AUTHORITY_REQUIRED");
  });

  test("with the authority approved, the PPA can be signed", async () => {
    const { userId, orgId } = await verifiedBusiness();
    await approveAuthority(orgId, userId);

    expect((await canSign(userId)).allowed).toBe(true);
  });

  /**
   * The KYB status is read, not assumed. Before this was wired the answer was
   * hardcoded to NOT_STARTED, so ESIGN_PPA refused everybody — correct by
   * accident, and permanently.
   */
  test("an unverified business is refused even with authority approved", async () => {
    const { userId, orgId } = await business();
    await approveAuthority(orgId, userId);

    const verdict = await canSign(userId, orgId);
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe("KYB_REQUIRED");
  });

  test("naming the business explicitly gives the same answer", async () => {
    const { userId, orgId } = await verifiedBusiness();
    await approveAuthority(orgId, userId);

    expect((await canSign(userId, orgId)).allowed).toBe(true);
  });

  /**
   * A PPA binds one organisation, so the question needs to name it. Picking
   * whichever company happens to be verified would answer yes about a
   * business nobody asked about.
   */
  test("a signatory of two businesses must say which", async () => {
    const { userId, orgId } = await verifiedBusiness();
    await approveAuthority(orgId, userId);

    /** A second company, unverified, with the same person as signatory. */
    const second = await secondBusinessFor(userId);

    const verdict = await canSign(userId);
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe("ORGANISATION_REQUIRED");
    expect(verdict.organisations).toHaveLength(2);
    expect(verdict.organisations!.map((o) => o.id)).toContain(second);
  });

  test("and naming one of them answers for that one", async () => {
    const { userId, orgId } = await verifiedBusiness();
    await approveAuthority(orgId, userId);

    const second = await secondBusinessFor(userId);

    expect((await canSign(userId, orgId)).allowed).toBe(true);
    expect((await canSign(userId, second)).allowed).toBe(false);
  });

  /** Another person's business is not one you can sign for. */
  test("naming a business you are not a signatory of is refused", async () => {
    const theirs = await verifiedBusiness();
    const outsider = await signedUpUser();

    const verdict = await canSign(outsider, theirs.orgId);
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe("KYB_REQUIRED");
  });
});

/* ------------------------------------------------------------------ */

/**
 * The free trial's duplicate-PAN gate.
 *
 * `can('START_TRIAL')` has a PAN_ALREADY_USED denial that was unreachable:
 * `panAlreadyUsed` was hardcoded false. The outcome was still safe — the
 * unique index and the decision function both refuse a second subject on the
 * same PAN — but the person was told "please complete the PAN check first",
 * which is not what went wrong and not something they can act on.
 */
describe("the free trial and a PAN somebody else has used", () => {
  async function canStartTrial(userId: string) {
    const response = await http()
      .get("/v1/kyc/can/START_TRIAL")
      .set(DEV_USER_HEADER, userId)
      .expect(200);
    return response.body as { allowed: boolean; code?: string };
  }

  test("a verified person can start a trial", async () => {
    const userId = await signedUpUser();
    await verifyPersonally(userId);

    expect((await canStartTrial(userId)).allowed).toBe(true);
  });

  /**
   * The record carries the reason the decision gave. Reading it is what makes
   * the gate reachable, and the message the person sees correct.
   */
  test("a record flagged as a duplicate PAN is told so, not told to try again", async () => {
    const userId = await signedUpUser();
    await verifyPersonally(userId);

    /** What applyVendorResult writes when the blind index already exists. */
    await owner.sql`
      UPDATE kyc_records
      SET status = 'MANUAL_REVIEW',
          decision_reasons = ${JSON.stringify([
            {
              code: "PAN_ALREADY_USED",
              detail: "This PAN is already on another subject.",
              severity: "HARD_FAIL",
            },
          ])}::jsonb
      WHERE user_id = ${userId}
    `;

    const verdict = await canStartTrial(userId);
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe("PAN_ALREADY_USED");
  });

  /** Any other review reason is not a duplicate PAN. */
  test("a record in review for something else is not called a duplicate", async () => {
    const userId = await signedUpUser();
    await verifyPersonally(userId);

    await owner.sql`
      UPDATE kyc_records
      SET status = 'MANUAL_REVIEW',
          decision_reasons = ${JSON.stringify([
            {
              code: "FACE_MATCH_LOW",
              detail: "Face match below the threshold.",
              severity: "REVIEW",
            },
          ])}::jsonb
      WHERE user_id = ${userId}
    `;

    const verdict = await canStartTrial(userId);
    expect(verdict.code).not.toBe("PAN_ALREADY_USED");
  });
});
