import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type DatabaseHandle } from "@kilowattx/db";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../bootstrap.js";
import { DEV_USER_HEADER, DEV_STAFF_ROLES_HEADER } from "../common/session.js";
import { loadConfig } from "../config.js";

/**
 * Uploading, viewing and approving a document, over HTTP.
 *
 * The browser never streams a deed through this process. It asks for a signed
 * URL and talks to the bucket directly, which is what keeps a 25 MB scan off
 * the API's event loop — and what makes "every view is logged" true, since the
 * only way to obtain a URL is to ask for one.
 */

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://kilowattx_app:local_dev_only@localhost:5434/kilowattx_api_test";
const OWNER_URL =
  process.env.OWNER_DATABASE_URL ??
  "postgresql://kilowattx:local_dev_only@localhost:5434/kilowattx_api_test";

const WEBHOOK_SECRET = "whsec_documents_testing0";
const FILE_SECRET = "filesign_documents_testing_000";
const BLIND_INDEX_KEY = Buffer.alloc(32, 19).toString("base64");

let app: NestExpressApplication;
let owner: DatabaseHandle;
let bucketRoot: string;
let userId: string;
let reviewerId: string;

function http() {
  return request(app.getHttpServer());
}

beforeAll(async () => {
  bucketRoot = mkdtempSync(join(tmpdir(), "kwx-docs-e2e-"));

  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: DB_URL,
    KYC_PROVIDER: "fake",
    KYC_WEBHOOK_SECRET: WEBHOOK_SECRET,
    KYC_BLIND_INDEX_KEY: BLIND_INDEX_KEY,
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

  const rows = await owner.sql<{ id: string }[]>`
    INSERT INTO users (phone_e164, display_name, phone_verified_at)
    VALUES
      ('+919813000001', 'Ramesh Kumar Sharma', now()),
      ('+919813000090', 'Priya Legal', now())
    RETURNING id
  `;
  userId = rows[0]!.id;
  reviewerId = rows[1]!.id;
});

/* ------------------------------------------------------------------ */

async function requestUploadUrl(
  options: { fileName?: string; testMarkers?: string[] } = {},
) {
  return http()
    .post("/v1/documents/upload-url")
    .set(DEV_USER_HEADER, userId)
    .send({
      docType: "JAMABANDI",
      fileName: options.fileName ?? "jamabandi.pdf",
      contentType: "application/pdf",
      sizeBytes: 482_113,
      ...(options.testMarkers ? { testMarkers: options.testMarkers } : {}),
    })
    .expect(201);
}

/** Stands in for the bucket event that fires when the browser's PUT completes. */
async function confirmUpload(key: string) {
  return http()
    .post("/v1/documents/confirm")
    .set(DEV_USER_HEADER, userId)
    .send({ storageKey: key, sha256: "c".repeat(64) })
    .expect(201);
}

/** The real upload: signed PUT to the development bucket. */
async function putBytes(upload: { url: string; contentType: string }) {
  await http()
    .put(`/v1/files${new URL(upload.url).search}`)
    .set("content-type", upload.contentType)
    .send(Buffer.from("%PDF-1.7\nland record\n"))
    .expect(200);
}

/* ------------------------------------------------------------------ */

describe("asking for somewhere to upload", () => {
  test("returns a signed URL, the key, and when it expires", async () => {
    const response = await requestUploadUrl();

    expect(response.body.url).toContain("sig=");
    expect(response.body.key).toContain("kyc-docs/");
    expect(response.body.expiresAt).toBeTruthy();
  });

  /**
   * The key is server-chosen. If the client named it, one customer could write
   * over another's deed by asking for their key — and the prefix check alone
   * would not stop it, because both keys are inside the bucket.
   */
  test("the key is under the caller's own prefix, whatever the file is called", async () => {
    const response = await requestUploadUrl({ fileName: "../../someone-else/deed.pdf" });

    expect(response.body.key).toContain(`kyc-docs/${userId}/`);
    expect(response.body.key).not.toContain("..");
  });

  test("an oversized file is refused before a URL is issued", async () => {
    await http()
      .post("/v1/documents/upload-url")
      .set(DEV_USER_HEADER, userId)
      .send({
        docType: "JAMABANDI",
        fileName: "huge.pdf",
        contentType: "application/pdf",
        sizeBytes: 80 * 1024 * 1024,
      })
      .expect(400);
  });

  /**
   * A signed URL for an executable is a signed URL to host malware on our
   * domain. The type is checked here and signed into the URL, so the bucket
   * refuses a PUT that sends anything else.
   */
  test("an unsupported content type is refused", async () => {
    await http()
      .post("/v1/documents/upload-url")
      .set(DEV_USER_HEADER, userId)
      .send({
        docType: "JAMABANDI",
        fileName: "payload.exe",
        contentType: "application/x-msdownload",
        sizeBytes: 1024,
      })
      .expect(400);
  });

  test("anonymous callers get nothing", async () => {
    await http()
      .post("/v1/documents/upload-url")
      .send({
        docType: "JAMABANDI",
        fileName: "jb.pdf",
        contentType: "application/pdf",
        sizeBytes: 1024,
      })
      .expect(401);
  });
});

/* ------------------------------------------------------------------ */

describe("confirming an upload", () => {
  test("registers the document, scans it and extracts its fields", async () => {
    const { body: upload } = await requestUploadUrl();
    const { body } = await confirmUpload(upload.key);

    expect(body.scanStatus).toBe("CLEAN");
    expect(body.needsManualReview).toBe(false);
    expect(body.fields.khasraNumber.value).toBe("127/3");
  });

  test("the low-confidence count is reported to the uploader", async () => {
    const { body: upload } = await requestUploadUrl({ testMarkers: ["partial"] });
    const { body } = await confirmUpload(upload.key);

    expect(body.lowConfidenceFieldCount).toBe(2);
    expect(body.needsManualReview).toBe(true);
  });

  /**
   * The uploader is told, in terms they can act on. "Two fields could not be
   * read" is something a customer can respond to by sending a clearer scan;
   * a bare "under review" leaves them waiting on nothing.
   */
  test("an infected upload is reported as rejected, not as pending", async () => {
    const { body: upload } = await requestUploadUrl({ testMarkers: ["infected"] });
    const { body } = await confirmUpload(upload.key);

    expect(body.scanStatus).toBe("INFECTED");
    expect(body.fields).toEqual({});
  });

  /**
   * Quarantine has to mean the bytes are gone.
   *
   * Refusing to issue a link is necessary and not sufficient: a file that
   * failed a virus scan and is still sitting in storage is still malware,
   * reachable by anything that reads the key by another route — a backup job,
   * a bucket browser, the next endpoint somebody writes.
   */
  test("an infected file is deleted from storage, not merely flagged", async () => {
    const { body: upload } = await requestUploadUrl({ testMarkers: ["infected"] });
    await putBytes(upload);

    const stored = join(bucketRoot, ...upload.key.split("/"));
    expect(existsSync(stored)).toBe(true);

    const { body } = await confirmUpload(upload.key);
    expect(body.scanStatus).toBe("INFECTED");

    expect(existsSync(stored)).toBe(false);
  });

  /** A clean file is obviously kept — the reviewer has to be able to open it. */
  test("a clean file stays in storage", async () => {
    const { body: upload } = await requestUploadUrl();
    await putBytes(upload);
    await confirmUpload(upload.key);

    expect(existsSync(join(bucketRoot, ...upload.key.split("/")))).toBe(true);
  });

  /** A key the caller was never issued is not theirs to confirm. */
  test("confirming somebody else's key is refused", async () => {
    await http()
      .post("/v1/documents/confirm")
      .set(DEV_USER_HEADER, userId)
      .send({
        storageKey: `kyc-docs/${reviewerId}/JAMABANDI/theirs.pdf`,
        sha256: "c".repeat(64),
      })
      .expect(403);
  });

  test("a retried confirmation is handled once", async () => {
    const { body: upload } = await requestUploadUrl();
    const first = await confirmUpload(upload.key);
    const second = await confirmUpload(upload.key);

    expect(second.body.documentId).toBe(first.body.documentId);
  });
});

/* ------------------------------------------------------------------ */

describe("viewing a document", () => {
  async function uploadedDocument(...testMarkers: string[]) {
    const { body: upload } = await requestUploadUrl({ testMarkers });
    const { body } = await confirmUpload(upload.key);
    return body.documentId as string;
  }

  test("the owner gets a short-lived signed URL", async () => {
    const documentId = await uploadedDocument();

    const response = await http()
      .get(`/v1/documents/${documentId}/download-url`)
      .set(DEV_USER_HEADER, userId)
      .expect(200);

    expect(response.body.url).toContain("sig=");

    const expiresIn =
      new Date(response.body.expiresAt).getTime() - Date.now();
    expect(expiresIn).toBeLessThanOrEqual(60_000);
  });

  /**
   * The rule the guide states outright: every access to a KYC document is
   * logged. Issuing the URL is the access, because nothing afterwards passes
   * through us.
   */
  test("issuing the URL writes an audit row naming who asked", async () => {
    const documentId = await uploadedDocument();

    await http()
      .get(`/v1/documents/${documentId}/download-url`)
      .set(DEV_USER_HEADER, userId)
      .expect(200);

    const audit = await owner.sql<{ actor_user_id: string; action: string }[]>`
      SELECT actor_user_id, action FROM audit_log WHERE action = 'document.viewed'
    `;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_user_id).toBe(userId);
  });

  test("another customer cannot get a URL for it", async () => {
    const documentId = await uploadedDocument();

    await http()
      .get(`/v1/documents/${documentId}/download-url`)
      .set(DEV_USER_HEADER, reviewerId)
      .expect(404);
  });

  /**
   * No URL is ever minted for an infected file. A reviewer opening one to
   * "check what it is" is the exact outcome the scan exists to prevent.
   */
  test("no URL is issued for an infected document, to anybody", async () => {
    const documentId = await uploadedDocument("infected");

    await http()
      .get(`/v1/documents/${documentId}/download-url`)
      .set(DEV_USER_HEADER, userId)
      .expect(409);

    await http()
      .get(`/v1/documents/${documentId}/download-url`)
      .set(DEV_USER_HEADER, reviewerId)
      .set(DEV_STAFF_ROLES_HEADER, "legal")
      .expect(409);
  });

  test("staff can view a document they are reviewing", async () => {
    const documentId = await uploadedDocument();

    await http()
      .get(`/v1/documents/${documentId}/download-url`)
      .set(DEV_USER_HEADER, reviewerId)
      .set(DEV_STAFF_ROLES_HEADER, "legal")
      .expect(200);
  });
});

/* ------------------------------------------------------------------ */

describe("Legal reviewing a document", () => {
  async function pendingReview() {
    const { body: upload } = await requestUploadUrl({ testMarkers: ["partial"] });
    const { body } = await confirmUpload(upload.key);
    return body.documentId as string;
  }

  test("an approval is recorded", async () => {
    const documentId = await pendingReview();

    const response = await http()
      .post(`/v1/admin/documents/${documentId}/review`)
      .set(DEV_USER_HEADER, reviewerId)
      .set(DEV_STAFF_ROLES_HEADER, "legal")
      .send({ approved: true, note: "Khasra number confirmed against the map." })
      .expect(201);

    expect(response.body.approved).toBe(true);
  });

  /**
   * Land documents are Legal's call, not compliance's. The split exists
   * because a weak face match and a disputed title need different expertise,
   * and the guard deliberately cannot tell them apart — canReviewCase() does.
   */
  test("compliance cannot approve a land document", async () => {
    const documentId = await pendingReview();

    await http()
      .post(`/v1/admin/documents/${documentId}/review`)
      .set(DEV_USER_HEADER, reviewerId)
      .set(DEV_STAFF_ROLES_HEADER, "compliance")
      .send({ approved: true })
      .expect(403);
  });

  test("a customer cannot reach the review endpoint at all", async () => {
    const documentId = await pendingReview();

    await http()
      .post(`/v1/admin/documents/${documentId}/review`)
      .set(DEV_USER_HEADER, userId)
      .send({ approved: true })
      .expect(404);
  });

  test("a rejection requires a reason", async () => {
    const documentId = await pendingReview();

    await http()
      .post(`/v1/admin/documents/${documentId}/review`)
      .set(DEV_USER_HEADER, reviewerId)
      .set(DEV_STAFF_ROLES_HEADER, "legal")
      .send({ approved: false })
      .expect(400);
  });

  test("the queue lists documents waiting on a human", async () => {
    await pendingReview();

    const response = await http()
      .get("/v1/admin/documents")
      .set(DEV_USER_HEADER, reviewerId)
      .set(DEV_STAFF_ROLES_HEADER, "legal")
      .expect(200);

    expect(response.body.documents).toHaveLength(1);
    expect(response.body.documents[0].lowConfidenceFieldCount).toBe(2);
  });

  /**
   * A clean, fully legible document needs nobody. Putting every upload in the
   * queue would bury the ones that matter.
   */
  test("a document nothing is wrong with is not in the queue", async () => {
    const { body: upload } = await requestUploadUrl();
    await confirmUpload(upload.key);

    const response = await http()
      .get("/v1/admin/documents")
      .set(DEV_USER_HEADER, reviewerId)
      .set(DEV_STAFF_ROLES_HEADER, "legal")
      .expect(200);

    expect(response.body.documents).toHaveLength(0);
  });
});
