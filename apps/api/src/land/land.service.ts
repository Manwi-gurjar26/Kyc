import { DEFAULT_KYC_THRESHOLDS } from "@kilowattx/core";
import { landParcels, withContext, type Database } from "@kilowattx/db";
import {
  confirmCoOwnerConsent,
  evaluateParcel,
} from "@kilowattx/kyc-pipeline";
import type { CoOwnerConsentInput, CoOwnersInput } from "@kilowattx/validation";
import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, ne } from "drizzle-orm";
import { ApiError } from "../common/errors.js";
import { KycService } from "../kyc/kyc.service.js";
import { DI } from "../config.js";

/**
 * Land parcels: the plots a lease can be signed for.
 *
 * Everything here exists because being verified is not the same as owning
 * something. A perfectly verified person can hand us the record for land they
 * share with four siblings, or land their neighbour registered with us last
 * month — and `can('ESIGN_LEASE')` has to say no in both cases.
 */

const QUEUE_LIMIT = 50;

@Injectable()
export class LandService {
  constructor(
    @Inject(DI.DATABASE) private readonly db: Database,
    @Inject(KycService) private readonly kyc: KycService,
    @Inject(DI.CLOCK) private readonly clock: () => Date,
  ) {}

  /* ---------------------------------------------------------------- */

  /** The caller's own parcels, with the verdict and why. */
  async listForUser(userId: string) {
    const rows = await withContext(this.db, { role: "customer", userId }, (tx) =>
      tx
        .select()
        .from(landParcels)
        .where(eq(landParcels.ownerUserId, userId))
        .orderBy(desc(landParcels.createdAt)),
    );

    return { parcels: rows.map(toParcelView) };
  }

  /* ---------------------------------------------------------------- */

  /**
   * The customer declaring who else holds the land.
   *
   * Asked rather than read off the document. OCR on a faded Jamabandi cannot
   * be trusted to find every name written in a margin, and a co-owner it
   * missed is the failure that matters — a lease the others can have set aside
   * after the panels are on the ground. The customer is asked, Legal confirms,
   * and two independent sources beat one unreliable one.
   */
  async declareCoOwners(
    userId: string,
    parcelId: string,
    input: CoOwnersInput,
  ) {
    const verifiedName = await this.kyc.displayNameFor(userId);

    const outcome = await withContext(
      this.db,
      { role: "system", userId },
      async (tx) => {
        const owned = await tx
          .select({ id: landParcels.id })
          .from(landParcels)
          .where(
            and(eq(landParcels.id, parcelId), eq(landParcels.ownerUserId, userId)),
          )
          .limit(1);

        /**
         * 404 rather than 403. A customer probing parcel ids should not be
         * able to tell "not yours" from "does not exist".
         */
        if (!owned[0]) throw ApiError.notFound("NOT_FOUND", "Not found.");

        await tx
          .update(landParcels)
          .set({ coOwnerNames: input.coOwnerNames })
          .where(eq(landParcels.id, parcelId));

        /**
         * Re-decided immediately. A declaration that changed the facts but
         * left the verdict stale would leave the customer looking at a
         * "verified" parcel that is no longer verifiable.
         */
        return evaluateParcel(tx, {
          parcelId,
          verifiedName: verifiedName ?? "",
          thresholds: DEFAULT_KYC_THRESHOLDS,
          now: this.clock(),
        });
      },
    );

    return {
      parcelId,
      verificationStatus: outcome.status,
      requiresAllCoOwners: outcome.requiresAllCoOwners,
      reasons: outcome.reasons,
    };
  }

  /* ---------------------------------------------------------------- */

  /** Parcels waiting on a human, newest first. */
  async reviewQueue() {
    const rows = await withContext(this.db, { role: "staff" }, (tx) =>
      tx
        .select()
        .from(landParcels)
        .where(
          and(
            ne(landParcels.verificationStatus, "VERIFIED"),
            ne(landParcels.verificationStatus, "REJECTED"),
          ),
        )
        .orderBy(desc(landParcels.createdAt))
        .limit(QUEUE_LIMIT),
    );

    return { parcels: rows.map(toParcelView) };
  }

  /* ---------------------------------------------------------------- */

  /**
   * Legal's record that the co-owners agreed.
   *
   * The verified name is read as the parcel owner's, not the reviewer's — the
   * decision compares the registry record against the person who owns the
   * land, and passing the reviewer's name here would make every co-owned
   * parcel fail its name check the moment consent was confirmed.
   */
  async confirmConsent(
    parcelId: string,
    reviewerUserId: string,
    input: CoOwnerConsentInput,
  ) {
    const ownerRows = await withContext(this.db, { role: "staff" }, (tx) =>
      tx
        .select({ ownerUserId: landParcels.ownerUserId })
        .from(landParcels)
        .where(eq(landParcels.id, parcelId))
        .limit(1),
    );

    if (!ownerRows[0]) throw ApiError.notFound("NOT_FOUND", "Not found.");

    const verifiedName = ownerRows[0].ownerUserId
      ? await this.kyc.displayNameFor(ownerRows[0].ownerUserId)
      : null;

    const outcome = await withContext(
      this.db,
      { role: "staff", userId: reviewerUserId },
      async (tx) => {
        await confirmCoOwnerConsent(tx, {
          parcelId,
          reviewerUserId,
          note: input.note,
          now: this.clock(),
        });

        return evaluateParcel(tx, {
          parcelId,
          verifiedName: verifiedName ?? "",
          thresholds: DEFAULT_KYC_THRESHOLDS,
          now: this.clock(),
        });
      },
    );

    return {
      parcelId,
      verificationStatus: outcome.status,
      reasons: outcome.reasons,
    };
  }
}

/* ------------------------------------------------------------------ */

/**
 * What a parcel looks like over the wire.
 *
 * The reasons go out verbatim, codes and all. A customer who can see
 * LAND_CO_OWNER_CONSENT_REQUIRED and read the sentence beside it knows what is
 * happening; "under review" with nothing attached is what generates the
 * support call.
 */
function toParcelView(row: typeof landParcels.$inferSelect) {
  return {
    id: row.id,
    khasraNumber: row.khasraNumber,
    village: row.village,
    district: row.district,
    areaAcres: row.areaAcres,
    ownerNameOnRecord: row.ownerNameOnRecord,
    ownerNameMatchScore: row.ownerNameMatchScore,
    coOwnerNames: row.coOwnerNames ?? [],
    coOwnerConsentConfirmed: row.coOwnerConsentConfirmed,
    verificationStatus: row.verificationStatus,
    documentsApproved: row.documentsApproved,
    reasons: row.decisionReasons ?? [],
    decidedAt: row.decidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
