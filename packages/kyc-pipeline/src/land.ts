import {
  decideLand,
  type KycThresholds,
  type LandDecision,
  type LandDocumentState,
} from "@kilowattx/core";
import {
  auditLog,
  documents,
  landParcels,
  withContext,
  type Database,
  type Transaction,
} from "@kilowattx/db";
import { and, eq, isNull, ne, sql } from "drizzle-orm";

/**
 * Turning an uploaded land record into a plot we can lease.
 *
 * Two questions live here and they are kept apart on purpose:
 *
 *   Did Legal read the paperwork?        documents.approved
 *   May this land be leased?             land_parcels.verification_status
 *
 * They are not the same answer. The documents can be flawless and the parcel
 * still unusable on one signature, because the record names four siblings. The
 * column that used to carry both meanings is the reason this module exists.
 */

export interface RegisterParcelResult {
  parcelId: string;
  /** True when this khasra already had a parcel, so no second one is made. */
  existing: boolean;
}

export interface ParcelEvaluation extends LandDecision {
  parcelId: string;
}

/* ------------------------------------------------------------------ */

/**
 * Creates — or joins — the parcel a land record is evidence for.
 *
 * Idempotent on the khasra number within a district. Uploading the second page
 * of the same Jamabandi must not produce a second parcel: each would then be
 * half-evidenced and neither would ever become approvable.
 */
export async function registerParcelFromDocument(
  tx: Transaction,
  params: {
    documentId: string;
    ownerUserId: string;
    /** The name we actually verified, for the owner-name comparison. */
    verifiedName: string;
    coOwnerNames?: string[];
    thresholds: KycThresholds;
    now: Date;
  },
): Promise<RegisterParcelResult> {
  const docRows = await tx
    .select({
      id: documents.id,
      scanStatus: documents.scanStatus,
      fields: documents.extractedFields,
      landParcelId: documents.landParcelId,
    })
    .from(documents)
    .where(eq(documents.id, params.documentId))
    .limit(1)
    .for("update");

  const document = docRows[0];
  if (!document) {
    throw new Error(`Document ${params.documentId} not found.`);
  }

  /**
   * An infected or unscanned document is evidence of nothing, so it creates
   * nothing. Checked here as well as at the download endpoint because this is
   * a different route to the same file and must not depend on the other one
   * having been taken first.
   */
  if (document.scanStatus !== "CLEAN") {
    throw new Error(
      `Document ${document.id} has scan status ${document.scanStatus} and cannot establish a land parcel. ` +
        "Only a document that scanned CLEAN is evidence of anything.",
    );
  }

  const fields = document.fields ?? {};
  const khasraNumber = fields.khasraNumber?.value?.trim();

  /**
   * No khasra number, no parcel. A parcel keyed on nothing would collide with
   * every other unreadable record in the district, which is a far worse
   * outcome than refusing — and the document is still there to be read by a
   * human.
   */
  if (!khasraNumber) {
    throw new Error(
      `Document ${document.id} has no khasra number. A land parcel cannot be created without one; ` +
        "the document needs a reviewer to read it.",
    );
  }

  const district = fields.district?.value?.trim() ?? null;
  const village = fields.village?.value?.trim() ?? null;
  const ownerNameOnRecord =
    fields.ownerName?.value?.trim() ?? fields.buyerName?.value?.trim() ?? "";
  const areaAcres = fields.areaAcres?.value?.trim() ?? null;

  /**
   * Scoped to this owner, not global.
   *
   * Two people claiming one khasra number is a case for a reviewer, not a
   * reason to attach the second person's document to the first person's
   * parcel. The duplicate is surfaced by decideLand(); here it stays their
   * own parcel.
   *
   * The district narrows the match only when the incoming document states
   * one. A mutation record frequently does not — it names the khasra, the
   * holder and the mutation number and leaves the district to the record of
   * rights it amends. Requiring `district IS NULL` to match would make that
   * document create a SECOND parcel for the same plot, leaving two
   * half-evidenced parcels neither of which could ever be approved. A missing
   * district is unknown, not different.
   */
  const existingRows = await tx
    .select({ id: landParcels.id, district: landParcels.district })
    .from(landParcels)
    .where(
      and(
        eq(landParcels.ownerUserId, params.ownerUserId),
        eq(landParcels.khasraNumber, khasraNumber),
        ...(district ? [eq(landParcels.district, district)] : []),
      ),
    )
    .limit(1);

  let parcelId = existingRows[0]?.id;
  const existing = Boolean(parcelId);

  if (!parcelId) {
    const inserted = await tx
      .insert(landParcels)
      .values({
        ownerUserId: params.ownerUserId,
        khasraNumber,
        village,
        district,
        areaAcres,
        ownerNameOnRecord,
        coOwnerNames: params.coOwnerNames ?? [],
        verificationStatus: "IN_PROGRESS",
      })
      .returning({ id: landParcels.id });

    parcelId = inserted[0]!.id;
  } else {
    /**
     * A later document can only add what the parcel does not know.
     *
     * Never overwrite with a blank: a record that omits the district is not
     * evidence the district is unknown, and a record that omits a co-owner is
     * not evidence they do not exist. Only the positive direction is
     * information.
     */
    const patch: { district?: string; coOwnerNames?: string[] } = {};

    if (district && !existingRows[0]!.district) patch.district = district;
    if (params.coOwnerNames && params.coOwnerNames.length > 0) {
      patch.coOwnerNames = params.coOwnerNames;
    }

    if (Object.keys(patch).length > 0) {
      await tx.update(landParcels).set(patch).where(eq(landParcels.id, parcelId));
    }
  }

  await tx
    .update(documents)
    .set({ landParcelId: parcelId })
    .where(eq(documents.id, document.id));

  await evaluateParcel(tx, {
    parcelId,
    verifiedName: params.verifiedName,
    thresholds: params.thresholds,
    now: params.now,
  });

  return { parcelId, existing };
}

/* ------------------------------------------------------------------ */

/**
 * Re-runs the verdict on a parcel and stores it.
 *
 * Called whenever anything it depends on changes: a new document, a Legal
 * approval, a consent confirmation. Recomputing the whole decision rather than
 * patching a status is what keeps "verified" from drifting away from the facts
 * underneath it — a status that is only ever nudged forward eventually
 * disagrees with its own evidence.
 */
export async function evaluateParcel(
  tx: Transaction,
  params: {
    parcelId: string;
    verifiedName: string;
    thresholds: KycThresholds;
    now: Date;
  },
): Promise<ParcelEvaluation> {
  const parcelRows = await tx
    .select({
      id: landParcels.id,
      ownerUserId: landParcels.ownerUserId,
      khasraNumber: landParcels.khasraNumber,
      district: landParcels.district,
      createdAt: landParcels.createdAt,
      ownerNameOnRecord: landParcels.ownerNameOnRecord,
      coOwnerNames: landParcels.coOwnerNames,
      coOwnerConsentConfirmed: landParcels.coOwnerConsentConfirmed,
    })
    .from(landParcels)
    .where(eq(landParcels.id, params.parcelId))
    .limit(1)
    .for("update");

  const parcel = parcelRows[0];
  if (!parcel) {
    throw new Error(`Land parcel ${params.parcelId} not found.`);
  }

  const docRows = await tx
    .select({
      docType: documents.docType,
      scanStatus: documents.scanStatus,
      lowConfidenceFieldCount: documents.lowConfidenceFieldCount,
      approved: documents.approved,
    })
    .from(documents)
    .where(eq(documents.landParcelId, parcel.id));

  const documentStates: LandDocumentState[] = docRows.map((row) => ({
    docType: row.docType,
    scanStatus: row.scanStatus as LandDocumentState["scanStatus"],
    lowConfidenceFieldCount: row.lowConfidenceFieldCount ?? 0,
    approved: row.approved,
  }));

  const rival = await rivalClaim(tx, parcel);

  const decision = decideLand({
    ownerNameOnRecord: parcel.ownerNameOnRecord ?? "",
    verifiedName: params.verifiedName,
    coOwnerNames: parcel.coOwnerNames ?? [],
    coOwnerConsentConfirmed: parcel.coOwnerConsentConfirmed,
    documents: documentStates,
    duplicateKhasra: rival !== null,
    claimedFirst: rival !== null && parcel.createdAt <= rival.createdAt,
    thresholds: params.thresholds,
  });

  await tx
    .update(landParcels)
    .set({
      verificationStatus: decision.status,
      decisionReasons: decision.reasons,
      ownerNameMatchScore: decision.ownerNameMatchScore.toFixed(3),
      /**
       * documentsApproved stays what it has always meant: Legal read the
       * paperwork. It is deliberately not set from the parcel's verdict —
       * collapsing the two is the thing this module exists to undo.
       */
      documentsApproved: documentStates.some((d) => d.approved === true),
      decidedAt: params.now,
    })
    .where(eq(landParcels.id, parcel.id));

  return { ...decision, parcelId: parcel.id };
}

/**
 * The earliest competing claim on this khasra number, if there is one.
 *
 * Returns the rival's registration time rather than a bare boolean, because
 * decideLand needs to know which side of the dispute arrived first — whoever
 * registered first is not blocked, so that a stranger cannot take a verified
 * owner's land out of service by claiming their khasra.
 *
 * `ne(id, ...)` matters: without it a parcel is a duplicate of itself and
 * every re-evaluation would flag it. The same mistake the duplicate-PAN check
 * had to be fixed for.
 *
 * Ordered by creation time so the comparison is against the EARLIEST rival.
 * Against an arbitrary one, a third claimant arriving later could change
 * whether the second claimant counts as first.
 */
async function rivalClaim(
  tx: Transaction,
  parcel: {
    id: string;
    ownerUserId: string | null;
    khasraNumber: string;
    district: string | null;
  },
): Promise<{ createdAt: Date } | null> {
  if (!parcel.ownerUserId) return null;

  const clashes = await tx
    .select({ createdAt: landParcels.createdAt })
    .from(landParcels)
    .where(
      and(
        ne(landParcels.id, parcel.id),
        ne(landParcels.ownerUserId, parcel.ownerUserId),
        eq(landParcels.khasraNumber, parcel.khasraNumber),
        parcel.district
          ? eq(landParcels.district, parcel.district)
          : isNull(landParcels.district),
      ),
    )
    .orderBy(landParcels.createdAt)
    .limit(1);

  return clashes[0] ?? null;
}

/* ------------------------------------------------------------------ */

/**
 * Legal's record that the co-owners agreed to the lease.
 *
 * Its own function rather than a flag on the document review, because they are
 * different questions. A reviewer who approved a legible Jamabandi has said
 * nothing whatsoever about whether four siblings consent, and recording it as
 * though they had is exactly how a lease gets signed that the others can have
 * set aside.
 */
export async function confirmCoOwnerConsent(
  tx: Transaction,
  params: {
    parcelId: string;
    reviewerUserId: string;
    note?: string;
    now: Date;
  },
): Promise<void> {
  const rows = await tx
    .select({
      id: landParcels.id,
      ownerUserId: landParcels.ownerUserId,
      coOwnerNames: landParcels.coOwnerNames,
    })
    .from(landParcels)
    .where(eq(landParcels.id, params.parcelId))
    .limit(1)
    .for("update");

  const parcel = rows[0];
  if (!parcel) {
    throw new Error(`Land parcel ${params.parcelId} not found.`);
  }

  /**
   * Confirming consent on solely held land is meaningless, and the likeliest
   * explanation is that the reviewer is on the wrong record.
   */
  if (!parcel.coOwnerNames || parcel.coOwnerNames.length === 0) {
    throw new Error(
      `Land parcel ${parcel.id} names no co-owners, so there is no co-owner consent to confirm.`,
    );
  }

  if (parcel.ownerUserId && parcel.ownerUserId === params.reviewerUserId) {
    throw new Error(
      `Reviewer ${params.reviewerUserId} cannot confirm the co-owner consent on their own parcel ${parcel.id}.`,
    );
  }

  const updated = await tx
    .update(landParcels)
    .set({
      coOwnerConsentConfirmed: true,
      coOwnerConsentBy: params.reviewerUserId,
      coOwnerConsentAt: params.now,
    })
    .where(eq(landParcels.id, parcel.id))
    .returning({ id: landParcels.id });

  /**
   * RLS returns nothing rather than raising, so an update with no matching
   * policy reports success having changed no rows. Migration 0007 added the
   * staff UPDATE policy this needs; the assertion is what makes its absence
   * loud rather than silent if it is ever dropped.
   */
  if (!updated[0]) {
    throw new Error(
      `Land parcel ${parcel.id} was not updated. The session's role has no UPDATE policy on land_parcels.`,
    );
  }

  await tx.insert(auditLog).values({
    actorUserId: params.reviewerUserId,
    actorType: "STAFF",
    action: "land_parcel.co_owner_consent",
    resourceType: "land_parcel",
    resourceId: parcel.id,
    changes: {
      /** Count, not names. A reason row is read by support. */
      coOwnerCount: parcel.coOwnerNames.length,
    },
    reasonCode: "CO_OWNER_CONSENT_CONFIRMED",
    note: params.note ?? null,
  });
}

/* ------------------------------------------------------------------ */

/**
 * Whether this person has any land a lease could be signed for.
 *
 * One verified parcel is enough. A second plot still under review does not
 * block the first: a lease names a khasra number, so there is never any
 * ambiguity about which land it covers.
 */
export async function landIsLeasable(
  db: Database,
  userId: string,
): Promise<boolean> {
  const rows = await withContext(db, { role: "system", userId }, (tx) =>
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(landParcels)
      .where(
        and(
          eq(landParcels.ownerUserId, userId),
          eq(landParcels.verificationStatus, "VERIFIED"),
        ),
      ),
  );

  return (rows[0]?.count ?? 0) > 0;
}
