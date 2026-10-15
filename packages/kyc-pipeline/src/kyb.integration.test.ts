import { DEFAULT_KYC_THRESHOLDS } from "@kilowattx/core";
import { createClient, withContext, type Database, type DatabaseHandle } from "@kilowattx/db";
import { FakeKybProvider } from "@kilowattx/integrations";
import { gstinCheckDigit } from "@kilowattx/validation";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { applyKybDecision, linkSignatory, recordCompanyLookup, startKyb } from "./kyb.js";

/**
 * The Commercial User path.
 *
 * Two separate questions, and both must pass before a PPA can be signed: the
 * business is real and in good standing, and the person about to sign is
 * allowed to bind it. The guide is firm that these are independent — a
 * perfectly good company whose signatory is unverified is not a verified
 * business.
 */

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://kilowattx_app:local_dev_only@localhost:5434/kilowattx_pipeline_test";
const OWNER_URL =
  process.env.OWNER_DATABASE_URL ??
  "postgresql://kilowattx:local_dev_only@localhost:5434/kilowattx_pipeline_test";

const NOW = new Date("2026-10-09T19:00:00.000Z");

let app: DatabaseHandle;
let owner: DatabaseHandle;
let db: Database;
const kyb = new FakeKybProvider();

/** A checksum-valid GSTIN around a chosen business PAN and entity number. */
function gstinFor(stateCode: string, pan: string, entity = "1"): string {
  const first14 = `${stateCode}${pan}${entity}Z`;
  return first14 + gstinCheckDigit(first14);
}

const COMPANY_GSTIN = gstinFor("08", "AADCS9012F");
const PROPRIETOR_GSTIN = gstinFor("08", "ABCPS4412K");
const CANCELLED_GSTIN = gstinFor("08", "AADCS9012F", "9");
/**
 * CINs built to agree with the GSTIN's legal name.
 *
 * In the fake, the MCA name and the GST name are two separate derivations, so
 * a consistent pair has to be constructed. `cinForGstin` does that; any other
 * CIN reaches the name-mismatch path.
 */
const COMPANY_CIN = kyb.cinForGstin(COMPANY_GSTIN);
const STRUCK_OFF_CIN = kyb.cinForGstin(COMPANY_GSTIN, "NPL");
const UNRELATED_CIN = "U17299RJ2017PTC058441";

beforeAll(() => {
  app = createClient({ url: DB_URL, maxConnections: 10 });
  owner = createClient({ url: OWNER_URL, maxConnections: 4 });
  db = app.db;
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

async function makeUser(name: string, status = "VERIFIED"): Promise<string> {
  const people = await owner.sql<{ id: string }[]>`
    INSERT INTO users (phone_e164, display_name, phone_verified_at)
    VALUES (${"+9198260" + Math.floor(Math.random() * 90000 + 10000)}, ${name}, now())
    RETURNING id
  `;
  const userId = people[0]!.id;

  await owner.sql`
    INSERT INTO kyc_records (subject_type, user_id, level, status, vendor, vendor_session_id)
    VALUES ('PERSON', ${userId}, 'FULL', ${status}, 'fake',
            ${"sess_" + Math.random().toString(36).slice(2, 12)})
  `;

  return userId;
}

async function begin(gstin: string) {
  const lookup = await kyb.lookupGstin(gstin);
  return withContext(db, { role: "system" }, (tx) =>
    startKyb(tx, { lookup, now: NOW }),
  );
}

async function decide(orgId: string) {
  return withContext(db, { role: "system" }, (tx) =>
    applyKybDecision(tx, { orgId, thresholds: DEFAULT_KYC_THRESHOLDS, now: NOW }),
  );
}

/* ------------------------------------------------------------------ */

describe("starting a KYB from a GSTIN", () => {
  test("creates the organisation from the lookup", async () => {
    const { orgId } = await begin(COMPANY_GSTIN);

    const rows = await owner.sql<
      {
        gstin: string;
        legal_name: string;
        constitution: string;
        gst_status: string;
        state_code: string;
        business_pan_last4: string;
      }[]
    >`SELECT gstin, legal_name, constitution, gst_status, state_code, business_pan_last4
      FROM organisations WHERE id = ${orgId}`;

    expect(rows[0]!.gstin).toBe(COMPANY_GSTIN);
    expect(rows[0]!.legal_name).toContain("Private Limited");
    expect(rows[0]!.gst_status).toBe("ACTIVE");
    expect(rows[0]!.state_code).toBe("08");
  });

  /**
   * The business PAN is inside the GSTIN, so it is derived rather than asked
   * for. Only the last four are stored — the same rule as a personal PAN.
   */
  test("derives the business PAN from the GSTIN and stores only the last four", async () => {
    const { orgId } = await begin(COMPANY_GSTIN);

    const rows = await owner.sql<{ business_pan_last4: string }[]>`
      SELECT business_pan_last4 FROM organisations WHERE id = ${orgId}
    `;
    expect(rows[0]!.business_pan_last4).toBe("012F");
  });

  /** A KYB case is a kyc_record like any other, so all the machinery applies. */
  test("opens a KYB kyc_record against the organisation", async () => {
    const { orgId, kycRecordId } = await begin(COMPANY_GSTIN);

    const rows = await owner.sql<
      { subject_type: string; level: string; status: string; org_id: string; user_id: string | null }[]
    >`SELECT subject_type, level, status, org_id, user_id FROM kyc_records WHERE id = ${kycRecordId}`;

    expect(rows[0]!.subject_type).toBe("ORGANISATION");
    expect(rows[0]!.level).toBe("KYB");
    expect(rows[0]!.status).toBe("IN_PROGRESS");
    expect(rows[0]!.org_id).toBe(orgId);
    expect(rows[0]!.user_id).toBeNull();
  });

  test("records the GST lookup as a check", async () => {
    await begin(COMPANY_GSTIN);

    const rows = await owner.sql<{ check_type: string; status: string }[]>`
      SELECT check_type, status FROM kyc_checks
    `;
    expect(rows.map((r) => r.check_type)).toContain("GST");
    expect(rows[0]!.status).toBe("PASSED");
  });

  test("a cancelled registration is recorded as a failed check", async () => {
    await begin(CANCELLED_GSTIN);

    const rows = await owner.sql<{ check_type: string; status: string }[]>`
      SELECT check_type, status FROM kyc_checks WHERE check_type = 'GST'
    `;
    expect(rows[0]!.status).toBe("FAILED");
  });

  /**
   * One organisation per GSTIN. Two would split the invoice history, and the
   * guide is explicit that the GSTIN is the business's identity.
   */
  test("the same GSTIN twice returns the same organisation", async () => {
    const first = await begin(COMPANY_GSTIN);
    const second = await begin(COMPANY_GSTIN);

    expect(second.orgId).toBe(first.orgId);
    expect(second.kycRecordId).toBe(first.kycRecordId);

    const rows = await owner.sql<{ c: string }[]>`
      SELECT count(*)::text AS c FROM organisations
    `;
    expect(rows[0]!.c).toBe("1");
  });

  test("the lookup is refreshed on a second start", async () => {
    const { orgId } = await begin(COMPANY_GSTIN);
    await owner.sql`UPDATE organisations SET gst_status = 'UNKNOWN' WHERE id = ${orgId}`;

    await begin(COMPANY_GSTIN);

    const rows = await owner.sql<{ gst_status: string }[]>`
      SELECT gst_status FROM organisations WHERE id = ${orgId}
    `;
    expect(rows[0]!.gst_status).toBe("ACTIVE");
  });

  /**
   * The constitution decides what is needed next, and it comes out of the
   * GSTIN's embedded PAN rather than from a question put to the user.
   */
  test("a company is reported as needing a CIN", async () => {
    const { requiresCompanyRegister } = await begin(COMPANY_GSTIN);
    expect(requiresCompanyRegister).toBe(true);
  });

  test("a proprietorship is not", async () => {
    const { requiresCompanyRegister } = await begin(PROPRIETOR_GSTIN);
    expect(requiresCompanyRegister).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe("the company register", () => {
  test("stores the CIN and records the check", async () => {
    const { orgId } = await begin(COMPANY_GSTIN);
    const lookup = await kyb.lookupCin(COMPANY_CIN);

    await withContext(db, { role: "system" }, (tx) =>
      recordCompanyLookup(tx, { orgId, lookup }),
    );

    const orgs = await owner.sql<{ cin_or_llpin: string }[]>`
      SELECT cin_or_llpin FROM organisations WHERE id = ${orgId}
    `;
    const checks = await owner.sql<{ status: string }[]>`
      SELECT status FROM kyc_checks WHERE check_type = 'CIN'
    `;

    expect(orgs[0]!.cin_or_llpin).toBe(COMPANY_CIN);
    expect(checks[0]!.status).toBe("PASSED");
  });

  test("a struck-off company is recorded as a failed check", async () => {
    const { orgId } = await begin(COMPANY_GSTIN);
    const lookup = await kyb.lookupCin(STRUCK_OFF_CIN);

    await withContext(db, { role: "system" }, (tx) =>
      recordCompanyLookup(tx, { orgId, lookup }),
    );

    const checks = await owner.sql<{ status: string; detail: string }[]>`
      SELECT status, detail FROM kyc_checks WHERE check_type = 'CIN'
    `;
    expect(checks[0]!.status).toBe("FAILED");
    expect(checks[0]!.detail).toMatch(/STRUCK_OFF/);
  });

  test("a CIN for an unknown organisation is refused", async () => {
    const lookup = await kyb.lookupCin(COMPANY_CIN);

    await expect(
      withContext(db, { role: "system" }, (tx) =>
        recordCompanyLookup(tx, {
          orgId: "00000000-0000-0000-0000-000000000000",
          lookup,
        }),
      ),
    ).rejects.toThrow(/not found/i);
  });
});

/* ------------------------------------------------------------------ */

describe("the authorised signatory", () => {
  test("is linked to the organisation with their authority document", async () => {
    const { orgId } = await begin(COMPANY_GSTIN);
    const userId = await makeUser("Nikhil Desai");

    const docs = await owner.sql<{ id: string }[]>`
      INSERT INTO documents (owner_user_id, doc_type, storage_key)
      VALUES (${userId}, 'BOARD_RESOLUTION', ${"kyc-docs/" + orgId + "/board.pdf"})
      RETURNING id
    `;

    await withContext(db, { role: "system" }, (tx) =>
      linkSignatory(tx, {
        orgId,
        userId,
        authorityDocumentId: docs[0]!.id,
        now: NOW,
      }),
    );

    const rows = await owner.sql<
      { role: string; authority_document_id: string; authority_approved_at: string | null }[]
    >`SELECT role, authority_document_id, authority_approved_at FROM org_members WHERE org_id = ${orgId}`;

    expect(rows[0]!.role).toBe("SIGNATORY");
    expect(rows[0]!.authority_document_id).toBe(docs[0]!.id);
    /** Legal approves the document; linking it does not. */
    expect(rows[0]!.authority_approved_at).toBeNull();
  });

  test("linking the same person twice does not duplicate them", async () => {
    const { orgId } = await begin(COMPANY_GSTIN);
    const userId = await makeUser("Nikhil Desai");

    await withContext(db, { role: "system" }, (tx) =>
      linkSignatory(tx, { orgId, userId, now: NOW }),
    );
    await withContext(db, { role: "system" }, (tx) =>
      linkSignatory(tx, { orgId, userId, now: NOW }),
    );

    const rows = await owner.sql<{ c: string }[]>`
      SELECT count(*)::text AS c FROM org_members WHERE org_id = ${orgId}
    `;
    expect(rows[0]!.c).toBe("1");
  });
});

/* ------------------------------------------------------------------ */

describe("deciding the KYB", () => {
  async function fullyPrepared(gstin = COMPANY_GSTIN, cin = COMPANY_CIN) {
    const { orgId, kycRecordId } = await begin(gstin);
    const userId = await makeUser("Nikhil Desai", "VERIFIED");

    await withContext(db, { role: "system" }, async (tx) => {
      await recordCompanyLookup(tx, { orgId, lookup: await kyb.lookupCin(cin) });
      await linkSignatory(tx, { orgId, userId, now: NOW });
    });

    return { orgId, kycRecordId, userId };
  }

  test("an active business with a verified signatory is verified", async () => {
    const { orgId } = await fullyPrepared();

    const outcome = await decide(orgId);
    expect(outcome.status).toBe("VERIFIED");
  });

  /**
   * The denormalised mirror on `organisations` is what the PPA guard reads,
   * so it has to move with the record or the gate stays shut on a verified
   * business.
   */
  test("the organisation's own kyb_status is kept in step", async () => {
    const { orgId } = await fullyPrepared();
    await decide(orgId);

    const rows = await owner.sql<{ kyb_status: string }[]>`
      SELECT kyb_status FROM organisations WHERE id = ${orgId}
    `;
    expect(rows[0]!.kyb_status).toBe("VERIFIED");
  });

  test("it emits an outbox event and an audit row", async () => {
    const { orgId } = await fullyPrepared();
    await decide(orgId);

    const outbox = await owner.sql<{ event_type: string }[]>`
      SELECT event_type FROM outbox_events
    `;
    const audit = await owner.sql<{ action: string }[]>`
      SELECT action FROM audit_log
    `;
    expect(outbox[0]!.event_type).toBe("kyc.verified");
    expect(audit[0]!.action).toBe("kyc.decided");
  });

  /** Two independent gates. A good company with an unverified signatory fails. */
  test("an unverified signatory holds the whole KYB in review", async () => {
    const { orgId } = await begin(COMPANY_GSTIN);
    const userId = await makeUser("Nikhil Desai", "MANUAL_REVIEW");

    await withContext(db, { role: "system" }, async (tx) => {
      await recordCompanyLookup(tx, { orgId, lookup: await kyb.lookupCin(COMPANY_CIN) });
      await linkSignatory(tx, { orgId, userId, now: NOW });
    });

    const outcome = await decide(orgId);
    expect(outcome.status).toBe("MANUAL_REVIEW");
    expect(outcome.decision.reasons.map((r) => r.code)).toContain(
      "SIGNATORY_NOT_VERIFIED",
    );
  });

  test("no signatory at all also holds it in review", async () => {
    const { orgId } = await begin(COMPANY_GSTIN);
    await withContext(db, { role: "system" }, async (tx) => {
      await recordCompanyLookup(tx, { orgId, lookup: await kyb.lookupCin(COMPANY_CIN) });
    });

    const outcome = await decide(orgId);
    expect(outcome.status).toBe("MANUAL_REVIEW");
    expect(outcome.decision.reasons.map((r) => r.code)).toContain(
      "SIGNATORY_NOT_VERIFIED",
    );
  });

  test("a cancelled GST registration is rejected", async () => {
    const { orgId } = await begin(CANCELLED_GSTIN);
    const userId = await makeUser("Nikhil Desai");
    await withContext(db, { role: "system" }, (tx) =>
      linkSignatory(tx, { orgId, userId, now: NOW }),
    );

    const outcome = await decide(orgId);
    expect(outcome.status).toBe("REJECTED");
    expect(outcome.decision.reasons.map((r) => r.code)).toContain("GST_CANCELLED");
  });

  /** The check that did not exist before: an active GSTIN on a dead company. */
  test("a struck-off company is rejected even with an active GSTIN", async () => {
    const { orgId } = await fullyPrepared(COMPANY_GSTIN, STRUCK_OFF_CIN);

    const outcome = await decide(orgId);
    expect(outcome.status).toBe("REJECTED");
    expect(outcome.decision.reasons.map((r) => r.code)).toContain(
      "COMPANY_NOT_ACTIVE",
    );
  });

  /**
   * A proprietorship's KYB is the owner's own personal KYC, so no CIN is
   * required and its absence must not block.
   */
  test("a proprietorship verifies with no company register at all", async () => {
    const { orgId } = await begin(PROPRIETOR_GSTIN);
    const userId = await makeUser("Ramesh Kumar Sharma", "VERIFIED");
    await withContext(db, { role: "system" }, (tx) =>
      linkSignatory(tx, { orgId, userId, now: NOW }),
    );

    const outcome = await decide(orgId);
    expect(outcome.status).toBe("VERIFIED");
  });

  test("deciding twice is refused by the state machine", async () => {
    const { orgId } = await fullyPrepared();
    await decide(orgId);

    await expect(decide(orgId)).rejects.toThrow(/Illegal KYC transition/);
  });

  test("an unknown organisation is refused", async () => {
    await expect(decide("00000000-0000-0000-0000-000000000000")).rejects.toThrow(
      /not found/i,
    );
  });
});
