import { randomUUID } from "node:crypto";
import { DEFAULT_KYC_THRESHOLDS } from "@kilowattx/core";
import { auditLog, documents, withContext, type Database } from "@kilowattx/db";
import type {
  DocumentExtractor,
  DocumentScanner,
  FileStore,
  LocalDiskBucket,
} from "@kilowattx/integrations";
import {
  DEFAULT_DOWNLOAD_SECONDS,
  KYC_DOCS_PREFIX,
} from "@kilowattx/integrations";
import {
  approveDocument,
  documentIsUsable,
  evaluateParcel,
  processUploadedDocument,
  registerParcelFromDocument,
  registerUpload,
} from "@kilowattx/kyc-pipeline";
import type {
  ConfirmUploadInput,
  DocumentReviewInput,
  UploadUrlInput,
} from "@kilowattx/validation";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { ApiError } from "../common/errors.js";
import { DI, type AppConfig } from "../config.js";
import type { SelfieCheck } from "../kyc/kyc.service.js";

/**
 * Uploading, viewing and reviewing documents.
 *
 * The browser never streams a file through this process. It asks for a signed
 * URL, PUTs straight to the bucket, and tells us when it is done — which keeps
 * a 25 MB scan off the event loop and makes "every access is logged" true,
 * because asking for a URL is the only way to reach a file.
 */

/** How many documents a reviewer sees at once. */
const QUEUE_LIMIT = 50;

@Injectable()
export class DocumentsService {
  constructor(
    @Inject(DI.CONFIG) private readonly config: AppConfig,
    @Inject(DI.DATABASE) private readonly db: Database,
    @Inject(DI.FILE_STORE) private readonly files: FileStore,
    @Inject(DI.DOCUMENT_SCANNER) private readonly scanner: DocumentScanner,
    @Inject(DI.DOCUMENT_EXTRACTOR) private readonly extractor: DocumentExtractor,
    @Inject(DI.FILE_BUCKET) private readonly bucket: LocalDiskBucket,
    @Inject(DI.CLOCK) private readonly clock: () => Date,
    /**
     * A lookup function rather than KycService itself.
     *
     * KycService reads whether a user's land is leasable, so injecting it here
     * would be a circular dependency. Narrowing the need to "give me the name
     * we verified" keeps the direction one-way.
     */
    @Inject(DI.VERIFIED_NAME_LOOKUP)
    private readonly verifiedNameOf: (userId: string) => Promise<string | null>,
    /** The same narrowing, for comparing a selfie with the Aadhaar photograph. */
    @Inject(DI.SELFIE_CHECK)
    private readonly checkSelfie: (
      userId: string,
      documentId: string,
      storageKey: string,
    ) => Promise<SelfieCheck>,
  ) {}

  private readonly logger = new Logger(DocumentsService.name);

  /* ---------------------------------------------------------------- */

  /**
   * Issues somewhere to upload to.
   *
   * The key is built here, from the caller's own id. A client-supplied key
   * would let one customer write over another's deed by asking for their key,
   * and the bucket-prefix check would not catch it because both keys are
   * inside the bucket.
   */
  async createUploadUrl(userId: string, input: UploadUrlInput) {
    const extension = extensionOf(input.fileName, input.contentType);

    /**
     * The development markers that steer the fake scanner and extractor.
     *
     * Dropped in production, exactly like the KYC session's testScenario. The
     * schema restricts them to an allowlist — and the khasra number to digits
     * and one slash — because these values become part of a storage key, and a
     * key must never be assembled from anything a client can write freely.
     */
    const marker =
      this.config.NODE_ENV === "production"
        ? ""
        : [
            ...(input.testKhasra
              ? [`khasra-${input.testKhasra.replace("/", "-")}`]
              : []),
            ...(input.testMarkers ?? []),
          ]
            .map((m) => `--${m}`)
            .join("");

    const key = `${KYC_DOCS_PREFIX}${userId}/${input.docType}/${randomUUID()}${marker}${extension}`;

    const upload = await this.files.createUploadUrl({
      key,
      contentType: input.contentType,
      maxBytes: input.sizeBytes,
      expiresInSeconds: 300,
    });

    return {
      url: upload.url,
      key: upload.key,
      /** The browser must send exactly this, because it is what was signed. */
      contentType: upload.contentType,
      maxBytes: upload.maxBytes,
      expiresAt: upload.expiresAt.toISOString(),
    };
  }

  /* ---------------------------------------------------------------- */

  /**
   * Records that the upload finished, then scans and extracts.
   *
   * In production a bucket event triggers this, which is why it is idempotent and
   * why it re-derives everything from the key rather than trusting a request
   * body. Called from the browser today because there is no bucket to emit the
   * event.
   */
  async confirmUpload(userId: string, input: ConfirmUploadInput) {
    const prefix = `${KYC_DOCS_PREFIX}${userId}/`;
    if (!input.storageKey.startsWith(prefix)) {
      /**
       * 403 rather than 404: the caller knows the key, so there is nothing
       * left to conceal, and telling them plainly that it is not theirs is
       * more useful than pretending it does not exist.
       */
      throw ApiError.forbidden(
        "NOT_YOUR_UPLOAD",
        "That object key was not issued to you.",
      );
    }

    const docType = docTypeFromKey(input.storageKey);

    const outcome = await withContext(this.db, { role: "system", userId }, async (tx) => {
      const registered = await registerUpload(tx, {
        ownerUserId: userId,
        docType,
        storageKey: input.storageKey,
        contentType: contentTypeOf(input.storageKey),
        sizeBytes: 0,
        sha256: input.sha256,
        now: this.clock(),
      });

      return processUploadedDocument(tx, {
        documentId: registered.documentId,
        scanner: this.scanner,
        extractor: this.extractor,
        now: this.clock(),
      });
    });

    /**
     * Quarantine means the bytes are destroyed, not merely that no link is
     * issued. Deliberately after the transaction: the finding is committed
     * first, so a delete that fails leaves an INFECTED record and a loud log
     * line rather than a document that looks merely unscanned.
     *
     * A failure here is logged and swallowed. Re-throwing would answer the
     * uploader with a 500 after their file was correctly identified and
     * correctly refused — which reads as "try again", and the retry would
     * upload the malware a second time.
     */
    if (outcome.quarantinedKey) {
      try {
        await this.bucket.delete(outcome.quarantinedKey);
      } catch (error) {
        this.logger.error(
          `QUARANTINE INCOMPLETE: document ${outcome.documentId} scanned INFECTED but its object could not be deleted. ` +
            `The key is in the audit log and must be removed from storage by hand. ${String(error)}`,
        );
      }
    }

    /**
     * A land record is also a claim about a plot, so it gets a parcel.
     *
     * Only for the document types that say who holds land — a selfie is not a
     * plot, and making a parcel out of every upload would fill the reviewer's
     * queue with land that does not exist.
     *
     * A failure here does not fail the upload. The document is stored, scanned
     * and extracted; a parcel that could not be created — an unreadable khasra
     * number, most often — is a reason for a human to read the document, not a
     * reason to throw it away and ask the customer to send it again.
     */
    let landParcelId: string | null = null;

    if (outcome.scanStatus === "CLEAN" && LAND_DOC_TYPES.has(docType)) {
      const verifiedName = (await this.verifiedNameOf(userId)) ?? "";

      try {
        const parcel = await withContext(
          this.db,
          { role: "system", userId },
          (tx) =>
            registerParcelFromDocument(tx, {
              documentId: outcome.documentId,
              ownerUserId: userId,
              verifiedName,
              thresholds: DEFAULT_KYC_THRESHOLDS,
              now: this.clock(),
            }),
        );
        landParcelId = parcel.parcelId;
      } catch (error) {
        this.logger.warn(
          `Document ${outcome.documentId} scanned clean but produced no land parcel: ${String(error)}. ` +
            "The document is stored and will need a reviewer to read it.",
        );
      }
    }

    /**
     * A selfie is compared with the Aadhaar photograph as soon as it is known
     * to be clean. A refusal throws from here with a reason the person can act
     * on — a different face, no face, two faces — while they are still on the
     * camera screen, rather than surfacing days later as a reviewer's verdict.
     */
    const faceCheck =
      outcome.scanStatus === "CLEAN" && docType === "SELFIE"
        ? await this.checkSelfie(userId, outcome.documentId, input.storageKey)
        : undefined;

    const fields = await this.fieldsOf(userId, outcome.documentId);

    return {
      landParcelId,
      documentId: outcome.documentId,
      scanStatus: outcome.scanStatus,
      /** SELFIE only. Never a decision — `decideKyc` still makes that. */
      faceCheck: faceCheck?.outcome,
      lowConfidenceFieldCount: outcome.lowConfidenceFieldCount,
      needsManualReview: outcome.needsManualReview,
      /**
       * Returned so the browser can pre-fill the form the customer is about to
       * check. Only what the document itself says — never a decision.
       */
      fields,
    };
  }

  private async fieldsOf(userId: string, documentId: string) {
    const rows = await withContext(this.db, { role: "system", userId }, (tx) =>
      tx
        .select({ fields: documents.extractedFields })
        .from(documents)
        .where(eq(documents.id, documentId))
        .limit(1),
    );
    return rows[0]?.fields ?? {};
  }

  /* ---------------------------------------------------------------- */

  /**
   * A short-lived URL to read one document, and an audit row saying who asked.
   *
   * Issuing the URL *is* the access: nothing afterwards passes through us, so
   * logging a later "download" would be logging something we cannot see.
   */
  async createDownloadUrl(params: {
    documentId: string;
    actorUserId: string;
    isStaff: boolean;
    staffRoles: readonly string[];
    ipAddress?: string;
  }) {
    const rows = await withContext(
      this.db,
      params.isStaff
        ? { role: "staff", userId: params.actorUserId }
        : { role: "customer", userId: params.actorUserId },
      (tx) =>
        tx
          .select({
            id: documents.id,
            storageKey: documents.storageKey,
            docType: documents.docType,
            scanStatus: documents.scanStatus,
            ownerUserId: documents.ownerUserId,
          })
          .from(documents)
          .where(eq(documents.id, params.documentId))
          .limit(1),
    );

    /**
     * RLS has already hidden other customers' documents, so an empty result
     * here means "not yours" as well as "no such thing". Both answer 404: a
     * customer probing ids should not be able to tell them apart.
     */
    const document = rows[0];
    if (!document) {
      throw ApiError.notFound("NOT_FOUND", "Not found.");
    }

    /**
     * No URL for an infected file, for anybody, including Legal. A reviewer
     * opening one to "see what it is" is the exact outcome the scan exists to
     * prevent — and 409 rather than 404 because the document is real and the
     * caller is entitled to know why they cannot have it.
     */
    if (!documentIsUsable(document)) {
      throw ApiError.conflict(
        "DOCUMENT_NOT_AVAILABLE",
        document.scanStatus === "INFECTED"
          ? "This file failed a virus scan and cannot be opened. Please upload a replacement."
          : "This file has not finished scanning yet. Try again shortly.",
      );
    }

    const download = await this.files.createDownloadUrl({
      key: document.storageKey,
      expiresInSeconds: DEFAULT_DOWNLOAD_SECONDS,
    });

    /**
     * Written under the system role, not the caller's. A staff role has no
     * INSERT policy on audit_log, and an access log the accessor can suppress
     * is not an access log.
     */
    await withContext(this.db, { role: "system" }, (tx) =>
      tx.insert(auditLog).values({
        actorUserId: params.actorUserId,
        actorType: params.isStaff ? "STAFF" : "CUSTOMER",
        action: "document.viewed",
        resourceType: "document",
        resourceId: document.id,
        changes: {
          docType: document.docType,
          staffRoles: params.isStaff ? [...params.staffRoles] : undefined,
          expiresAt: download.expiresAt.toISOString(),
        },
        ipAddress: params.ipAddress ?? null,
      }),
    );

    return {
      url: download.url,
      expiresAt: download.expiresAt.toISOString(),
      docType: document.docType,
    };
  }

  /* ---------------------------------------------------------------- */

  /** Documents waiting on a human, oldest first. */
  async reviewQueue() {
    const rows = await withContext(this.db, { role: "staff" }, (tx) =>
      tx
        .select({
          id: documents.id,
          docType: documents.docType,
          ownerUserId: documents.ownerUserId,
          ownerOrgId: documents.ownerOrgId,
          scanStatus: documents.scanStatus,
          lowConfidenceFieldCount: documents.lowConfidenceFieldCount,
          createdAt: documents.createdAt,
        })
        .from(documents)
        .where(
          and(
            eq(documents.scanStatus, "CLEAN"),
            /** Not yet decided. A reviewed document leaves the queue. */
            isNull(documents.approved),
            /**
             * The same rule the pipeline applies, as a query: two or more
             * illegible fields, or nothing read at all. Expressed here rather
             * than stored as a flag so retuning the threshold does not need a
             * backfill.
             */
            or(
              sql`${documents.lowConfidenceFieldCount} >= 2`,
              sql`${documents.extractedFields} = '{}'::jsonb`,
            ),
          ),
        )
        .orderBy(desc(documents.createdAt))
        .limit(QUEUE_LIMIT),
    );

    return { documents: rows };
  }

  /* ---------------------------------------------------------------- */

  async review(params: {
    documentId: string;
    reviewerUserId: string;
    input: DocumentReviewInput;
  }) {
    await withContext(
      this.db,
      { role: "staff", userId: params.reviewerUserId },
      (tx) =>
        approveDocument(tx, {
          documentId: params.documentId,
          reviewerUserId: params.reviewerUserId,
          approved: params.input.approved,
          reasonCode: params.input.reasonCode,
          note: params.input.note,
          now: this.clock(),
        }),
    );

    /**
     * Approving or rejecting a document can change its parcel's verdict, so
     * the verdict is recomputed rather than left to drift.
     *
     * Outside the review transaction on purpose. The reviewer's decision is
     * the thing that has to be durable — if re-deciding the parcel failed
     * inside the same transaction, the approval would roll back with it and
     * the reviewer would be told their decision did not take, when all that
     * is needed is to run the decision again.
     */
    const parcelRows = await withContext(this.db, { role: "system" }, (tx) =>
      tx
        .select({
          landParcelId: documents.landParcelId,
          ownerUserId: documents.ownerUserId,
        })
        .from(documents)
        .where(eq(documents.id, params.documentId))
        .limit(1),
    );

    const parcel = parcelRows[0];

    if (parcel?.landParcelId && parcel.ownerUserId) {
      const verifiedName = (await this.verifiedNameOf(parcel.ownerUserId)) ?? "";

      try {
        await withContext(
          this.db,
          { role: "system", userId: parcel.ownerUserId },
          (tx) =>
            evaluateParcel(tx, {
              parcelId: parcel.landParcelId!,
              verifiedName,
              thresholds: DEFAULT_KYC_THRESHOLDS,
              now: this.clock(),
            }),
        );
      } catch (error) {
        this.logger.error(
          `Document ${params.documentId} was reviewed but its land parcel ${parcel.landParcelId} ` +
            `could not be re-decided: ${String(error)}. The parcel's verdict is stale.`,
        );
      }
    }

    return { documentId: params.documentId, approved: params.input.approved };
  }
}

/**
 * The document types that say who holds land.
 *
 * A sale deed is here even though it cannot establish the present position on
 * its own: it names a khasra number, and attaching it to the parcel is how a
 * reviewer comes to see the deed and the record of rights side by side.
 */
const LAND_DOC_TYPES = new Set([
  "JAMABANDI",
  "KHASRA_KHATAUNI",
  "MUTATION_RECORD",
  "SALE_DEED",
]);

/* ------------------------------------------------------------------ */

const EXTENSION_BY_TYPE: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/heic": ".heic",
  "image/heif": ".heif",
};

/**
 * The extension comes from the content type, not from the file name.
 *
 * A name arrives from a browser and can be anything: `../../x`,
 * `deed.pdf.exe`, 200 characters of unicode. Deriving it from the type that
 * was validated leaves no path for any of that, and the customer's original
 * name is not needed once the key is ours.
 */
function extensionOf(_fileName: string, contentType: string): string {
  return EXTENSION_BY_TYPE[contentType] ?? ".bin";
}

const TYPE_BY_EXTENSION: Record<string, string> = Object.fromEntries(
  Object.entries(EXTENSION_BY_TYPE).map(([type, ext]) => [ext, type]),
);

function contentTypeOf(key: string): string {
  const dot = key.lastIndexOf(".");
  return TYPE_BY_EXTENSION[key.slice(dot)] ?? "application/octet-stream";
}

/**
 * The document type is read back out of the key we issued.
 *
 * Taken from the key rather than the confirmation body deliberately: in
 * production the confirmation is a bucket event, which carries a key and nothing
 * else. A body field would work today and break at the moment the real bucket
 * is wired up.
 */
function docTypeFromKey(key: string) {
  const parts = key.split("/");
  const docType = parts[2];

  if (!docType) {
    throw ApiError.badRequest(
      "MALFORMED_KEY",
      "That object key does not name a document type.",
    );
  }

  return docType as Parameters<typeof registerUpload>[1]["docType"];
}
