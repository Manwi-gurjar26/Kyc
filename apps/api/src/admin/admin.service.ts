import {
  DEFAULT_KYC_THRESHOLDS,
  canReviewCase,
  type KycThresholds,
  type ReviewCaseType,
} from "@kilowattx/core";
import {
  applyReviewDecision,
  auditLog,
  documents,
  kycChecks,
  kycRecords,
  organisations,
  users,
  withContext,
  type Database,
  type ReviewAction,
} from "@kilowattx/db";
import type { FileStore } from "@kilowattx/integrations";
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { DI, type AppConfig } from "../config.js";
import { ApiError } from "../common/errors.js";
import { KycService, type Clock } from "../kyc/kyc.service.js";

/**
 * The manual review queue.
 *
 * Everything a reviewer needs to decide, and nothing they do not. The
 * guide is specific about the evidence: the two photographs side by side, the
 * vendor's scores against the thresholds in force, and three columns showing
 * what the user typed, what the document says and what the vendor returned.
 */

/** Document types that make a case Legal's rather than compliance's. */
const LAND_DOCUMENT_TYPES = [
  "SALE_DEED",
  "JAMABANDI",
  "KHASRA_KHATAUNI",
  "MUTATION_RECORD",
] as const;

export interface QueueRow {
  id: string;
  subjectName: string | null;
  subjectType: string;
  level: string;
  caseType: ReviewCaseType;
  /** Reason codes only. The detail text quotes names and scores. */
  reasonCodes: string[];
  faceMatchScore: number | null;
  createdAt: Date;
  /** Whole hours, so the UI does not have to do date arithmetic. */
  waitingHours: number;
  /** Whether the staff member asking may act on this one. */
  actionable: boolean;
}

export interface CaseDetail extends QueueRow {
  status: string;
  aadhaarLast4: string | null;
  panLast4: string | null;
  vendor: string | null;
  vendorVersion: string | null;
  reasons: { code: string; detail: string; severity: string }[];
  /**
   * Short-lived URLs for the two photographs, null when absent.
   *
   * These are the face check. No gateway this system can reach sells a face
   * match, so a reviewer comparing the two images is the only comparison that
   * happens — and null has to be distinguishable so the screen can say "not
   * uploaded" rather than render a broken image.
   */
  selfieUrl: string | null;
  aadhaarPhotoUrl: string | null;
  thresholdsUsed: Record<string, number> | null;
  checks: {
    checkType: string;
    status: string;
    score: number | null;
    detail: string | null;
    attemptNumber: number;
    createdAt: Date;
  }[];
  documents: {
    id: string;
    docType: string;
    scanStatus: string;
    lowConfidenceFieldCount: number | null;
    createdAt: Date;
  }[];
  timeline: {
    action: string;
    actorType: string;
    reasonCode: string | null;
    note: string | null;
    createdAt: Date;
  }[];
}

@Injectable()
export class AdminService {
  constructor(
    @Inject(DI.CONFIG) private readonly config: AppConfig,
    @Inject(DI.DATABASE) private readonly db: Database,
    @Inject(DI.CLOCK) private readonly clock: Clock,
    @Inject(KycService) private readonly kyc: KycService,
    /**
     * Mints the short-lived URLs for the two photographs.
     *
     * The reviewer has to compare them by eye, because no gateway this system
     * can reach sells a face match — so without these the one screen whose
     * purpose is looking at evidence has no evidence on it.
     */
    @Inject(DI.FILE_STORE) private readonly files: FileStore,
  ) {}

  /**
   * A short-lived URL for an object-store key, or null when there is no key.
   */
  private async photoUrlFor(key: string | null): Promise<string | null> {
    if (!key) return null;
    const url = await this.files.createDownloadUrl({ key });
    return url.url;
  }

  /**
   * The subject's selfie, found by owner rather than by case.
   *
   * `documents.kyc_record_id` is null for anything uploaded through the
   * ordinary upload endpoint — it does not pass one — so joining the case to
   * its documents finds no selfie even though one is sitting in the bucket.
   * Resolving by owner is what actually works today.
   *
   * CLEAN only, matching the decision: a quarantined file is not evidence,
   * and handing a reviewer a URL to an infected image would be worse than
   * showing them nothing.
   */
  private async selfieUrlFor(userId: string | null): Promise<string | null> {
    if (!userId) return null;

    const rows = await withContext(this.db, { role: "staff" }, (tx) =>
      tx
        .select({ storageKey: documents.storageKey })
        .from(documents)
        .where(
          and(
            eq(documents.ownerUserId, userId),
            eq(documents.docType, "SELFIE"),
            eq(documents.scanStatus, "CLEAN"),
          ),
        )
        .orderBy(desc(documents.createdAt))
        .limit(1),
    );

    return this.photoUrlFor(rows[0]?.storageKey ?? null);
  }

  /**
   * Which kind of case this is, and therefore who may act on it.
   *
   * Derived from the record rather than stored, because it follows from the
   * evidence: a business check is a KYB, a case with registry papers attached
   * is Legal's, anything else is a personal case.
   */
  private async caseTypeOf(
    recordId: string,
    level: string,
  ): Promise<ReviewCaseType> {
    if (level === "KYB") return "KYB";

    const landDocs = await withContext(this.db, { role: "staff" }, (tx) =>
      tx
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.kycRecordId, recordId),
            inArray(documents.docType, [...LAND_DOCUMENT_TYPES]),
          ),
        )
        .limit(1),
    );

    return landDocs.length > 0 ? "LAND_DOCUMENTS" : "PERSONAL";
  }

  private hoursSince(from: Date): number {
    return Math.floor((this.clock().getTime() - from.getTime()) / 3_600_000);
  }

  /**
   * The open queue, oldest first.
   *
   * Oldest first because the metric that matters is how long somebody has been
   * waiting on a decision, and a queue sorted any other way lets the awkward
   * cases sink.
   */
  async queue(staffRoles: readonly string[]): Promise<{ rows: QueueRow[] }> {
    const records = await withContext(this.db, { role: "staff" }, (tx) =>
      tx
        .select({
          id: kycRecords.id,
          subjectType: kycRecords.subjectType,
          level: kycRecords.level,
          reasons: kycRecords.decisionReasons,
          faceMatchScore: kycRecords.faceMatchScore,
          createdAt: kycRecords.createdAt,
          /**
           * A KYB case belongs to an organisation, so `user_id` is null and a
           * users-only join leaves the name blank. A reviewer cannot pick a
           * case out of a queue of blanks.
           */
          subjectName: sql<string | null>`coalesce(${users.displayName}, ${organisations.legalName})`,
        })
        .from(kycRecords)
        .leftJoin(users, eq(users.id, kycRecords.userId))
        .leftJoin(organisations, eq(organisations.id, kycRecords.orgId))
        .where(eq(kycRecords.status, "MANUAL_REVIEW"))
        .orderBy(asc(kycRecords.createdAt))
        .limit(100),
    );

    const rows: QueueRow[] = [];
    for (const record of records) {
      const caseType = await this.caseTypeOf(record.id, record.level);
      rows.push({
        id: record.id,
        subjectName: record.subjectName,
        subjectType: record.subjectType,
        level: record.level,
        caseType,
        reasonCodes: (record.reasons ?? []).map((r) => r.code),
        faceMatchScore:
          record.faceMatchScore === null ? null : Number(record.faceMatchScore),
        createdAt: record.createdAt,
        waitingHours: this.hoursSince(record.createdAt),
        /**
         * Shown, not hidden. A reviewer seeing a case they cannot action, with
         * the queue it belongs to, is more useful than a case that silently
         * does not exist for them — otherwise nobody notices that Legal has a
         * week-old backlog.
         */
        actionable: canReviewCase(staffRoles, caseType),
      });
    }

    return { rows };
  }

  /** Everything a reviewer needs for one case. */
  async caseDetail(
    recordId: string,
    staffRoles: readonly string[],
  ): Promise<CaseDetail> {
    const records = await withContext(this.db, { role: "staff" }, (tx) =>
      tx
        .select({
          record: kycRecords,
          /** Same reason as the queue: an organisation has no display name. */
          subjectName: sql<string | null>`coalesce(${users.displayName}, ${organisations.legalName})`,
        })
        .from(kycRecords)
        .leftJoin(users, eq(users.id, kycRecords.userId))
        .leftJoin(organisations, eq(organisations.id, kycRecords.orgId))
        .where(eq(kycRecords.id, recordId))
        .limit(1),
    );

    const found = records[0];
    if (!found) {
      throw ApiError.notFound("CASE_NOT_FOUND", "No such case.");
    }

    const record = found.record;
    const caseType = await this.caseTypeOf(record.id, record.level);

    const [checks, docs, timeline] = await Promise.all([
      withContext(this.db, { role: "staff" }, (tx) =>
        tx
          .select()
          .from(kycChecks)
          .where(eq(kycChecks.kycRecordId, recordId))
          .orderBy(asc(kycChecks.createdAt)),
      ),
      withContext(this.db, { role: "staff" }, (tx) =>
        tx
          .select()
          .from(documents)
          .where(eq(documents.kycRecordId, recordId))
          .orderBy(asc(documents.createdAt)),
      ),
      withContext(this.db, { role: "staff" }, (tx) =>
        tx
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.resourceType, "kyc_record"),
              eq(auditLog.resourceId, recordId),
            ),
          )
          .orderBy(desc(auditLog.createdAt))
          .limit(50),
      ),
    ]);

    return {
      id: record.id,
      subjectName: found.subjectName,
      subjectType: record.subjectType,
      level: record.level,
      caseType,
      status: record.status,
      aadhaarLast4: record.aadhaarLast4,
      panLast4: record.panLast4,
      vendor: record.vendor,
      vendorVersion: record.vendorVersion,
      reasonCodes: (record.decisionReasons ?? []).map((r) => r.code),
      /** Full detail here, because this screen is the reviewer's evidence. */
      reasons: record.decisionReasons ?? [],
      thresholdsUsed: record.thresholdsUsed ?? null,
      faceMatchScore:
        record.faceMatchScore === null ? null : Number(record.faceMatchScore),
      /**
       * The two images, as short-lived URLs.
       *
       * Null when there is nothing to show, so the screen can fall back to
       * its drawn placeholder rather than rendering a broken image — the
       * fake gateway returns no photograph, and a case can reach review
       * before a selfie is uploaded.
       */
      selfieUrl: await this.selfieUrlFor(record.userId),
      aadhaarPhotoUrl: await this.photoUrlFor(record.aadhaarPhotoKey),
      createdAt: record.createdAt,
      waitingHours: this.hoursSince(record.createdAt),
      actionable: canReviewCase(staffRoles, caseType),
      checks: checks.map((check) => ({
        checkType: check.checkType,
        status: check.status,
        score: check.score === null ? null : Number(check.score),
        detail: check.detail,
        attemptNumber: check.attemptNumber,
        createdAt: check.createdAt,
      })),
      documents: docs.map((doc) => ({
        id: doc.id,
        docType: doc.docType,
        scanStatus: doc.scanStatus,
        lowConfidenceFieldCount: doc.lowConfidenceFieldCount,
        createdAt: doc.createdAt,
      })),
      timeline: timeline.map((entry) => ({
        action: entry.action,
        actorType: entry.actorType,
        reasonCode: entry.reasonCode,
        note: entry.note,
        createdAt: entry.createdAt,
      })),
    };
  }

  /** The thresholds in force now, for the UI to show beside a score. */
  async currentThresholds(): Promise<KycThresholds> {
    return this.kyc.thresholds().catch(() => DEFAULT_KYC_THRESHOLDS);
  }

  /**
   * Records a reviewer's decision.
   *
   * Two gates before the write: the staff member's roles must cover this kind
   * of case, and the state machine must allow the move. Both live outside this
   * method — in `canReviewCase()` and `assertTransition()` — so the same rules
   * apply to anything else that ever decides a case.
   */
  async review(params: {
    recordId: string;
    reviewerUserId: string;
    staffRoles: readonly string[];
    action: ReviewAction;
    reasonCode: string;
    note?: string;
    traceId?: string;
  }): Promise<{ status: string }> {
    const records = await withContext(this.db, { role: "staff" }, (tx) =>
      tx
        .select({ id: kycRecords.id, level: kycRecords.level })
        .from(kycRecords)
        .where(eq(kycRecords.id, params.recordId))
        .limit(1),
    );

    const record = records[0];
    if (!record) {
      throw ApiError.notFound("CASE_NOT_FOUND", "No such case.");
    }

    const caseType = await this.caseTypeOf(record.id, record.level);

    if (!canReviewCase(params.staffRoles, caseType)) {
      throw ApiError.forbidden(
        "REVIEW_NOT_PERMITTED",
        `A ${caseType.toLowerCase().replace("_", " ")} case is not yours to decide.`,
        { caseType },
      );
    }

    try {
      const status = await withContext(this.db, { role: "staff" }, (tx) =>
        applyReviewDecision(tx, {
          kycRecordId: params.recordId,
          action: params.action,
          reasonCode: params.reasonCode,
          note: params.note,
          reviewerUserId: params.reviewerUserId,
          now: this.clock(),
          traceId: params.traceId,
        }),
      );
      return { status };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      /**
       * Two expected failures get proper codes rather than a 500: a stale
       * queue page whose case somebody else already decided, and an attempt to
       * self-review. Both are things a reviewer will actually hit.
       */
      if (/Illegal KYC transition/.test(message)) {
        throw ApiError.conflict(
          "CASE_ALREADY_DECIDED",
          "Somebody has already decided this case. Refresh the queue.",
        );
      }
      if (/own KYC case/.test(message)) {
        throw ApiError.forbidden(
          "SELF_REVIEW_REFUSED",
          "You cannot decide your own case. Please reassign it to a colleague.",
        );
      }
      throw error;
    }
  }

  /** Queue size and age, the two numbers worth alerting on. */
  async queueHealth(): Promise<{ open: number; oldestHours: number | null }> {
    const rows = await withContext(this.db, { role: "staff" }, (tx) =>
      tx
        .select({
          open: sql<number>`count(*)::int`,
          oldest: sql<Date | null>`min(${kycRecords.createdAt})`,
        })
        .from(kycRecords)
        .where(eq(kycRecords.status, "MANUAL_REVIEW")),
    );

    const row = rows[0];
    return {
      open: row?.open ?? 0,
      oldestHours: row?.oldest ? this.hoursSince(new Date(row.oldest)) : null,
    };
  }
}
