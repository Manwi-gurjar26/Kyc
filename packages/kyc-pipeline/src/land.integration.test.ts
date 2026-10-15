import { DEFAULT_KYC_THRESHOLDS } from "@kilowattx/core";
import {
  createClient,
  landParcels,
  withContext,
  type Database,
  type DatabaseHandle,
} from "@kilowattx/db";
import {
  FakeDocumentExtractor,
  FakeDocumentScanner,
} from "@kilowattx/integrations";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  confirmCoOwnerConsent,
  evaluateParcel,
  landIsLeasable,
  registerParcelFromDocument,
} from "./land.js";
import { approveDocument, processUploadedDocument, registerUpload } from "./documents.js";

/**
 * Turning an uploaded land record into a plot we can lease.
 *
 * The thing worth proving is that the two questions stay separate. "Legal read
 * the paperwork" and "this land may be leased" are not the same answer, and
 * they come apart the moment a record names two holders — which, for inherited
 * agricultural land, is most of the time.
 */

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://kilowattx_app:local_dev_only@localhost:5434/kilowattx_pipeline_test";
const OWNER_URL =
  process.env.OWNER_DATABASE_URL ??
  "postgresql://kilowattx:local_dev_only@localhost:5434/kilowattx_pipeline_test";

const NOW = new Date("2026-10-10T10:00:00.000Z");

let app: DatabaseHandle;
let owner: DatabaseHandle;
let db: Database;
let userId: string;
let neighbourId: string;
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

  const rows = await owner.sql<{ id: string }[]>`
    INSERT INTO users (phone_e164, display_name, phone_verified_at)
    VALUES
      ('+919813000001', 'Ramesh Kumar Sharma', now()),
      ('+919813000002', 'Mohan Lal Yadav', now()),
      ('+919813000090', 'Priya Legal', now())
    RETURNING id
  `;
  userId = rows[0]!.id;
  neighbourId = rows[1]!.id;
  reviewerId = rows[2]!.id;
});

/* ------------------------------------------------------------------ */

/** Uploads a land record and runs it through the scan/extract pipeline. */
async function uploadRecord(
  owner_: string,
  options: { marker?: string; docType?: string } = {},
): Promise<string> {
  const docType = options.docType ?? "JAMABANDI";
  const key = `kyc-docs/${owner_}/${docType}/rec${options.marker ?? ""}.pdf`;

  return withContext(db, { role: "system", userId: owner_ }, async (tx) => {
    const registered = await registerUpload(tx, {
      ownerUserId: owner_,
      docType: docType as "JAMABANDI",
      storageKey: key,
      contentType: "application/pdf",
      sizeBytes: 1024,
      sha256: "a".repeat(64),
      now: NOW,
    });

    await processUploadedDocument(tx, {
      documentId: registered.documentId,
      scanner,
      extractor,
      now: NOW,
    });

    return registered.documentId;
  });
}

async function register(
  documentId: string,
  ownerUserId = userId,
  coOwnerNames: string[] = [],
) {
  return withContext(db, { role: "system", userId: ownerUserId }, (tx) =>
    registerParcelFromDocument(tx, {
      documentId,
      ownerUserId,
      verifiedName: ownerUserId === userId ? "Ramesh Kumar Sharma" : "Mohan Lal Yadav",
      coOwnerNames,
      thresholds: DEFAULT_KYC_THRESHOLDS,
      now: NOW,
    }),
  );
}

async function approve(documentId: string) {
  return withContext(db, { role: "staff", userId: reviewerId }, (tx) =>
    approveDocument(tx, {
      documentId,
      reviewerUserId: reviewerId,
      approved: true,
      now: NOW,
    }),
  );
}

async function reEvaluate(parcelId: string, ownerUserId = userId) {
  return withContext(db, { role: "system", userId: ownerUserId }, (tx) =>
    evaluateParcel(tx, {
      parcelId,
      verifiedName:
        ownerUserId === userId ? "Ramesh Kumar Sharma" : "Mohan Lal Yadav",
      thresholds: DEFAULT_KYC_THRESHOLDS,
      now: NOW,
    }),
  );
}

async function parcelRow(parcelId: string) {
  const rows = await withContext(db, { role: "system", userId }, (tx) =>
    tx.select().from(landParcels).where(eq(landParcels.id, parcelId)).limit(1),
  );
  return rows[0]!;
}

/* ------------------------------------------------------------------ */

describe("creating a parcel from a land record", () => {
  test("the khasra number and village come off the document", async () => {
    const documentId = await uploadRecord(userId);
    const { parcelId } = await register(documentId);
    const parcel = await parcelRow(parcelId);

    expect(parcel.khasraNumber).toBe("127/3");
    expect(parcel.village).toBe("Kharawar");
    expect(parcel.district).toBe("Rohtak");
    expect(parcel.ownerNameOnRecord).toBe("RAMESH KUMAR SHARMA");
  });

  test("the document is linked to the parcel it is evidence for", async () => {
    const documentId = await uploadRecord(userId);
    const { parcelId } = await register(documentId);

    const linked = await owner.sql<{ land_parcel_id: string }[]>`
      SELECT land_parcel_id FROM documents WHERE id = ${documentId}
    `;
    expect(linked[0]!.land_parcel_id).toBe(parcelId);
  });

  /**
   * Uploading a second page of the same record must not create a second
   * parcel. Two parcels for one plot would each be half-evidenced and neither
   * would ever be approvable.
   */
  test("a second document for the same khasra joins the existing parcel", async () => {
    const first = await uploadRecord(userId);
    const second = await uploadRecord(userId, { docType: "MUTATION_RECORD" });

    const a = await register(first);
    const b = await register(second);

    expect(b.parcelId).toBe(a.parcelId);
    expect(b.existing).toBe(true);
  });

  /**
   * A document the pipeline could not read gives us no khasra number, and a
   * parcel with no khasra number is not a parcel.
   */
  test("a document with nothing extracted cannot create a parcel", async () => {
    const documentId = await uploadRecord(userId, { marker: "--unreadable" });

    await expect(register(documentId)).rejects.toThrow(/khasra/i);
  });

  /** An infected document is evidence of nothing, so it creates nothing. */
  test("an infected document cannot create a parcel", async () => {
    const documentId = await uploadRecord(userId, { marker: "--infected" });

    await expect(register(documentId)).rejects.toThrow(/INFECTED|scan/i);
  });
});

/* ------------------------------------------------------------------ */

describe("the verdict on a parcel", () => {
  test("a fresh parcel waits on Legal", async () => {
    const documentId = await uploadRecord(userId);
    const { parcelId } = await register(documentId);
    const parcel = await parcelRow(parcelId);

    expect(parcel.verificationStatus).toBe("MANUAL_REVIEW");
    expect(parcel.decisionReasons!.map((r) => r.code)).toContain(
      "LAND_DOCUMENTS_AWAITING_LEGAL",
    );
  });

  test("Legal approving the document makes the parcel leasable", async () => {
    const documentId = await uploadRecord(userId);
    const { parcelId } = await register(documentId);

    await approve(documentId);
    const outcome = await reEvaluate(parcelId);

    expect(outcome.status).toBe("VERIFIED");
    expect(await landIsLeasable(db, userId)).toBe(true);
  });

  test("the decision and when it was made are both stored", async () => {
    const documentId = await uploadRecord(userId);
    const { parcelId } = await register(documentId);
    await approve(documentId);
    await reEvaluate(parcelId);

    const parcel = await parcelRow(parcelId);
    expect(parcel.verificationStatus).toBe("VERIFIED");
    expect(parcel.decidedAt).not.toBeNull();
    expect(parcel.ownerNameMatchScore).not.toBeNull();
  });

  /**
   * The name on the record is compared against the name we verified, not
   * against the name on the next document — otherwise two documents agreeing
   * with each other would be taken as agreeing with reality.
   */
  test("a record in somebody else's name is reviewed", async () => {
    const documentId = await uploadRecord(userId, {
      marker: "--owner-anita-desai",
    });
    const { parcelId } = await register(documentId);
    await approve(documentId);
    const outcome = await reEvaluate(parcelId);

    expect(outcome.status).toBe("MANUAL_REVIEW");
    expect(outcome.reasons.map((r) => r.code)).toContain(
      "LAND_OWNER_NAME_MISMATCH",
    );
    expect(await landIsLeasable(db, userId)).toBe(false);
  });

  test("a document Legal rejected leaves the parcel rejected", async () => {
    const documentId = await uploadRecord(userId);
    const { parcelId } = await register(documentId);

    await withContext(db, { role: "staff", userId: reviewerId }, (tx) =>
      approveDocument(tx, {
        documentId,
        reviewerUserId: reviewerId,
        approved: false,
        reasonCode: "DOCUMENT_ILLEGIBLE",
        now: NOW,
      }),
    );

    const outcome = await reEvaluate(parcelId);
    expect(outcome.status).toBe("REJECTED");
    expect(await landIsLeasable(db, userId)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe("jointly held land", () => {
  test("co-owners on the record hold the parcel back", async () => {
    const documentId = await uploadRecord(userId);
    const { parcelId } = await register(documentId, userId, [
      "SUNITA SHARMA",
      "MOHAN LAL SHARMA",
    ]);
    await approve(documentId);
    const outcome = await reEvaluate(parcelId);

    expect(outcome.status).toBe("MANUAL_REVIEW");
    expect(outcome.reasons.map((r) => r.code)).toContain(
      "LAND_CO_OWNER_CONSENT_REQUIRED",
    );
  });

  test("the co-owners are stored so a reviewer knows who to ask", async () => {
    const documentId = await uploadRecord(userId);
    const { parcelId } = await register(documentId, userId, ["SUNITA SHARMA"]);

    expect((await parcelRow(parcelId)).coOwnerNames).toEqual(["SUNITA SHARMA"]);
  });

  test("Legal confirming consent releases the parcel", async () => {
    const documentId = await uploadRecord(userId);
    const { parcelId } = await register(documentId, userId, ["SUNITA SHARMA"]);
    await approve(documentId);

    await withContext(db, { role: "staff", userId: reviewerId }, (tx) =>
      confirmCoOwnerConsent(tx, {
        parcelId,
        reviewerUserId: reviewerId,
        note: "Spoke to Sunita Sharma; she agrees to the lease.",
        now: NOW,
      }),
    );

    const outcome = await reEvaluate(parcelId);
    expect(outcome.status).toBe("VERIFIED");
  });

  test("who confirmed it and when are recorded", async () => {
    const documentId = await uploadRecord(userId);
    const { parcelId } = await register(documentId, userId, ["SUNITA SHARMA"]);

    await withContext(db, { role: "staff", userId: reviewerId }, (tx) =>
      confirmCoOwnerConsent(tx, {
        parcelId,
        reviewerUserId: reviewerId,
        now: NOW,
      }),
    );

    const parcel = await parcelRow(parcelId);
    expect(parcel.coOwnerConsentConfirmed).toBe(true);
    expect(parcel.coOwnerConsentBy).toBe(reviewerId);
    expect(parcel.coOwnerConsentAt).not.toBeNull();

    const audit = await owner.sql<{ action: string }[]>`
      SELECT action FROM audit_log WHERE action = 'land_parcel.co_owner_consent'
    `;
    expect(audit).toHaveLength(1);
  });

  /**
   * Confirming consent on a parcel with no co-owners is meaningless and
   * suggests the reviewer is on the wrong record.
   */
  test("consent cannot be confirmed on solely held land", async () => {
    const documentId = await uploadRecord(userId);
    const { parcelId } = await register(documentId);

    await expect(
      withContext(db, { role: "staff", userId: reviewerId }, (tx) =>
        confirmCoOwnerConsent(tx, {
          parcelId,
          reviewerUserId: reviewerId,
          now: NOW,
        }),
      ),
    ).rejects.toThrow(/co-owner/i);
  });

  /** The owner cannot confirm their own co-owners agreed. */
  test("the parcel's own owner cannot confirm the consent", async () => {
    const documentId = await uploadRecord(userId);
    const { parcelId } = await register(documentId, userId, ["SUNITA SHARMA"]);

    await expect(
      withContext(db, { role: "staff", userId }, (tx) =>
        confirmCoOwnerConsent(tx, {
          parcelId,
          reviewerUserId: userId,
          now: NOW,
        }),
      ),
    ).rejects.toThrow(/own/i);
  });
});

/* ------------------------------------------------------------------ */

describe("the same plot claimed twice", () => {
  /**
   * The land equivalent of the duplicate-PAN check. Registering a neighbour's
   * plot, or the same plot through two accounts to collect two sets of rent,
   * is a real fraud and this is where it surfaces.
   */
  test("a second claimant is held for review", async () => {
    const mine = await uploadRecord(userId);
    const first = await register(mine);
    await approve(mine);
    await reEvaluate(first.parcelId);

    const theirs = await uploadRecord(neighbourId);
    const second = await register(theirs, neighbourId);
    await approve(theirs);
    const outcome = await reEvaluate(second.parcelId, neighbourId);

    expect(outcome.status).toBe("MANUAL_REVIEW");
    expect(outcome.reasons.map((r) => r.code)).toContain(
      "LAND_KHASRA_ALREADY_CLAIMED",
    );
  });

  /**
   * And the first claimant is NOT invalidated — including after their own
   * parcel is re-decided, which is the part that matters.
   *
   * The earlier version of this test re-decided only the SECOND parcel, so it
   * passed on stale state: the first parcel still held a verdict reached
   * before the rival claim existed. Running the walkthrough twice exposed it —
   * on the second pass the real owner had lost their lease to the other
   * account's claim. Re-deciding the first parcel explicitly is what makes
   * this assertion mean anything.
   */
  test("the first claimant keeps their verdict, even after re-evaluation", async () => {
    const mine = await uploadRecord(userId);
    const first = await register(mine);
    await approve(mine);
    await reEvaluate(first.parcelId);

    const theirs = await uploadRecord(neighbourId);
    const second = await register(theirs, neighbourId);
    await reEvaluate(second.parcelId, neighbourId);

    /** The rival claim now exists. Decide the first parcel again. */
    const again = await reEvaluate(first.parcelId);

    expect(again.status).toBe("VERIFIED");
    expect((await parcelRow(first.parcelId)).verificationStatus).toBe("VERIFIED");
  });

  /**
   * They are told about it. A flag blocks nothing and keeps support from being
   * blind when the second claimant telephones.
   */
  test("the first claimant's parcel carries the dispute as a flag", async () => {
    const mine = await uploadRecord(userId);
    const first = await register(mine);
    await approve(mine);

    const theirs = await uploadRecord(neighbourId);
    const second = await register(theirs, neighbourId);
    await reEvaluate(second.parcelId, neighbourId);

    const again = await reEvaluate(first.parcelId);

    expect(again.reasons.map((r) => r.code)).toContain("LAND_KHASRA_DISPUTED");
    expect(again.reasons.every((r) => r.severity === "FLAG")).toBe(true);
  });

  /**
   * And a lease stays signable through a dispute raised by somebody else.
   * Without the first-claimant rule this is how a stranger would take a
   * verified owner's land out of service.
   */
  test("a later claim cannot take the first claimant's lease away", async () => {
    const mine = await uploadRecord(userId);
    const first = await register(mine);
    await approve(mine);
    await reEvaluate(first.parcelId);

    expect(await landIsLeasable(db, userId)).toBe(true);

    const theirs = await uploadRecord(neighbourId);
    const second = await register(theirs, neighbourId);
    await reEvaluate(second.parcelId, neighbourId);
    await reEvaluate(first.parcelId);

    expect(await landIsLeasable(db, userId)).toBe(true);
    expect(await landIsLeasable(db, neighbourId)).toBe(false);
  });

  /** A parcel is not a duplicate of itself. */
  test("re-evaluating a parcel does not flag it against itself", async () => {
    const documentId = await uploadRecord(userId);
    const { parcelId } = await register(documentId);
    await approve(documentId);

    await reEvaluate(parcelId);
    const again = await reEvaluate(parcelId);

    expect(again.status).toBe("VERIFIED");
  });
});

/* ------------------------------------------------------------------ */

describe("whether a lease can be signed", () => {
  test("somebody with no land cannot", async () => {
    expect(await landIsLeasable(db, userId)).toBe(false);
  });

  test("one verified parcel is enough", async () => {
    const documentId = await uploadRecord(userId);
    const { parcelId } = await register(documentId);
    await approve(documentId);
    await reEvaluate(parcelId);

    expect(await landIsLeasable(db, userId)).toBe(true);
  });

  /**
   * One good parcel is enough to sign a lease for that parcel. A second plot
   * still under review does not block the first — and the lease names a
   * khasra number, so there is no ambiguity about which land it covers.
   */
  test("a parcel under review does not block a verified one", async () => {
    const good = await uploadRecord(userId);
    const goodParcel = await register(good);
    await approve(good);
    await reEvaluate(goodParcel.parcelId);

    /**
     * A genuinely different plot, hence the khasra marker. Without it the
     * extractor returns the same khasra number for every land document, and
     * the second upload would correctly join the first parcel rather than
     * creating the second one this test is about.
     */
    const doubtful = await uploadRecord(userId, {
      marker: "--khasra-512-7--owner-anita-desai",
      docType: "KHASRA_KHATAUNI",
    });
    const doubtfulParcel = await register(doubtful, userId);
    await reEvaluate(doubtfulParcel.parcelId);

    expect(await landIsLeasable(db, userId)).toBe(true);
  });

  test("another person's verified parcel does not count", async () => {
    const documentId = await uploadRecord(userId);
    const { parcelId } = await register(documentId);
    await approve(documentId);
    await reEvaluate(parcelId);

    expect(await landIsLeasable(db, neighbourId)).toBe(false);
  });
});
