import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type DatabaseHandle } from "@kilowattx/db";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../bootstrap.js";
import { DEV_STAFF_ROLES_HEADER, DEV_USER_HEADER } from "../common/session.js";
import { loadConfig } from "../config.js";

/**
 * From an uploaded land record to a signable lease.
 *
 * This is the only path in the system where being verified is not enough. A
 * perfectly verified person can hand us the record for land they share with
 * four siblings, or land their neighbour already registered with us — so
 * `can('ESIGN_LEASE')` has to answer no in cases where `can('INVEST')` would
 * happily answer yes.
 */

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://kilowattx_app:local_dev_only@localhost:5434/kilowattx_api_test";
const OWNER_URL =
  process.env.OWNER_DATABASE_URL ??
  "postgresql://kilowattx:local_dev_only@localhost:5434/kilowattx_api_test";

const WEBHOOK_SECRET = "whsec_land_e2e_testing000";
const FILE_SECRET = "filesign_land_e2e_testing_0000";

let app: NestExpressApplication;
let owner: DatabaseHandle;
let bucketRoot: string;
let userId: string;
let neighbourId: string;
let reviewerId: string;

function http() {
  return request(app.getHttpServer());
}

function legal() {
  return { user: reviewerId, roles: "legal" };
}

beforeAll(async () => {
  bucketRoot = mkdtempSync(join(tmpdir(), "kwx-land-e2e-"));

  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: DB_URL,
    KYC_PROVIDER: "fake",
    KYC_WEBHOOK_SECRET: WEBHOOK_SECRET,
    KYC_BLIND_INDEX_KEY: Buffer.alloc(32, 29).toString("base64"),
    FILE_SIGNING_SECRET: FILE_SECRET,
    FILE_BUCKET_ROOT: bucketRoot,
  } as NodeJS.ProcessEnv);

  app = await createApp({ config });
  await app.init();

  owner = createClient({ url: OWNER_URL, maxConnections: 4 });
});

afterAll(async () => {
  await app.close();
  await owner.close();
  rmSync(bucketRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await owner.sql.unsafe(`
    TRUNCATE TABLE notification_deliveries, audit_log, outbox_events, kyc_checks,
      documents, land_parcels, org_members, kyc_records,
      organisations, consent_records, seen_webhook_events, users
    RESTART IDENTITY CASCADE
  `);

  const people = await owner.sql<{ id: string }[]>`
    INSERT INTO users (phone_e164, display_name, phone_verified_at)
    VALUES
      ('+919813000001', 'Ramesh Kumar Sharma', now()),
      ('+919813000002', 'Mohan Lal Yadav', now()),
      ('+919813000090', 'Priya Legal', now())
    RETURNING id
  `;
  userId = people[0]!.id;
  neighbourId = people[1]!.id;
  reviewerId = people[2]!.id;

  /**
   * A verified person. ESIGN_LEASE needs personal KYC *and* the land, so
   * without this every assertion below would pass for the wrong reason.
   */
  await owner.sql`
    INSERT INTO kyc_records (subject_type, user_id, level, status, vendor, vendor_session_id, pan_last4)
    VALUES
      ('PERSON', ${userId},      'FULL', 'VERIFIED', 'fake', 'fake_sess_land_1', '1234'),
      ('PERSON', ${neighbourId}, 'FULL', 'VERIFIED', 'fake', 'fake_sess_land_2', '5678')
  `;
});

/* ------------------------------------------------------------------ */

/** Upload, PUT and confirm one land record. Returns the parcel it made. */
async function uploadLandRecord(
  who: string,
  options: { markers?: string[]; khasra?: string; docType?: string } = {},
) {
  const target = await http()
    .post("/v1/documents/upload-url")
    .set(DEV_USER_HEADER, who)
    .send({
      docType: options.docType ?? "JAMABANDI",
      fileName: "jamabandi.pdf",
      contentType: "application/pdf",
      sizeBytes: 2048,
      ...(options.markers ? { testMarkers: options.markers } : {}),
      ...(options.khasra ? { testKhasra: options.khasra } : {}),
    })
    .expect(201);

  await http()
    .put(`/v1/files${new URL(target.body.url).search}`)
    .set("content-type", "application/pdf")
    .send(Buffer.from("%PDF-1.7\nland record\n"))
    .expect(200);

  const confirmed = await http()
    .post("/v1/documents/confirm")
    .set(DEV_USER_HEADER, who)
    .send({ storageKey: target.body.key, sha256: "d".repeat(64) })
    .expect(201);

  return {
    documentId: confirmed.body.documentId as string,
    parcelId: confirmed.body.landParcelId as string | null,
  };
}

async function approveDoc(documentId: string) {
  const { user, roles } = legal();
  return http()
    .post(`/v1/admin/documents/${documentId}/review`)
    .set(DEV_USER_HEADER, user)
    .set(DEV_STAFF_ROLES_HEADER, roles)
    .send({ approved: true, note: "Khasra confirmed against the village map." })
    .expect(201);
}

/**
 * Asks whether this person may sign a lease.
 *
 * The endpoint answers 200 with `{ allowed, code }` rather than throwing a
 * 403, deliberately: the client needs the code to show the right next step —
 * LAND_DOCUMENTS_REQUIRED means "we are still reviewing", which is not an
 * error the UI should treat as a failure.
 */
async function canEsignLease(who: string) {
  const response = await http()
    .get("/v1/kyc/can/ESIGN_LEASE")
    .set(DEV_USER_HEADER, who)
    .expect(200);
  return response.body as { allowed: boolean; code?: string };
}

/* ------------------------------------------------------------------ */

describe("a land record becomes a parcel", () => {
  test("confirming a Jamabandi creates the parcel and says so", async () => {
    const { parcelId } = await uploadLandRecord(userId);
    expect(parcelId).toBeTruthy();
  });

  test("the parcel is listed with what was read off the record", async () => {
    await uploadLandRecord(userId);

    const response = await http()
      .get("/v1/land-parcels")
      .set(DEV_USER_HEADER, userId)
      .expect(200);

    expect(response.body.parcels).toHaveLength(1);
    expect(response.body.parcels[0].khasraNumber).toBe("127/3");
    expect(response.body.parcels[0].village).toBe("Kharawar");
  });

  /**
   * A selfie is not land. Creating a parcel from every upload would fill the
   * reviewer's queue with plots that do not exist.
   */
  test("a document that is not a land record creates no parcel", async () => {
    const { parcelId } = await uploadLandRecord(userId, { docType: "SELFIE" });
    expect(parcelId).toBeNull();
  });

  test("another customer cannot see the parcel", async () => {
    await uploadLandRecord(userId);

    const response = await http()
      .get("/v1/land-parcels")
      .set(DEV_USER_HEADER, neighbourId)
      .expect(200);

    expect(response.body.parcels).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */

describe("signing a lease", () => {
  /**
   * The point of the whole module. Being verified is not enough — without
   * approved land, ESIGN_LEASE has to refuse somebody whose KYC is perfect.
   */
  test("a verified person with no land cannot sign a lease", async () => {
    const verdict = await canEsignLease(userId);

    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe("LAND_DOCUMENTS_REQUIRED");
  });

  test("an uploaded but unapproved record is still not enough", async () => {
    await uploadLandRecord(userId);

    expect((await canEsignLease(userId)).allowed).toBe(false);
  });

  test("Legal approving the record makes the lease signable", async () => {
    const { documentId } = await uploadLandRecord(userId);
    await approveDoc(documentId);

    expect((await canEsignLease(userId)).allowed).toBe(true);
  });

  test("the parcel reports VERIFIED once approved", async () => {
    const { documentId } = await uploadLandRecord(userId);
    await approveDoc(documentId);

    const response = await http()
      .get("/v1/land-parcels")
      .set(DEV_USER_HEADER, userId)
      .expect(200);

    expect(response.body.parcels[0].verificationStatus).toBe("VERIFIED");
    expect(response.body.parcels[0].reasons).toHaveLength(0);
  });

  /**
   * The land records name somebody else. The documents are legible and Legal
   * approved them as documents — and the lease still cannot be signed, which
   * is exactly the separation this is all for.
   */
  test("approved documents naming somebody else do not unlock the lease", async () => {
    const { documentId } = await uploadLandRecord(userId, {
      markers: ["owner-anita-desai"],
    });
    await approveDoc(documentId);

    const verdict = await canEsignLease(userId);
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe("LAND_DOCUMENTS_REQUIRED");
  });
});

/* ------------------------------------------------------------------ */

describe("jointly held land", () => {
  async function declareCoOwners(parcelId: string, names: string[]) {
    return http()
      .post(`/v1/land-parcels/${parcelId}/co-owners`)
      .set(DEV_USER_HEADER, userId)
      .send({ coOwnerNames: names })
      .expect(201);
  }

  test("declaring co-owners holds the lease back", async () => {
    const { documentId, parcelId } = await uploadLandRecord(userId);
    await declareCoOwners(parcelId!, ["Sunita Sharma", "Mohan Lal Sharma"]);
    await approveDoc(documentId);

    const verdict = await canEsignLease(userId);
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe("LAND_DOCUMENTS_REQUIRED");
  });

  test("the customer is told why, in terms naming the holders", async () => {
    const { parcelId } = await uploadLandRecord(userId);
    await declareCoOwners(parcelId!, ["Sunita Sharma"]);

    const response = await http()
      .get("/v1/land-parcels")
      .set(DEV_USER_HEADER, userId)
      .expect(200);

    const codes = response.body.parcels[0].reasons.map(
      (r: { code: string }) => r.code,
    );
    expect(codes).toContain("LAND_CO_OWNER_CONSENT_REQUIRED");
    expect(response.body.parcels[0].coOwnerNames).toEqual(["Sunita Sharma"]);
  });

  test("Legal confirming consent releases it", async () => {
    const { documentId, parcelId } = await uploadLandRecord(userId);
    await declareCoOwners(parcelId!, ["Sunita Sharma"]);
    await approveDoc(documentId);

    const { user, roles } = legal();
    await http()
      .post(`/v1/admin/land-parcels/${parcelId}/co-owner-consent`)
      .set(DEV_USER_HEADER, user)
      .set(DEV_STAFF_ROLES_HEADER, roles)
      .send({ note: "Spoke to Sunita Sharma; she agrees." })
      .expect(201);

    expect((await canEsignLease(userId)).allowed).toBe(true);
  });

  /** Co-owner consent is Legal's call, like every other land question. */
  test("compliance cannot confirm co-owner consent", async () => {
    const { parcelId } = await uploadLandRecord(userId);
    await declareCoOwners(parcelId!, ["Sunita Sharma"]);

    await http()
      .post(`/v1/admin/land-parcels/${parcelId}/co-owner-consent`)
      .set(DEV_USER_HEADER, reviewerId)
      .set(DEV_STAFF_ROLES_HEADER, "compliance")
      .send({})
      .expect(403);
  });

  /**
   * The owner declaring their own co-owners agreed would make the check
   * self-certifying, which is no check at all.
   */
  test("the customer cannot confirm the consent themselves", async () => {
    const { parcelId } = await uploadLandRecord(userId);
    await declareCoOwners(parcelId!, ["Sunita Sharma"]);

    await http()
      .post(`/v1/admin/land-parcels/${parcelId}/co-owner-consent`)
      .set(DEV_USER_HEADER, userId)
      .send({})
      .expect(404);
  });

  test("a customer cannot declare co-owners on somebody else's parcel", async () => {
    const { parcelId } = await uploadLandRecord(userId);

    await http()
      .post(`/v1/land-parcels/${parcelId}/co-owners`)
      .set(DEV_USER_HEADER, neighbourId)
      .send({ coOwnerNames: ["Sunita Sharma"] })
      .expect(404);
  });
});

/* ------------------------------------------------------------------ */

describe("the same plot claimed twice", () => {
  test("the second claimant is held, and told why", async () => {
    const mine = await uploadLandRecord(userId);
    await approveDoc(mine.documentId);

    const theirs = await uploadLandRecord(neighbourId);
    await approveDoc(theirs.documentId);

    const response = await http()
      .get("/v1/land-parcels")
      .set(DEV_USER_HEADER, neighbourId)
      .expect(200);

    const codes = response.body.parcels[0].reasons.map(
      (r: { code: string }) => r.code,
    );
    expect(codes).toContain("LAND_KHASRA_ALREADY_CLAIMED");
    expect((await canEsignLease(neighbourId)).allowed).toBe(false);
  });

  /** And the first claimant is not punished for somebody else's claim. */
  test("the first claimant keeps their lease", async () => {
    const mine = await uploadLandRecord(userId);
    await approveDoc(mine.documentId);

    const theirs = await uploadLandRecord(neighbourId);
    await approveDoc(theirs.documentId);

    expect((await canEsignLease(userId)).allowed).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe("the reviewer's land queue", () => {
  test("a parcel waiting on a decision is listed", async () => {
    await uploadLandRecord(userId);

    const { user, roles } = legal();
    const response = await http()
      .get("/v1/admin/land-parcels")
      .set(DEV_USER_HEADER, user)
      .set(DEV_STAFF_ROLES_HEADER, roles)
      .expect(200);

    expect(response.body.parcels).toHaveLength(1);
    expect(response.body.parcels[0].khasraNumber).toBe("127/3");
  });

  test("a verified parcel leaves the queue", async () => {
    const { documentId } = await uploadLandRecord(userId);
    await approveDoc(documentId);

    const { user, roles } = legal();
    const response = await http()
      .get("/v1/admin/land-parcels")
      .set(DEV_USER_HEADER, user)
      .set(DEV_STAFF_ROLES_HEADER, roles)
      .expect(200);

    expect(response.body.parcels).toHaveLength(0);
  });

  test("a customer cannot reach the queue", async () => {
    await uploadLandRecord(userId);

    await http()
      .get("/v1/admin/land-parcels")
      .set(DEV_USER_HEADER, userId)
      .expect(404);
  });
});
