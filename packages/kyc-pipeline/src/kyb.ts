import {
  decideKyc,
  type CompanyResult,
  type GstResult,
  type KycDecision,
  type KycStatus,
  type KycThresholds,
} from "@kilowattx/core";
import {
  applyKycDecision,
  kycChecks,
  kycRecords,
  orgMembers,
  organisations,
  type Transaction,
} from "@kilowattx/db";
import type { CinLookupResult, GstLookupResult } from "@kilowattx/integrations";
import { businessPanFromGstin, nameMatchScore } from "@kilowattx/validation";
import { and, eq } from "drizzle-orm";

/**
 * Know Your Business.
 *
 * A Commercial User is two questions, not one: is the business real and in
 * good standing, and is the person about to sign allowed to bind it. Both have
 * to pass before a PPA opens, and they are genuinely independent — a perfectly
 * sound company whose signatory has not finished their own KYC is not a
 * verified business.
 *
 * A KYB case is an ordinary `kyc_records` row with `level = KYB` and
 * `subject_type = ORGANISATION`, which is deliberate: the state machine, the
 * append-only checks, the audit log, the outbox and the review queue then all
 * work on it unchanged, rather than needing a parallel set of each.
 * `organisations.kyb_status` is a denormalised mirror, kept in step, because
 * that is what the PPA guard reads.
 */

/** Constitutions that have a company or LLP register to check. */
const REGISTERED_CONSTITUTIONS = /company|llp/i;

export interface StartKybResult {
  orgId: string;
  kycRecordId: string;
  /**
   * Whether a CIN or LLPIN lookup is still needed.
   *
   * Follows from the constitution the GST lookup returned, which itself comes
   * out of the business PAN embedded in the GSTIN. A proprietorship has no
   * company register, and demanding one would make every proprietor
   * unverifiable.
   */
  requiresCompanyRegister: boolean;
  gstStatus: GstResult["status"];
}

/**
 * Creates or refreshes the organisation from a GST lookup, and opens its KYB
 * case.
 *
 * Idempotent on the GSTIN. One organisation per GSTIN is not a nicety: two
 * would split the invoice history, and the GSTIN is the business's identity on
 * this platform.
 */
export async function startKyb(
  tx: Transaction,
  params: { lookup: GstLookupResult; now: Date },
): Promise<StartKybResult> {
  const { lookup, now } = params;

  const businessPan = businessPanFromGstin(lookup.gstin);

  const orgs = await tx
    .insert(organisations)
    .values({
      legalName: lookup.legalName,
      tradeName: lookup.tradeName,
      gstin: lookup.gstin,
      constitution: lookup.constitution,
      gstStatus: lookup.status,
      /** Same rule as a personal PAN: only the last four are kept. */
      businessPanLast4: businessPan.slice(-4),
      stateCode: lookup.stateCode,
      /**
       * The address is encrypted like any other personal data. Placeholder
       * until the real encryptor is wired through here too — the field is
       * marked rather than quietly storing plaintext under an encrypted name.
       */
      registeredAddressEncrypted: `UNENCRYPTED_PLACEHOLDER_DO_NOT_SHIP:${lookup.registeredAddress}`,
    })
    .onConflictDoUpdate({
      target: organisations.gstin,
      set: {
        legalName: lookup.legalName,
        tradeName: lookup.tradeName,
        constitution: lookup.constitution,
        gstStatus: lookup.status,
        stateCode: lookup.stateCode,
        updatedAt: now,
      },
    })
    .returning({ id: organisations.id });

  const orgId = orgs[0]!.id;

  /**
   * The KYB record uses the GSTIN as its vendor session id, which carries a
   * unique index — so re-running a lookup reuses the open case instead of
   * opening a second one against the same business.
   */
  const vendorSessionId = `kyb:${lookup.gstin}`;

  const records = await tx
    .insert(kycRecords)
    .values({
      subjectType: "ORGANISATION",
      orgId,
      level: "KYB",
      status: "IN_PROGRESS",
      vendor: "fake-kyb",
      vendorSessionId,
    })
    .onConflictDoNothing({ target: kycRecords.vendorSessionId })
    .returning({ id: kycRecords.id });

  const kycRecordId =
    records[0]?.id ??
    (
      await tx
        .select({ id: kycRecords.id })
        .from(kycRecords)
        .where(eq(kycRecords.vendorSessionId, vendorSessionId))
        .limit(1)
    )[0]?.id;

  if (!kycRecordId) {
    throw new Error("startKyb: could not resolve the KYB kyc_record id");
  }

  /**
   * Append-only, so a refreshed lookup leaves both rows. That history is the
   * point: a registration that was active last month and is cancelled today
   * is exactly what somebody will need to see.
   */
  await tx.insert(kycChecks).values({
    kycRecordId,
    checkType: "GST",
    status: lookup.status === "ACTIVE" ? "PASSED" : "FAILED",
    vendor: "fake-kyb",
    detail:
      `status=${lookup.status} constitution=${lookup.constitution} ` +
      `state=${lookup.stateCode} businessPan=****${businessPan.slice(-4)}`,
  });

  return {
    orgId,
    kycRecordId,
    requiresCompanyRegister: REGISTERED_CONSTITUTIONS.test(lookup.constitution),
    gstStatus: lookup.status,
  };
}

/**
 * Records a CIN or LLPIN lookup against the organisation.
 *
 * The MCA name is compared with the GST legal name here, because this is
 * where both are in hand. A disagreement means either the wrong CIN was
 * entered or the two registrations belong to different entities — and the B2B
 * invoice would then go out against the wrong one, stranding the customer's
 * input tax credit.
 */
export async function recordCompanyLookup(
  tx: Transaction,
  params: { orgId: string; lookup: CinLookupResult },
): Promise<{ nameMatchesGst: boolean }> {
  const { orgId, lookup } = params;

  const orgs = await tx
    .select({
      id: organisations.id,
      legalName: organisations.legalName,
      kycRecordId: kycRecords.id,
    })
    .from(organisations)
    .innerJoin(kycRecords, eq(kycRecords.orgId, organisations.id))
    .where(and(eq(organisations.id, orgId), eq(kycRecords.level, "KYB")))
    .limit(1);

  const org = orgs[0];
  if (!org) {
    throw new Error(`recordCompanyLookup: organisation ${orgId} not found`);
  }

  const score = nameMatchScore(lookup.companyName, org.legalName);
  const nameMatchesGst = score >= 0.75;

  await tx
    .update(organisations)
    .set({
      cinOrLlpin: lookup.cin,
      /**
       * Stored as data. The check row below keeps a human-readable detail for
       * the reviewer, but the decision reads these columns — an earlier
       * version recovered the status by regular expression from that detail,
       * which made a hard fail depend on wording.
       */
      companyStatus: lookup.status,
      companyNameMatchesGst: nameMatchesGst,
    })
    .where(eq(organisations.id, orgId));

  await tx.insert(kycChecks).values({
    kycRecordId: org.kycRecordId,
    checkType: "CIN",
    status: lookup.status === "ACTIVE" && nameMatchesGst ? "PASSED" : "FAILED",
    vendor: "fake-kyb",
    score: String(score),
    detail:
      `status=${lookup.status} nameMatchesGst=${nameMatchesGst} ` +
      `incorporated=${lookup.incorporatedOn} directors=${lookup.directors.length}`,
  });

  return { nameMatchesGst };
}

/**
 * Links the person who will sign.
 *
 * Linking is not approving. The authority document — a board resolution, an
 * authorisation letter, a partnership deed — is read by Legal, and
 * `authority_approved_at` stays null until they do. Nothing automates who may
 * bind a company to a 25-year agreement.
 */
export async function linkSignatory(
  tx: Transaction,
  params: {
    orgId: string;
    userId: string;
    authorityDocumentId?: string;
    now: Date;
  },
): Promise<void> {
  const values = {
    orgId: params.orgId,
    userId: params.userId,
    role: "SIGNATORY" as const,
    authorityDocumentId: params.authorityDocumentId,
  };

  /**
   * With no document to attach there is nothing to update, and Drizzle refuses
   * an empty `set` outright — so the no-document case is a plain do-nothing.
   * Linking the same person twice must be harmless either way.
   */
  if (params.authorityDocumentId === undefined) {
    await tx
      .insert(orgMembers)
      .values(values)
      .onConflictDoNothing({
        target: [orgMembers.orgId, orgMembers.userId, orgMembers.role],
      });
    return;
  }

  await tx
    .insert(orgMembers)
    .values(values)
    .onConflictDoUpdate({
      target: [orgMembers.orgId, orgMembers.userId, orgMembers.role],
      set: { authorityDocumentId: params.authorityDocumentId },
    });
}

export interface KybDecisionOutcome {
  orgId: string;
  kycRecordId: string;
  status: KycStatus;
  decision: KycDecision;
}

/**
 * Decides the KYB and writes it.
 *
 * Reads the state the earlier steps left behind rather than taking it from a
 * caller, so the decision cannot be made on figures that were never recorded.
 */
export async function applyKybDecision(
  tx: Transaction,
  params: { orgId: string; thresholds: KycThresholds; now: Date; traceId?: string },
): Promise<KybDecisionOutcome> {
  const { orgId, thresholds, now } = params;

  const rows = await tx
    .select({
      kycRecordId: kycRecords.id,
      legalName: organisations.legalName,
      gstStatus: organisations.gstStatus,
      constitution: organisations.constitution,
      cinOrLlpin: organisations.cinOrLlpin,
      companyStatus: organisations.companyStatus,
      companyNameMatchesGst: organisations.companyNameMatchesGst,
    })
    .from(organisations)
    .innerJoin(kycRecords, eq(kycRecords.orgId, organisations.id))
    .where(and(eq(organisations.id, orgId), eq(kycRecords.level, "KYB")))
    .limit(1);

  const org = rows[0];
  if (!org) {
    throw new Error(`applyKybDecision: KYB case for organisation ${orgId} not found`);
  }

  /**
   * The signatory's own KYC status, read from their personal record.
   *
   * No signatory at all is treated the same as an unverified one, because the
   * question "may this person bind the company" has the same answer either
   * way.
   */
  const signatories = await tx
    .select({ status: kycRecords.status })
    .from(orgMembers)
    .innerJoin(kycRecords, eq(kycRecords.userId, orgMembers.userId))
    .where(
      and(
        eq(orgMembers.orgId, orgId),
        eq(orgMembers.role, "SIGNATORY"),
        eq(kycRecords.level, "FULL"),
      ),
    )
    .limit(1);

  const signatoryKycStatus = (signatories[0]?.status as KycStatus) ?? "NOT_STARTED";

  /**
   * The company register is only consulted when the constitution says there
   * should be one. Reading the recorded CIN check rather than re-querying the
   * vendor keeps the decision reproducible from what was stored.
   */
  const needsRegister = REGISTERED_CONSTITUTIONS.test(org.constitution ?? "");

  /**
   * Read straight from the columns the lookup wrote. No parsing, so the
   * decision cannot drift when somebody rewords a reviewer's detail line.
   *
   * Left undefined when the constitution has no company register, which is
   * what tells decideKyc() not to require one.
   */
  const company: CompanyResult | undefined =
    needsRegister && org.companyStatus
      ? {
          status: org.companyStatus as CompanyResult["status"],
          nameMatchesGst: org.companyNameMatchesGst ?? false,
        }
      : undefined;

  const decision = decideKyc(
    {
      level: "KYB",
      now,
      gst: { status: (org.gstStatus as GstResult["status"]) ?? "UNKNOWN" },
      company,
      signatoryKycStatus,
      duplicatePan: false,
    },
    thresholds,
  );

  const status = await applyKycDecision(tx, {
    kycRecordId: org.kycRecordId,
    decision,
    thresholds,
    now,
    vendor: "fake-kyb",
    checks: [],
    actorType: "SYSTEM",
    traceId: params.traceId,
  });

  /**
   * The mirror the PPA guard reads. It has to move with the record, or the
   * gate stays shut on a business that is verified.
   */
  await tx
    .update(organisations)
    .set({ kybStatus: status, updatedAt: now })
    .where(eq(organisations.id, orgId));

  return { orgId, kycRecordId: org.kycRecordId, status, decision };
}
