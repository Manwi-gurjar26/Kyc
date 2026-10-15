import {
  createClient,
  documents,
  withContext,
  type Database,
  type DatabaseHandle,
} from "@kilowattx/db";
import {
  FakeDocumentExtractor,
  FakeDocumentScanner,
  type DocumentType,
} from "@kilowattx/integrations";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  EXTRACTION_CONFIDENCE_FLOOR,
  LOW_CONFIDENCE_REVIEW_THRESHOLD,
  approveDocument,
  documentIsUsable,
  processUploadedDocument,
  registerUpload,
} from "./documents.js";

/**
 * Uploaded documents, from the moment a file lands to the moment Legal
 * approves it.
 *
 * Two rules drive everything here, and both come from the guide:
 *
 *   An INFECTED document can never be used for anything. Not viewed, not
 *   extracted, not approved. It is the only rule in the KYC flow whose failure
 *   mode is somebody else's machine.
 *
 *   Fields read with at least 0.85 confidence are pre-filled; two or more
 *   below it and a human checks the document. OCR on a faded Jamabandi is
 *   frequently wrong, and a wrong khasra number ends up on a registered lease.
 */

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://kilowattx_app:local_dev_only@localhost:5434/kilowattx_pipeline_test";
const OWNER_URL =
  process.env.OWNER_DATABASE_URL ??
  "postgresql://kilowattx:local_dev_only@localhost:5434/kilowattx_pipeline_test";

const NOW = new Date("2026-10-10T09:00:00.000Z");

let app: DatabaseHandle;
let owner: DatabaseHandle;
let db: Database;
let userId: string;
let reviewerId: string;

const scanner = new FakeDocumentScanner({ clock: () => NOW });
const extractor = new FakeDocumentExtractor();

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

  /**
   * No staff column on users: which staff role somebody holds comes from the
   * session, and canReviewCase() decides what that role may act on. The
   * reviewer here is a user row like any other.
   */
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

async function upload(suffix = "", docType: DocumentType = "JAMABANDI") {
  return withContext(db, { role: "system", userId }, (tx) =>
    registerUpload(tx, {
      ownerUserId: userId,
      docType,
      storageKey: `kyc-docs/${userId}/${docType}/jb${suffix}.pdf`,
      contentType: "application/pdf",
      sizeBytes: 482_113,
      sha256: "a".repeat(64),
      now: NOW,
    }),
  );
}

async function scanAndExtract(documentId: string) {
  return withContext(db, { role: "system", userId }, (tx) =>
    processUploadedDocument(tx, {
      documentId,
      scanner,
      extractor,
      now: NOW,
    }),
  );
}

async function row(documentId: string) {
  const rows = await withContext(db, { role: "system", userId }, (tx) =>
    tx.select().from(documents).where(eq(documents.id, documentId)).limit(1),
  );
  return rows[0]!;
}

/* ------------------------------------------------------------------ */

describe("registering an upload", () => {
  test("the row starts PENDING, with nothing extracted and nothing approved", async () => {
    const { documentId } = await upload();
    const document = await row(documentId);

    expect(document.scanStatus).toBe("PENDING");
    expect(document.extractedFields).toBeNull();
    expect(document.approved).toBeNull();
  });

  /**
   * Seven years, per the retention policy. Set at upload rather than at
   * approval, because an abandoned document still has to be disposed of on a
   * schedule somebody can defend.
   */
  test("a retention date is set when the file arrives", async () => {
    const { documentId } = await upload();
    const document = await row(documentId);

    expect(document.retentionUntil).not.toBeNull();
    expect(document.retentionUntil!.getUTCFullYear()).toBe(2033);
  });

  /**
   * The unique index on storage_key exists so a retried upload cannot create a
   * second row that nobody scans. Re-registering has to return the first row,
   * not raise.
   */
  test("re-registering the same key returns the existing document", async () => {
    const first = await upload();
    const second = await upload();

    expect(second.documentId).toBe(first.documentId);
    expect(second.existing).toBe(true);
  });

  test("a key outside the KYC bucket is refused", async () => {
    await expect(
      withContext(db, { role: "system", userId }, (tx) =>
        registerUpload(tx, {
          ownerUserId: userId,
          docType: "JAMABANDI",
          storageKey: "agreements/signed/ppa.pdf",
          contentType: "application/pdf",
          sizeBytes: 100,
          sha256: "a".repeat(64),
          now: NOW,
        }),
      ),
    ).rejects.toThrow(/kyc-docs/);
  });
});

/* ------------------------------------------------------------------ */

describe("a clean, legible document", () => {
  test("is scanned CLEAN and its fields are extracted", async () => {
    const { documentId } = await upload();
    const outcome = await scanAndExtract(documentId);

    expect(outcome.scanStatus).toBe("CLEAN");
    expect(outcome.extracted).toBe(true);
    expect(outcome.needsManualReview).toBe(false);
  });

  test("the extracted fields are persisted with their confidences", async () => {
    const { documentId } = await upload();
    await scanAndExtract(documentId);
    const document = await row(documentId);

    expect(document.extractedFields!.khasraNumber!.value).toBe("127/3");
    expect(document.extractedFields!.khasraNumber!.confidence).toBeGreaterThanOrEqual(
      EXTRACTION_CONFIDENCE_FLOOR,
    );
    expect(document.lowConfidenceFieldCount).toBe(0);
    expect(document.scannedAt).not.toBeNull();
  });

  test("it is usable, but not yet approved", async () => {
    const { documentId } = await upload();
    await scanAndExtract(documentId);
    const document = await row(documentId);

    expect(documentIsUsable(document)).toBe(true);
    expect(document.approved).toBeNull();
  });
});

/* ------------------------------------------------------------------ */

describe("an infected document", () => {
  /**
   * The rule with a security consequence. Everything downstream — extraction,
   * viewing, approval — has to be unreachable, and the test asserts each one
   * separately rather than trusting a single status check.
   */
  test("is never extracted", async () => {
    const { documentId } = await upload("--infected");
    const outcome = await scanAndExtract(documentId);

    expect(outcome.scanStatus).toBe("INFECTED");
    expect(outcome.extracted).toBe(false);

    const document = await row(documentId);
    expect(document.extractedFields).toBeNull();
  });

  test("is not usable", async () => {
    const { documentId } = await upload("--infected");
    await scanAndExtract(documentId);

    expect(documentIsUsable(await row(documentId))).toBe(false);
  });

  test("cannot be approved, even by Legal", async () => {
    const { documentId } = await upload("--infected");
    await scanAndExtract(documentId);

    await expect(
      withContext(db, { role: "staff", userId: reviewerId }, (tx) =>
        approveDocument(tx, {
          documentId,
          reviewerUserId: reviewerId,
          approved: true,
          now: NOW,
        }),
      ),
    ).rejects.toThrow(/INFECTED/);
  });

  /**
   * Quarantine has to mean the bytes are destroyed, not merely that we decline
   * to hand out a link. The deletion itself belongs to the caller, because it
   * must happen AFTER this transaction commits: if removing the object were
   * part of the transaction and failed, the INFECTED status would roll back
   * with it and the document would sit there looking unscanned.
   *
   * So the outcome names the key, and committing the finding comes first.
   */
  test("the outcome names the key to destroy", async () => {
    const { documentId } = await upload("--infected");
    const outcome = await scanAndExtract(documentId);

    expect(outcome.quarantinedKey).toContain("--infected");
  });

  test("a clean document names nothing to destroy", async () => {
    const { documentId } = await upload();
    const outcome = await scanAndExtract(documentId);

    expect(outcome.quarantinedKey).toBeNull();
  });

  /** A scanner outage destroys nothing: there is no finding to act on. */
  test("an unscannable document names nothing to destroy", async () => {
    const { documentId } = await upload("--scanfail");
    const outcome = await scanAndExtract(documentId);

    expect(outcome.quarantinedKey).toBeNull();
  });

  test("the quarantine is recorded with the signature that matched", async () => {
    const { documentId } = await upload("--infected");
    await scanAndExtract(documentId);

    const audit = await owner.sql<{ action: string; changes: unknown }[]>`
      SELECT action, changes FROM audit_log WHERE action = 'document.quarantined'
    `;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.changes)).toContain("Eicar");
  });
});

/* ------------------------------------------------------------------ */

describe("a document the scanner could not reach", () => {
  /**
   * ERRORED is not CLEAN. The document stays unusable and the scan stays
   * retryable, because the alternative is that a scanner outage admits
   * everything uploaded during it.
   */
  test("is left unusable and not extracted", async () => {
    const { documentId } = await upload("--scanfail");
    const outcome = await scanAndExtract(documentId);

    expect(outcome.scanStatus).toBe("ERRORED");
    expect(outcome.extracted).toBe(false);
    expect(documentIsUsable(await row(documentId))).toBe(false);
  });

  test("can be scanned again, and succeeds when the scanner returns", async () => {
    const { documentId } = await upload("--scanfail");
    await scanAndExtract(documentId);

    /** The same document, rescanned by a scanner that is now up. */
    const outcome = await withContext(db, { role: "system", userId }, (tx) =>
      processUploadedDocument(tx, {
        documentId,
        scanner: {
          scan: async () => ({ status: "CLEAN" as const, scannedAt: NOW }),
        },
        extractor,
        now: NOW,
      }),
    );

    expect(outcome.scanStatus).toBe("CLEAN");
    expect(outcome.extracted).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe("the confidence rule", () => {
  test("two low-confidence fields send it to a human", async () => {
    const { documentId } = await upload("--partial");
    const outcome = await scanAndExtract(documentId);

    expect(outcome.lowConfidenceFieldCount).toBe(
      LOW_CONFIDENCE_REVIEW_THRESHOLD,
    );
    expect(outcome.needsManualReview).toBe(true);
  });

  /**
   * The pre-fill still happens. A reviewer correcting two fields is a much
   * smaller job than one typing in five, and discarding the legible fields
   * because two were not would make the OCR worthless exactly when it is most
   * needed.
   */
  test("the legible fields are still pre-filled", async () => {
    const { documentId } = await upload("--partial");
    await scanAndExtract(documentId);
    const document = await row(documentId);

    expect(document.extractedFields!.ownerName!.value).toBe(
      "RAMESH KUMAR SHARMA",
    );
    expect(document.extractedFields!.ownerName!.confidence).toBeGreaterThanOrEqual(
      EXTRACTION_CONFIDENCE_FLOOR,
    );
  });

  test("a single low-confidence field does not, on its own", async () => {
    const { documentId } = await upload();
    const outcome = await withContext(db, { role: "system", userId }, (tx) =>
      processUploadedDocument(tx, {
        documentId,
        scanner,
        extractor: {
          extract: async () => ({
            fields: {
              khasraNumber: { value: "127/3", confidence: 0.62 },
              ownerName: { value: "RAMESH KUMAR SHARMA", confidence: 0.97 },
            },
            extractedAt: NOW,
          }),
        },
        now: NOW,
      }),
    );

    expect(outcome.lowConfidenceFieldCount).toBe(1);
    expect(outcome.needsManualReview).toBe(false);
  });

  test("everything illegible sends it to a human", async () => {
    const { documentId } = await upload("--lowconf");
    const outcome = await scanAndExtract(documentId);

    expect(outcome.lowConfidenceFieldCount).toBeGreaterThanOrEqual(
      LOW_CONFIDENCE_REVIEW_THRESHOLD,
    );
    expect(outcome.needsManualReview).toBe(true);
  });

  /**
   * A blank page extracts nothing, which is zero low-confidence fields — so
   * the count alone would wave it through. Nothing read means nothing to
   * pre-fill, and that needs a human more than a partial read does.
   */
  test("a document with nothing readable is reviewed, not waved through", async () => {
    const { documentId } = await upload("--unreadable");
    const outcome = await scanAndExtract(documentId);

    expect(outcome.lowConfidenceFieldCount).toBe(0);
    expect(outcome.needsManualReview).toBe(true);
  });

  /**
   * A selfie has no text and is not supposed to. Reviewing every one of them
   * would bury the queue in documents nobody needs to look at.
   */
  test("a document type with nothing to read is not reviewed for it", async () => {
    const { documentId } = await upload("", "SELFIE");
    const outcome = await scanAndExtract(documentId);

    expect(outcome.needsManualReview).toBe(false);
  });

  /** The floor is a constant, not a literal scattered across the code. */
  test("the floor and the threshold are the guide's numbers", () => {
    expect(EXTRACTION_CONFIDENCE_FLOOR).toBe(0.85);
    expect(LOW_CONFIDENCE_REVIEW_THRESHOLD).toBe(2);
  });
});

/* ------------------------------------------------------------------ */

describe("Legal approving a document", () => {
  async function cleanDocument() {
    const { documentId } = await upload();
    await scanAndExtract(documentId);
    return documentId;
  }

  test("records who approved it and when", async () => {
    const documentId = await cleanDocument();

    await withContext(db, { role: "staff", userId: reviewerId }, (tx) =>
      approveDocument(tx, {
        documentId,
        reviewerUserId: reviewerId,
        approved: true,
        now: NOW,
      }),
    );

    const document = await row(documentId);
    expect(document.approved).toBe(true);
    expect(document.reviewedBy).toBe(reviewerId);
    expect(document.reviewedAt).not.toBeNull();
  });

  test("a rejection is recorded with its reason", async () => {
    const documentId = await cleanDocument();

    await withContext(db, { role: "staff", userId: reviewerId }, (tx) =>
      approveDocument(tx, {
        documentId,
        reviewerUserId: reviewerId,
        approved: false,
        reasonCode: "DOCUMENT_ILLEGIBLE",
        note: "Khasra number not readable; asked for a fresh certified copy.",
        now: NOW,
      }),
    );

    const document = await row(documentId);
    expect(document.approved).toBe(false);

    const audit = await owner.sql<{ reason_code: string; note: string }[]>`
      SELECT reason_code, note FROM audit_log WHERE action = 'document.reviewed'
    `;
    expect(audit[0]!.reason_code).toBe("DOCUMENT_ILLEGIBLE");
  });

  /**
   * Same rule as the KYC queue. A reviewer approving their own upload defeats
   * the whole point of a second pair of eyes, and the check belongs inside the
   * transaction rather than in a controller somebody can route around.
   */
  test("a reviewer cannot approve their own upload", async () => {
    const { documentId } = await withContext(
      db,
      { role: "system", userId: reviewerId },
      (tx) =>
        registerUpload(tx, {
          ownerUserId: reviewerId,
          docType: "JAMABANDI",
          storageKey: `kyc-docs/${reviewerId}/JAMABANDI/own.pdf`,
          contentType: "application/pdf",
          sizeBytes: 1000,
          sha256: "b".repeat(64),
          now: NOW,
        }),
    );
    await scanAndExtract(documentId);

    await expect(
      withContext(db, { role: "staff", userId: reviewerId }, (tx) =>
        approveDocument(tx, {
          documentId,
          reviewerUserId: reviewerId,
          approved: true,
          now: NOW,
        }),
      ),
    ).rejects.toThrow(/own/i);
  });

  /**
   * A document that has not been scanned has not been shown to anybody
   * safely. Approving before the scan completes would be approving a file the
   * reviewer opened at their own risk.
   */
  test("an unscanned document cannot be approved", async () => {
    const { documentId } = await upload();

    await expect(
      withContext(db, { role: "staff", userId: reviewerId }, (tx) =>
        approveDocument(tx, {
          documentId,
          reviewerUserId: reviewerId,
          approved: true,
          now: NOW,
        }),
      ),
    ).rejects.toThrow(/PENDING|scan/i);
  });
});
