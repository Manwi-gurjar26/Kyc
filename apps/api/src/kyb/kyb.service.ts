import type { KycStatus, KycThresholds } from "@kilowattx/core";
import {
  kycRecords,
  orgMembers,
  organisations,
  withContext,
  type Database,
} from "@kilowattx/db";
import {
  VendorRequestError,
  type KybProvider,
} from "@kilowattx/integrations";
import {
  applyKybDecision,
  linkSignatory,
  recordCompanyLookup,
  startKyb,
} from "@kilowattx/kyc-pipeline";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DI, type AppConfig } from "../config.js";
import { ApiError } from "../common/errors.js";
import { KycService, type Clock } from "../kyc/kyc.service.js";

/**
 * Know Your Business, over HTTP.
 *
 * Four steps, in the order the guide sets out: the GSTIN tells us who the
 * business is and what else is needed; the company register confirms it still
 * exists; the signatory proves they are themselves; then the decision.
 *
 * The orchestration lives here, the rules do not. What a business must satisfy
 * is decided by `decideKyc()`, and how it is written is
 * `@kilowattx/kyc-pipeline` — the same functions the worker would call.
 */

export interface OrganisationView {
  id: string;
  gstin: string;
  legalName: string;
  tradeName: string | null;
  constitution: string | null;
  gstStatus: string;
  stateCode: string | null;
  /** Masked, like every other identifier we hold. */
  businessPanLast4: string | null;
  cinOrLlpin: string | null;
  companyStatus: string | null;
  kybStatus: KycStatus;
  /** Whether a CIN or LLPIN is still needed, from the constitution. */
  requiresCompanyRegister: boolean;
  /** What the caller still has to do before submitting. */
  remainingSteps: string[];
  signatory: {
    userId: string;
    isCaller: boolean;
    personalKycStatus: KycStatus;
    hasAuthorityDocument: boolean;
    authorityApproved: boolean;
  } | null;
}

/** Constitutions with a company or LLP register. Mirrors the pipeline's rule. */
const REGISTERED_CONSTITUTIONS = /company|llp/i;

@Injectable()
export class KybService {
  private readonly logger = new Logger(KybService.name);

  constructor(
    @Inject(DI.CONFIG) private readonly config: AppConfig,
    @Inject(DI.DATABASE) private readonly db: Database,
    @Inject(DI.KYB_PROVIDER) private readonly provider: KybProvider,
    @Inject(DI.CLOCK) private readonly clock: Clock,
    @Inject(KycService) private readonly kyc: KycService,
  ) {}

  /* ---------------------------------------------------------------- */

  /**
   * Looks up a GSTIN and opens the business check.
   *
   * Idempotent on the GSTIN: calling it again refreshes the lookup and reuses
   * the open case, because one organisation per GSTIN is what keeps the
   * invoice history in one place.
   */
  async createFromGstin(
    userId: string,
    gstin: string,
  ): Promise<OrganisationView> {
    /**
     * Consent first, as for personal KYC. A business check reads a public
     * register, but it also attaches the caller to the business and pulls
     * their own PAN and selfie in behind it.
     */
    await this.assertConsent(userId, "KYB_VERIFICATION");

    let lookup;
    try {
      lookup = await this.provider.lookupGstin(gstin);
    } catch (error) {
      if (error instanceof VendorRequestError) {
        throw ApiError.badRequest("GSTIN_NOT_FOUND", error.message);
      }
      throw error;
    }

    const started = await withContext(this.db, { role: "system" }, (tx) =>
      startKyb(tx, { lookup, now: this.clock() }),
    );

    /**
     * Not refused here, deliberately. A cancelled GSTIN is a hard fail at
     * decision time, and the customer is better served seeing the registry's
     * own answer on screen than a bare error — "your GST registration shows as
     * cancelled" is actionable, "GSTIN_NOT_FOUND" is not.
     */
    if (lookup.status !== "ACTIVE") {
      this.logger.warn(
        `GSTIN ${gstin} is ${lookup.status}; the KYB will be rejected on submission`,
      );
    }

    return this.view(started.orgId, userId);
  }

  /* ---------------------------------------------------------------- */

  async recordCompanyRegister(
    userId: string,
    orgId: string,
    identifier: { cin?: string; llpin?: string },
  ): Promise<OrganisationView> {
    const org = await this.loadOrganisation(orgId);

    if (!REGISTERED_CONSTITUTIONS.test(org.constitution ?? "")) {
      throw ApiError.badRequest(
        "COMPANY_REGISTER_NOT_APPLICABLE",
        `A ${org.constitution ?? "business"} has no company register. Nothing more is needed here.`,
      );
    }

    /**
     * An LLPIN is accepted and stored, but there is no MCA LLP lookup behind
     * it yet. Recording it without a lookup and then deciding as though it had
     * been checked would be worse than refusing, so it is refused and says so.
     */
    if (identifier.llpin) {
      throw ApiError.badRequest(
        "LLP_LOOKUP_NOT_IMPLEMENTED",
        "LLP registration lookups are not available yet. A colleague will verify this by hand.",
      );
    }

    let lookup;
    try {
      lookup = await this.provider.lookupCin(identifier.cin!);
    } catch (error) {
      if (error instanceof VendorRequestError) {
        throw ApiError.badRequest("CIN_NOT_FOUND", error.message);
      }
      throw error;
    }

    await withContext(this.db, { role: "system" }, (tx) =>
      recordCompanyLookup(tx, { orgId, lookup }),
    );

    return this.view(orgId, userId);
  }

  /* ---------------------------------------------------------------- */

  /**
   * Declares the caller as the person who will sign.
   *
   * Always the caller, never a nominee. Nominating somebody else would be
   * asserting authority over a person who has not consented, and the whole
   * point of this step is that the signatory proves their own identity.
   */
  async declareSignatory(
    userId: string,
    orgId: string,
    authorityDocumentId?: string,
  ): Promise<OrganisationView> {
    await this.loadOrganisation(orgId);

    await withContext(this.db, { role: "system" }, (tx) =>
      linkSignatory(tx, {
        orgId,
        userId,
        authorityDocumentId,
        now: this.clock(),
      }),
    );

    return this.view(orgId, userId);
  }

  /* ---------------------------------------------------------------- */

  /**
   * Submits the business check for a decision.
   *
   * Refuses when a step is still outstanding rather than deciding on partial
   * evidence — a KYB rejected for a missing CIN that nobody was asked for is a
   * support call, not a decision.
   */
  async submit(userId: string, orgId: string): Promise<OrganisationView> {
    const view = await this.view(orgId, userId);

    if (view.remainingSteps.length > 0) {
      throw ApiError.badRequest(
        "KYB_INCOMPLETE",
        `Still to do: ${view.remainingSteps.join(", ")}.`,
        { remainingSteps: view.remainingSteps },
      );
    }

    const thresholds: KycThresholds = await this.kyc.thresholds();

    try {
      await withContext(this.db, { role: "system" }, (tx) =>
        applyKybDecision(tx, { orgId, thresholds, now: this.clock() }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Illegal KYC transition/.test(message)) {
        throw ApiError.conflict(
          "KYB_ALREADY_DECIDED",
          "This business check has already been decided.",
        );
      }
      throw error;
    }

    return this.view(orgId, userId);
  }

  /* ---------------------------------------------------------------- */

  async view(orgId: string, callerUserId: string): Promise<OrganisationView> {
    const org = await this.loadOrganisation(orgId);

    const signatories = await withContext(this.db, { role: "system" }, (tx) =>
      tx
        .select({
          userId: orgMembers.userId,
          authorityDocumentId: orgMembers.authorityDocumentId,
          authorityApprovedAt: orgMembers.authorityApprovedAt,
          personalStatus: kycRecords.status,
        })
        .from(orgMembers)
        .leftJoin(
          kycRecords,
          and(
            eq(kycRecords.userId, orgMembers.userId),
            eq(kycRecords.level, "FULL"),
          ),
        )
        .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.role, "SIGNATORY")))
        .limit(1),
    );

    const signatory = signatories[0];
    const requiresCompanyRegister = REGISTERED_CONSTITUTIONS.test(
      org.constitution ?? "",
    );

    const remainingSteps: string[] = [];
    if (requiresCompanyRegister && !org.cinOrLlpin) {
      remainingSteps.push("COMPANY_REGISTER");
    }
    if (!signatory) {
      remainingSteps.push("SIGNATORY");
    } else if (signatory.personalStatus !== "VERIFIED") {
      /**
       * Listed as outstanding rather than blocking: the signatory can be
       * declared before finishing their own KYC, and the UI needs to tell
       * them which of the two is holding things up.
       */
      remainingSteps.push("SIGNATORY_PERSONAL_KYC");
    }

    return {
      id: org.id,
      gstin: org.gstin,
      legalName: org.legalName,
      tradeName: org.tradeName,
      constitution: org.constitution,
      gstStatus: org.gstStatus,
      stateCode: org.stateCode,
      businessPanLast4: org.businessPanLast4,
      cinOrLlpin: org.cinOrLlpin,
      companyStatus: org.companyStatus,
      kybStatus: org.kybStatus as KycStatus,
      requiresCompanyRegister,
      remainingSteps,
      signatory: signatory
        ? {
            userId: signatory.userId,
            isCaller: signatory.userId === callerUserId,
            personalKycStatus: (signatory.personalStatus as KycStatus) ?? "NOT_STARTED",
            hasAuthorityDocument: Boolean(signatory.authorityDocumentId),
            authorityApproved: Boolean(signatory.authorityApprovedAt),
          }
        : null,
    };
  }

  /* ---------------------------------------------------------------- */

  private async loadOrganisation(orgId: string) {
    const rows = await withContext(this.db, { role: "system" }, (tx) =>
      tx.select().from(organisations).where(eq(organisations.id, orgId)).limit(1),
    );

    const org = rows[0];
    if (!org) {
      throw ApiError.notFound("ORGANISATION_NOT_FOUND", "No such business.");
    }
    return org;
  }

  /**
   * Checks there is a live consent for the purpose.
   *
   * Reuses the KYC service's own lookup so there is one definition of "has
   * this person consented", rather than a second query that could drift from
   * it.
   */
  private async assertConsent(userId: string, purpose: string): Promise<void> {
    const hasConsent = await this.kyc.hasLiveConsent(userId, purpose);
    if (!hasConsent) {
      throw ApiError.badRequest(
        "CONSENT_REQUIRED",
        "We need your permission before we can verify your business.",
      );
    }
  }
}
