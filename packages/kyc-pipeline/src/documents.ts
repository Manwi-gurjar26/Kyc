import { auditLog, documents, type Transaction } from "@kilowattx/db";
import { KYC_DOCS_PREFIX } from "@kilowattx/integrations";
import type {
  DocumentExtractor,
  DocumentScanner,
  DocumentType,
  ExtractedField,
} from "@kilowattx/integrations";
import { eq } from "drizzle-orm";

/**
 * Uploaded documents: scanning, extraction, and Legal's approval.
 *
 * Two rules from the guide drive everything here.
 *
 * An INFECTED document can never be used. Not extracted, not viewed, not
 * approved. It is the only rule on the KYC path whose failure mode is somebody
 * else's machine, so it is enforced at every step rather than once at the
 * entrance — a single check at upload would be defeated by any later code path
 * that loads a document by id.
 *
 * Fields read with at least 0.85 confidence are pre-filled; two or more below
 * it and a human checks the document before it counts. OCR on a faded 1970s
 * Jamabandi is frequently wrong, and a wrong khasra number does not stay a
 * data-quality problem — it ends up on a registered lease.
 */

/**
 * The confidence below which a field is not trusted to pre-fill.
 *
 * Belongs in the `settings` table eventually, with the face-match and
 * name-match bars, so Ops can retune it without a release. Compiled in for now
 * because an unset setting must not silently become zero, and the loader that
 * makes that safe is not written yet.
 */
export const EXTRACTION_CONFIDENCE_FLOOR = 0.85;

/**
 * How many illegible fields it takes to need a human.
 *
 * One is tolerable: the reviewer fixes it from the other fields and the
 * document still reads coherently. Two means the scan itself is doubtful, and
 * the fields that *did* read may be wrong in ways nothing cross-checks.
 */
export const LOW_CONFIDENCE_REVIEW_THRESHOLD = 2;

/** The retention policy's seven years. Legal to confirm the start date. */
export const RETENTION_YEARS = 7;

/**
 * Document types that genuinely contain no text.
 *
 * A selfie extracting nothing is correct, not a failed read. Everything else —
 * including OTHER, which by definition nobody has identified yet — gets a
 * human when it comes back empty.
 */
const NO_TEXT_EXPECTED: ReadonlySet<DocumentType> = new Set(["SELFIE"]);

export interface RegisterUploadResult {
  documentId: string;
  /** True when this key was already registered, so no second row is made. */
  existing: boolean;
}

export interface ProcessDocumentOutcome {
  documentId: string;
  scanStatus: "CLEAN" | "INFECTED" | "ERRORED";
  /** False whenever the scan did not come back clean. */
  extracted: boolean;
  lowConfidenceFieldCount: number;
  needsManualReview: boolean;
  /**
   * The object the caller must destroy, or null.
   *
   * Set only when the scan found malware. The deletion is the caller's
   * because it has to happen after this transaction commits: were it part of
   * the transaction and the delete failed, the INFECTED status would roll back
   * with it and the document would sit there looking merely unscanned. The
   * finding is committed first, the bytes go second, and a failure in between
   * leaves a record somebody can act on rather than nothing at all.
   */
  quarantinedKey: string | null;
}

/* ------------------------------------------------------------------ */

/**
 * Records that a file has arrived, before anything has been done to it.
 *
 * Idempotent on the key. A browser that retries an upload must not create a
 * second row: the unique index would raise, and a caller that swallowed the
 * error would leave a file in the bucket that no scan ever claims.
 */
export async function registerUpload(
  tx: Transaction,
  params: {
    ownerUserId?: string;
    ownerOrgId?: string;
    kycRecordId?: string;
    docType: DocumentType;
    storageKey: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
    now: Date;
  },
): Promise<RegisterUploadResult> {
  /**
   * The same prefix check the file store makes. Repeated rather than trusted,
   * because this function is reachable from a webhook and a worker as well as
   * from the endpoint that minted the upload URL.
   */
  if (!params.storageKey.startsWith(KYC_DOCS_PREFIX)) {
    throw new Error(
      `Document key must start with ${KYC_DOCS_PREFIX} — got "${params.storageKey}". ` +
        "Nothing outside the KYC bucket is tracked as a KYC document.",
    );
  }

  const retentionUntil = new Date(params.now);
  retentionUntil.setUTCFullYear(retentionUntil.getUTCFullYear() + RETENTION_YEARS);

  const inserted = await tx
    .insert(documents)
    .values({
      ownerUserId: params.ownerUserId ?? null,
      ownerOrgId: params.ownerOrgId ?? null,
      kycRecordId: params.kycRecordId ?? null,
      docType: params.docType,
      storageKey: params.storageKey,
      contentType: params.contentType,
      sizeBytes: params.sizeBytes,
      sha256: params.sha256,
      scanStatus: "PENDING",
      retentionUntil,
    })
    .onConflictDoNothing({ target: documents.storageKey })
    .returning({ id: documents.id });

  if (inserted[0]) {
    return { documentId: inserted[0].id, existing: false };
  }

  const existing = await tx
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.storageKey, params.storageKey))
    .limit(1);

  if (!existing[0]) {
    /**
     * The insert conflicted and the row is not visible. Under RLS that means
     * the key belongs to somebody else — not a race. Reporting it as a
     * conflict rather than returning a null id keeps the ambiguity out of the
     * caller.
     */
    throw new Error(
      `Document key "${params.storageKey}" is already registered and not visible in this context.`,
    );
  }

  return { documentId: existing[0].id, existing: true };
}

/* ------------------------------------------------------------------ */

/**
 * Scans a document and, only if it is clean, extracts its fields.
 *
 * Both steps in one transaction with the row locked, so a retry cannot
 * interleave with a reviewer's approval and leave a document approved on the
 * strength of an extraction that was later replaced.
 */
export async function processUploadedDocument(
  tx: Transaction,
  params: {
    documentId: string;
    scanner: DocumentScanner;
    extractor: DocumentExtractor;
    now: Date;
  },
): Promise<ProcessDocumentOutcome> {
  const rows = await tx
    .select({
      id: documents.id,
      storageKey: documents.storageKey,
      docType: documents.docType,
    })
    .from(documents)
    .where(eq(documents.id, params.documentId))
    .limit(1)
    .for("update");

  const document = rows[0];
  if (!document) {
    throw new Error(`Document ${params.documentId} not found.`);
  }

  const scan = await params.scanner.scan({ key: document.storageKey });

  if (scan.status !== "CLEAN") {
    await tx
      .update(documents)
      .set({ scanStatus: scan.status, scannedAt: scan.scannedAt })
      .where(eq(documents.id, document.id));

    /**
     * A quarantine is audited; a scanner outage is not. The first is a thing
     * somebody uploaded on purpose and a security team will ask about. The
     * second is an operational blip the scan retry already records, and
     * writing an audit row per retry would bury the real events.
     */
    if (scan.status === "INFECTED") {
      await tx.insert(auditLog).values({
        actorUserId: null,
        actorType: "SYSTEM",
        action: "document.quarantined",
        resourceType: "document",
        resourceId: document.id,
        changes: {
          signature: scan.signature ?? null,
          docType: document.docType,
          storageKey: document.storageKey,
        },
        reasonCode: "MALWARE_DETECTED",
      });
    }

    /**
     * Not a review item. Handing a reviewer an infected file to look at is
     * precisely the outcome the scan exists to prevent, and a scanner that is
     * down has produced no finding for a human to weigh.
     */
    return {
      documentId: document.id,
      scanStatus: scan.status,
      extracted: false,
      lowConfidenceFieldCount: 0,
      needsManualReview: false,
      /** Only malware is destroyed. An outage found nothing to act on. */
      quarantinedKey: scan.status === "INFECTED" ? document.storageKey : null,
    };
  }

  const extraction = await params.extractor.extract({
    key: document.storageKey,
    docType: document.docType as DocumentType,
  });

  const fieldNames = Object.keys(extraction.fields);
  const lowConfidenceFieldCount = fieldNames.filter(
    (name) => extraction.fields[name]!.confidence < EXTRACTION_CONFIDENCE_FLOOR,
  ).length;

  /**
   * An empty read is reviewed even though it has zero low-confidence fields.
   * Counting alone would wave a blank or corrupt page straight through, and
   * "nothing to pre-fill" needs a human more than a partial read does.
   */
  const readNothing =
    fieldNames.length === 0 &&
    !NO_TEXT_EXPECTED.has(document.docType as DocumentType);

  const needsManualReview =
    lowConfidenceFieldCount >= LOW_CONFIDENCE_REVIEW_THRESHOLD || readNothing;

  await tx
    .update(documents)
    .set({
      scanStatus: "CLEAN",
      scannedAt: scan.scannedAt,
      extractedFields: extraction.fields,
      lowConfidenceFieldCount,
    })
    .where(eq(documents.id, document.id));

  return {
    documentId: document.id,
    scanStatus: "CLEAN",
    extracted: true,
    lowConfidenceFieldCount,
    needsManualReview,
    quarantinedKey: null,
  };
}

/* ------------------------------------------------------------------ */

/**
 * Whether a document may be shown, extracted from, or relied on.
 *
 * Deliberately not the same question as "approved". A clean document is safe
 * to open; whether it proves anything is Legal's call. Conflating the two
 * would mean either serving unscanned files or refusing to show a reviewer the
 * document they are being asked to approve.
 */
export function documentIsUsable(document: {
  scanStatus: string | null;
}): boolean {
  return document.scanStatus === "CLEAN";
}

/* ------------------------------------------------------------------ */

/**
 * Legal's decision on a document.
 *
 * Both refusals live inside the transaction rather than in a controller: an
 * endpoint can be bypassed by a worker, a script or the next endpoint somebody
 * adds, and these two are the ones that matter.
 */
export async function approveDocument(
  tx: Transaction,
  params: {
    documentId: string;
    reviewerUserId: string;
    approved: boolean;
    reasonCode?: string;
    note?: string;
    now: Date;
  },
): Promise<void> {
  const rows = await tx
    .select({
      id: documents.id,
      ownerUserId: documents.ownerUserId,
      scanStatus: documents.scanStatus,
      docType: documents.docType,
      lowConfidenceFieldCount: documents.lowConfidenceFieldCount,
    })
    .from(documents)
    .where(eq(documents.id, params.documentId))
    .limit(1)
    .for("update");

  const document = rows[0];
  if (!document) {
    throw new Error(`Document ${params.documentId} not found.`);
  }

  /**
   * Checked before the self-review rule, because an infected document must be
   * refused for everybody — including a reviewer who has no connection to it.
   */
  if (document.scanStatus !== "CLEAN") {
    throw new Error(
      `Document ${document.id} has scan status ${document.scanStatus} and cannot be reviewed. ` +
        "Only a document that scanned CLEAN may be opened or approved.",
    );
  }

  /**
   * The same rule as the KYC queue. A reviewer approving their own upload
   * defeats the point of a second pair of eyes, and the only place it cannot
   * be routed around is here.
   */
  if (document.ownerUserId && document.ownerUserId === params.reviewerUserId) {
    throw new Error(
      `Reviewer ${params.reviewerUserId} cannot approve their own document ${document.id}.`,
    );
  }

  const updated = await tx
    .update(documents)
    .set({
      approved: params.approved,
      reviewedBy: params.reviewerUserId,
      reviewedAt: params.now,
    })
    .where(eq(documents.id, document.id))
    .returning({ id: documents.id });

  /**
   * RLS returns nothing rather than raising, so an update with no matching
   * policy reports success having changed no rows. That has already happened
   * twice on this codebase; asserting the row count is how it stops being a
   * surprise the third time.
   */
  if (!updated[0]) {
    throw new Error(
      `Document ${document.id} was not updated. The session's role has no UPDATE policy on documents.`,
    );
  }

  await tx.insert(auditLog).values({
    actorUserId: params.reviewerUserId,
    actorType: "STAFF",
    action: "document.reviewed",
    resourceType: "document",
    resourceId: document.id,
    changes: {
      approved: params.approved,
      docType: document.docType,
      lowConfidenceFieldCount: document.lowConfidenceFieldCount,
    },
    reasonCode: params.reasonCode ?? null,
    note: params.note ?? null,
  });
}

export type { ExtractedField };
