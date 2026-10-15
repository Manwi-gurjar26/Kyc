import {
  can,
  type KycAction,
  type KycStatus,
  type KycThresholds,
  type SubjectKycState,
} from "@kilowattx/core";
import {
  consentRecords,
  aadhaarOtpChallenges,
  kycRecords,
  orgMembers,
  organisations,
  settings,
  users,
  withContext,
  type Database,
} from "@kilowattx/db";
import {
  ReplayGuard,
  verifyWebhook,
  type KycProvider,
  type VendorKycResult,
  VendorRequestError,
} from "@kilowattx/integrations";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import type { ConsentInput, CreateKycSessionInput } from "@kilowattx/validation";
import {
  applyVendorResult,
  landIsLeasable,
  loadThresholdsLogging,
  type PanEncryptor,
} from "@kilowattx/kyc-pipeline";
import { DI, type AppConfig } from "../config.js";
import { ApiError } from "../common/errors.js";

/**
 * KYC orchestration.
 *
 * This service moves data between the vendor, the database and
 * packages/core. It contains no rules of its own: whether someone is verified
 * is decided by `decideKyc()`, and whether they may do something is decided by
 * `can()`. If a business rule appears in this file, it is in the wrong place —
 * the API and the worker both have to agree on it, and only core is shared by
 * both.
 */

export type Clock = () => Date;

export interface KycStatusView {
  status: KycStatus;
  level: string | null;
  /** Masked. The API never returns a full PAN or Aadhaar number. */
  aadhaarLast4: string | null;
  panLast4: string | null;
  /** Reason codes only; the detail text quotes names and scores. */
  reasonCodes: string[];
  remainingSteps: string[];
  verifiedAt: Date | null;
}

/**
 * A business this person is a signatory of.
 *
 * `authorityApproved` is the board resolution Legal reads by hand, not
 * anything the person did themselves — being verified and being allowed to
 * bind the company are different facts.
 */
export interface SignatoryOrg {
  orgId: string;
  legalName: string | null;
  kybStatus: KycStatus;
  authorityApproved: boolean;
}

/**
 * How long a challenge stays usable.
 *
 * Their OTP expires on the gateway side in about ten minutes; ours expiring
 * at the same time means a stale reference cannot be replayed afterwards.
 */
const OTP_CHALLENGE_MINUTES = 10;

/** UIDAI allows a few tries. A million-value secret gets no more than that. */
const MAX_OTP_ATTEMPTS = 3;

@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);

  constructor(
    @Inject(DI.CONFIG) private readonly config: AppConfig,
    @Inject(DI.DATABASE) private readonly db: Database,
    @Inject(DI.KYC_PROVIDER) private readonly provider: KycProvider,
    @Inject(DI.REPLAY_GUARD) private readonly replayGuard: ReplayGuard,
    @Inject(DI.CLOCK) private readonly clock: Clock,
    @Inject(DI.PAN_ENCRYPTOR) private readonly panEncryptor: PanEncryptor,
  ) {}

  /* ---------------------------------------------------------------- */
  /* Thresholds                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Reads thresholds from the settings table, falling back to the defaults.
   *
   * Read per decision rather than cached at boot, because the point of
   * keeping them in the database is that Ops can retune them without a
   * release — and a cache would mean the retune takes effect whenever the
   * tasks next restart, which is not a behaviour anyone can reason about.
   */
  async thresholds(): Promise<KycThresholds> {
    /**
     * Delegated to packages/kyc-pipeline so the worker uses the same loader.
     *
     * This used to be a private copy here, which meant a case healed by
     * reconciliation was decided against the compiled defaults while the same
     * case decided on a webhook used the table. Retuning the face-match bar
     * changed one path and not the other.
     *
     * The shared loader also refuses a value that would disable a check — a
     * face-match threshold of 0 passes every face — and logs what it refused,
     * which the copy here did not: it read 0 as 0 and carried on.
     */
    return loadThresholdsLogging(this.db, (line) => this.logger.error(line));
  }

  /* ---------------------------------------------------------------- */
  /* Consent                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Records consent before any verification starts.
   *
   * Nothing may be sent to a vendor without a row here first. The row carries
   * the notice version actually rendered, because "they agreed" is unprovable
   * without knowing what they were shown.
   */
  async recordConsent(userId: string, input: ConsentInput): Promise<{ id: string }> {
    const rows = await withContext(this.db, { role: "customer", userId }, (tx) =>
      tx
        .insert(consentRecords)
        .values({
          userId,
          purpose: input.purpose,
          noticeVersion: input.noticeVersion,
          locale: input.locale,
        })
        .returning({ id: consentRecords.id }),
    );
    return { id: rows[0]!.id };
  }

  /**
   * The verified display name, for anything that has to compare a name
   * against the person we verified.
   *
   * The Aadhaar name is deliberately not stored — only the last four digits
   * and a vendor token — so this stands in for it until the vendor's returned
   * name is held for exactly this comparison.
   */
  async displayNameFor(userId: string): Promise<string | null> {
    const rows = await withContext(this.db, { role: "system" }, (tx) =>
      tx
        .select({ displayName: users.displayName })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1),
    );
    return rows[0]?.displayName ?? null;
  }

  /**
   * The purposes this person currently consents to.
   *
   * Exposed so a client can tell whether it needs to show a consent screen,
   * rather than discovering it from a failed request. The alternative — firing
   * a throwaway call and reading the error code — is both a side effect and a
   * lie, since validation runs before the consent check and would reject the
   * probe first.
   */
  async liveConsents(userId: string): Promise<string[]> {
    const rows = await withContext(this.db, { role: "customer", userId }, (tx) =>
      tx
        .select({ purpose: consentRecords.purpose })
        .from(consentRecords)
        .where(
          and(
            eq(consentRecords.userId, userId),
            isNull(consentRecords.withdrawnAt),
          ),
        ),
    );
    return [...new Set(rows.map((r) => r.purpose))];
  }

  /**
   * Whether a live, unwithdrawn consent exists for a purpose.
   *
   * Shared with the KYB service rather than duplicated there, so there is one
   * definition of "has this person consented" — a second query would drift,
   * and the drift would be in the direction of collecting data nobody agreed
   * to.
   */
  async hasLiveConsent(userId: string, purpose: string): Promise<boolean> {
    const rows = await withContext(this.db, { role: "customer", userId }, (tx) =>
      tx
        .select({ id: consentRecords.id })
        .from(consentRecords)
        .where(
          and(
            eq(consentRecords.userId, userId),
            eq(
              consentRecords.purpose,
              purpose as (typeof consentRecords.purpose.enumValues)[number],
            ),
            isNull(consentRecords.withdrawnAt),
          ),
        )
        .limit(1),
    );
    return rows.length > 0;
  }

  /* ---------------------------------------------------------------- */
  /* Sessions                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Opens a vendor session and returns a short-lived client token.
   *
   * The vendor API key never leaves this process. The browser gets a token
   * scoped to one session that expires in minutes, so a leaked one is worth
   * almost nothing.
   */
  async createSession(
    userId: string,
    input: CreateKycSessionInput,
    idempotencyKey: string,
  ): Promise<{
    kycRecordId: string;
    vendorSessionId: string;
    clientToken: string;
    expiresAt: Date;
    hostedUrl?: string;
  }> {
    /**
     * Inside withContext, like every other query that touches an RLS table.
     *
     * Run against the bare connection this returns zero rows — not an error,
     * just nothing, because with no `app.role` set the policy matches nothing.
     * Zero rows then reads as "no consent given" and the user is told to
     * consent again to something they already consented to.
     *
     * Which is RLS behaving exactly as intended: a query that forgets its
     * context is denied rather than served. It is also why the failure mode to
     * watch for is an empty result, not an exception.
     */
    const consent = await withContext(this.db, { role: "customer", userId }, (tx) =>
      tx
        .select({ id: consentRecords.id })
        .from(consentRecords)
        .where(
          and(
            eq(consentRecords.id, input.consentId),
            eq(consentRecords.userId, userId),
            isNull(consentRecords.withdrawnAt),
          ),
        )
        .limit(1),
    );

    if (consent.length === 0) {
      throw ApiError.badRequest(
        "CONSENT_REQUIRED",
        "We need your permission before we can verify your details.",
      );
    }

    const session = await this.provider.createSession({
      subjectId: userId,
      level: input.level,
      role: input.role,
      locale: input.locale,
      redirectUrl: this.config.KYC_REDIRECT_URL,
      idempotencyKey,
      /**
       * Dropped in production. A client that could name its own scenario
       * could name "pass", and the field would be an authentication bypass
       * wearing a test-helper's clothes.
       */
      ...(this.config.NODE_ENV === "production"
        ? {}
        : { testScenario: input.testScenario }),
    });

    /**
     * The record is created with the vendor session id, which carries a unique
     * index. Together with the provider's own idempotency that makes a
     * double-clicked button harmless.
     */
    const rows = await withContext(this.db, { role: "system" }, (tx) =>
      tx
        .insert(kycRecords)
        .values({
          subjectType: input.subjectType,
          userId,
          level: input.level,
          status: "IN_PROGRESS",
          vendor: this.provider.name,
          vendorSessionId: session.vendorSessionId,
          consentId: input.consentId,
        })
        .onConflictDoNothing({ target: kycRecords.vendorSessionId })
        .returning({ id: kycRecords.id }),
    );

    /**
     * On the idempotent path the insert conflicts and returns nothing, so the
     * existing record is looked up instead — inside withContext, for the same
     * reason the consent lookup is.
     */
    const kycRecordId =
      rows[0]?.id ??
      (
        await withContext(this.db, { role: "system" }, (tx) =>
          tx
            .select({ id: kycRecords.id })
            .from(kycRecords)
            .where(eq(kycRecords.vendorSessionId, session.vendorSessionId))
            .limit(1),
        )
      )[0]?.id;

    if (!kycRecordId) {
      throw new Error("createSession: could not resolve the kyc_record id");
    }

    return {
      kycRecordId,
      vendorSessionId: session.vendorSessionId,
      clientToken: session.clientToken,
      expiresAt: session.expiresAt,
      hostedUrl: session.hostedUrl,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Status                                                          */
  /* ---------------------------------------------------------------- */

  /** The customer's own view. Masked values only. */
  /* ---------------------------------------------------------------- */
  /* Aadhaar OTP                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Asks the gateway to send an OTP to the mobile registered with UIDAI.
   *
   * Consent is checked first and is not a formality: this is the call that
   * sends a person's Aadhaar number to a third party, so there has to be a
   * row saying they agreed and which notice they were shown, written before
   * the number goes anywhere.
   *
   * The number itself is never logged, never returned, and never stored. What
   * comes back is a reference id and a masked mobile.
   */
  async startAadhaarOtp(
    userId: string,
    aadhaarNumber: string,
  ): Promise<{ sentTo: string }> {
    if (!(await this.hasLiveConsent(userId, "KYC_VERIFICATION"))) {
      throw ApiError.forbidden(
        "CONSENT_REQUIRED",
        "We need your agreement before sending your Aadhaar to the verification gateway.",
      );
    }

    let challenge;
    try {
      challenge = await this.provider.sendAadhaarOtp(aadhaarNumber);
    } catch (error) {
      throw this.vendorFailure(error, "We could not send the OTP just now.");
    }

    /**
     * The last four digits are written down here, not after verification.
     *
     * They have to be: a real gateway's verify response carries the name, the
     * date of birth and a photo, and no Aadhaar number at all. The number is
     * only in hand at this step. Holding it in process memory between the two
     * calls would break the moment there were two API containers — and would
     * keep Aadhaar numbers in memory for the life of every challenge.
     *
     * Four digits recorded against an attempt claim nothing. The record stays
     * IN_PROGRESS and the gateway's token — the thing that says a check
     * actually passed — is only written once the OTP is confirmed.
     */
    await this.rememberAadhaar(userId, { last4: challenge.last4 });

    /**
     * The challenge is kept here, against the person it belongs to.
     *
     * It used to be handed back to the browser and sent up again with the
     * OTP, which meant the client chose which challenge to verify against.
     * Now the reference never leaves this process: the confirmation is asked
     * only for the six digits, and the server already knows what they are for.
     *
     * One row per person, replaced on each request — the gateway invalidates
     * the previous challenge anyway, so two live ones is not a state worth
     * being able to represent.
     */
    await withContext(this.db, { role: "system" }, (tx) =>
      tx
        .insert(aadhaarOtpChallenges)
        .values({
          userId,
          referenceId: challenge.referenceId,
          last4: challenge.last4,
          attempts: 0,
          createdAt: this.clock(),
          expiresAt: new Date(this.clock().getTime() + OTP_CHALLENGE_MINUTES * 60_000),
        })
        .onConflictDoUpdate({
          target: aadhaarOtpChallenges.userId,
          set: {
            referenceId: challenge.referenceId,
            last4: challenge.last4,
            attempts: 0,
            createdAt: this.clock(),
            expiresAt: new Date(this.clock().getTime() + OTP_CHALLENGE_MINUTES * 60_000),
          },
        }),
    );

    /** The reference is deliberately NOT returned. See above. */
    return { sentTo: challenge.sentTo };
  }

  /**
   * Submits the OTP and records what the gateway returned.
   *
   * Only two things are persisted — the last four digits, written when the
   * OTP was requested, and the gateway's reference token, written here —
   * because they are the only two we are permitted to keep.
   *
   * The record moves to IN_PROGRESS rather than VERIFIED: Aadhaar is one check
   * of several, and `decideKyc()` is the only thing that sets a status.
   */
  async confirmAadhaarOtp(
    userId: string,
    otp: string,
  ): Promise<{ last4: string; nameOnRecord?: string }> {
    const challenge = await this.claimChallenge(userId);

    let result;
    try {
      result = await this.provider.verifyAadhaarOtp(challenge.referenceId, otp);
    } catch (error) {
      throw this.vendorFailure(error, "We could not check that OTP just now.");
    }

    /**
     * A gateway that answers but reports the record as not valid is a failed
     * check, not a passed one. Treating a non-SUCCESS status as success is the
     * single worst bug available here, so it is refused explicitly rather than
     * left to fall through into a stored reference token.
     */
    if (result.status !== "SUCCESS") {
      throw ApiError.badRequest(
        "AADHAAR_CHECK_FAILED",
        "That Aadhaar could not be confirmed. Please check the number and try again.",
      );
    }

    const stored = await this.rememberAadhaar(userId, {
      refToken: result.refToken,
    });

    /**
     * Spent, so it is removed. A challenge that stays usable after it has
     * succeeded is a replayable one.
     */
    await this.dropChallenge(userId);

    return { last4: stored.last4 ?? challenge.last4, nameOnRecord: result.nameOnRecord };
  }

  /**
   * Reads the live challenge and counts the attempt, in one transaction.
   *
   * The increment happens BEFORE the gateway is called, not after, and that
   * ordering is the whole protection: a wrong OTP that threw on the way out
   * would otherwise never be counted, and the limit would be unenforceable by
   * simply failing repeatedly.
   *
   * A six-digit OTP is a million guesses. The gateway limits attempts on its
   * side; this is the half we control.
   */
  private async claimChallenge(
    userId: string,
  ): Promise<{ referenceId: string; last4: string }> {
    /**
     * The transaction decides; it does not throw.
     *
     * Deleting the spent challenge and then throwing inside one transaction
     * rolls the delete back with it — the row survives, and the next attempt
     * is refused by the same stale counter forever. So the outcome is
     * returned, and the caller acts on it afterwards, outside the
     * transaction that read it.
     */
    const outcome = await withContext(this.db, { role: "system" }, async (tx) => {
      const rows = await tx
        .select()
        .from(aadhaarOtpChallenges)
        .where(eq(aadhaarOtpChallenges.userId, userId))
        .limit(1);

      const challenge = rows[0];
      if (!challenge) return { kind: "none" } as const;

      if (challenge.expiresAt.getTime() <= this.clock().getTime()) {
        return { kind: "expired" } as const;
      }

      if (challenge.attempts >= MAX_OTP_ATTEMPTS) {
        return { kind: "exhausted" } as const;
      }

      /**
       * Counted before the gateway is called, not after. A wrong OTP that
       * threw on the way out would otherwise never be counted, and the limit
       * would be unenforceable by simply failing repeatedly.
       */
      await tx
        .update(aadhaarOtpChallenges)
        .set({ attempts: challenge.attempts + 1 })
        .where(eq(aadhaarOtpChallenges.userId, userId));

      return {
        kind: "ok",
        referenceId: challenge.referenceId,
        last4: challenge.last4,
      } as const;
    });

    if (outcome.kind === "ok") {
      return { referenceId: outcome.referenceId, last4: outcome.last4 };
    }

    if (outcome.kind === "none") {
      throw ApiError.badRequest(
        "NO_OTP_REQUESTED",
        "There is no verification in progress. Please request a new OTP.",
      );
    }

    /** Dead either way, so it goes — in its own transaction, which commits. */
    await this.dropChallenge(userId);

    throw outcome.kind === "expired"
      ? ApiError.badRequest("OTP_EXPIRED", "That OTP has expired. Please request a new one.")
      : ApiError.badRequest(
          "TOO_MANY_ATTEMPTS",
          "Too many incorrect attempts. Please request a new OTP.",
        );
  }

  /** Removes a challenge, in a transaction of its own so it commits. */
  private async dropChallenge(userId: string): Promise<void> {
    await withContext(this.db, { role: "system" }, (tx) =>
      tx.delete(aadhaarOtpChallenges).where(eq(aadhaarOtpChallenges.userId, userId)),
    );
  }

  /**
   * Writes whichever Aadhaar fields are known, and returns the row as it
   * stands.
   *
   * One upsert for both steps, because the two differ only in which column
   * they have to offer. Fields that are absent are left alone rather than
   * overwritten with undefined — the second call must not erase what the
   * first one recorded.
   */
  private async rememberAadhaar(
    userId: string,
    fields: { last4?: string; refToken?: string },
  ): Promise<{ last4: string | null }> {
    const now = this.clock();

    return withContext(this.db, { role: "system" }, async (tx) => {
      const existing = await tx
        .select({ id: kycRecords.id, aadhaarLast4: kycRecords.aadhaarLast4 })
        .from(kycRecords)
        .where(eq(kycRecords.userId, userId))
        .limit(1);

      if (existing[0]) {
        await tx
          .update(kycRecords)
          .set({
            ...(fields.last4 ? { aadhaarLast4: fields.last4 } : {}),
            ...(fields.refToken ? { aadhaarRefToken: fields.refToken } : {}),
            status: "IN_PROGRESS",
            updatedAt: now,
          })
          .where(eq(kycRecords.id, existing[0].id));

        return { last4: fields.last4 ?? existing[0].aadhaarLast4 };
      }

      await tx.insert(kycRecords).values({
        userId,
        subjectType: "PERSON",
        level: "FULL",
        status: "IN_PROGRESS",
        ...(fields.last4 ? { aadhaarLast4: fields.last4 } : {}),
        ...(fields.refToken ? { aadhaarRefToken: fields.refToken } : {}),
        createdAt: now,
        updatedAt: now,
      });

      return { last4: fields.last4 ?? null };
    });
  }

  /**
   * Turns a vendor exception into something a customer can read.
   *
   * A VendorRequestError is the gateway saying "your input was wrong" — a
   * wrong OTP, an expired challenge — and its message is written for the
   * person. Anything else is our problem, not theirs, so it is logged in full
   * and answered generically rather than leaking a vendor payload.
   */
  private vendorFailure(error: unknown, fallback: string): ApiError {
    if (error instanceof VendorRequestError) {
      return ApiError.badRequest("AADHAAR_CHECK_FAILED", error.message);
    }
    this.logger.error(
      "Aadhaar gateway call failed",
      error instanceof Error ? error.stack : String(error),
    );
    return ApiError.badRequest("AADHAAR_UNAVAILABLE", `${fallback} Please try again shortly.`);
  }

  async statusFor(userId: string): Promise<KycStatusView> {
    const rows = await withContext(this.db, { role: "customer", userId }, (tx) =>
      tx
        .select()
        .from(kycRecords)
        .where(eq(kycRecords.userId, userId))
        .orderBy(kycRecords.createdAt)
        .limit(1),
    );

    const record = rows[0];
    if (!record) {
      return {
        status: "NOT_STARTED",
        level: null,
        aadhaarLast4: null,
        panLast4: null,
        reasonCodes: [],
        remainingSteps: ["CONSENT", "AADHAAR", "PAN", "SELFIE"],
        verifiedAt: null,
      };
    }

    return {
      status: record.status as KycStatus,
      level: record.level,
      aadhaarLast4: record.aadhaarLast4,
      panLast4: record.panLast4,
      reasonCodes: (record.decisionReasons ?? []).map((r) => r.code),
      remainingSteps: this.remainingSteps(record),
      verifiedAt: record.verifiedAt,
    };
  }

  private remainingSteps(record: {
    aadhaarLast4: string | null;
    panLast4: string | null;
    livenessPassed: boolean | null;
    status: string;
  }): string[] {
    if (record.status === "VERIFIED") return [];
    const steps: string[] = [];
    if (!record.aadhaarLast4) steps.push("AADHAAR");
    if (!record.panLast4) steps.push("PAN");
    if (record.livenessPassed !== true) steps.push("SELFIE");
    return steps;
  }

  /* ---------------------------------------------------------------- */
  /* Guards                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Which business to answer for, or none.
   *
   * Named explicitly when the caller knows; otherwise inferred only when
   * there is exactly one, which is unambiguous and the common case. With
   * several and no name given this returns null rather than choosing: picking
   * the verified one would answer yes about a company nobody asked about, and
   * it is a 25-year agreement.
   */
  private async signatoryFor(
    userId: string,
    orgId?: string,
  ): Promise<SignatoryOrg | null> {
    const orgs = await this.signatoryOrgs(userId);

    if (orgId) return orgs.find((org) => org.orgId === orgId) ?? null;
    return orgs.length === 1 ? orgs[0]! : null;
  }

  /* ---------------------------------------------------------------- */

  /**
   * Whether a user may take an action, by asking core.
   *
   * This is the real block. The UI hiding a button is a courtesy; without
   * this, anyone could call the endpoint directly and sign a 25-year lease.
   */
  async assertCan(
    userId: string,
    action: KycAction,
    options: { orgId?: string } = {},
  ): Promise<void> {
    const state = await this.subjectState(userId, options);
    const result = can(action, state);

    if (!result.allowed) {
      throw ApiError.forbidden(
        result.code ?? "FORBIDDEN",
        result.message ?? "This action is not available yet.",
      );
    }
  }

  /**
   * The businesses this person may sign for, with each one's KYB status and
   * whether their authority to bind it has been approved.
   *
   * A list, because somebody can be a signatory of more than one company —
   * and "can you sign a PPA?" is then an under-specified question. Returning
   * them all rather than picking one keeps the guessing out of here.
   */
  async signatoryOrgs(userId: string): Promise<SignatoryOrg[]> {
    const rows = await withContext(this.db, { role: "system" }, (tx) =>
      tx
        .select({
          orgId: organisations.id,
          legalName: organisations.legalName,
          kybStatus: organisations.kybStatus,
          authorityApprovedAt: orgMembers.authorityApprovedAt,
        })
        .from(orgMembers)
        .innerJoin(organisations, eq(orgMembers.orgId, organisations.id))
        .where(
          and(eq(orgMembers.userId, userId), eq(orgMembers.role, "SIGNATORY")),
        ),
    );

    return rows.map((row) => ({
      orgId: row.orgId,
      legalName: row.legalName,
      kybStatus: row.kybStatus as KycStatus,
      authorityApproved: row.authorityApprovedAt !== null,
    }));
  }

  async subjectState(
    userId: string,
    options: { orgId?: string } = {},
  ): Promise<SubjectKycState> {
    const rows = await withContext(this.db, { role: "system" }, (tx) =>
      tx.select().from(kycRecords).where(eq(kycRecords.userId, userId)).limit(1),
    );
    const record = rows[0];

    const signatory = await this.signatoryFor(userId, options.orgId);

    return {
      personalKycStatus: (record?.status as KycStatus) ?? "NOT_STARTED",
      /** Better Auth will supply this; the placeholder session cannot. */
      phoneVerified: true,
      panCheckPassed: Boolean(record?.panLast4),
      /**
       * Read off the decision, which is the only place this is knowable.
       *
       * It cannot be computed by looking for a matching blind index: the
       * unique index means that if this record holds one, no other record
       * can, so such a query is structurally always false. What is stored is
       * the decision function's own finding, from the moment it compared them.
       *
       * It was hardcoded false, which left can('START_TRIAL')'s
       * PAN_ALREADY_USED denial unreachable. The outcome was still safe —
       * neither the unique index nor decideKyc lets a second subject through
       * on one PAN — but the person was told to complete a PAN check they had
       * already completed, rather than that the PAN belongs to another
       * account and support has to sort it out.
       */
      panAlreadyUsed:
        record?.decisionReasons?.some((r) => r.code === "PAN_ALREADY_USED") ??
        false,
      /**
       * Read for the business in question, not guessed at.
       *
       * `signatory` is null when this person signs for no business, or when
       * they sign for several and the caller did not say which — see
       * signatoryFor(). Both land on NOT_STARTED, which denies, because
       * neither is an answer and a gate on a 25-year agreement must not
       * default to yes.
       */
      kybStatus: signatory?.kybStatus ?? "NOT_STARTED",
      /**
       * The signatory's own KYC is this person's own KYC — they are the one
       * signing. Reported as NOT_STARTED when there is no business to sign
       * for, so the denial names the missing business rather than implying
       * the person failed a check they never took.
       */
      signatoryKycStatus: signatory
        ? ((record?.status as KycStatus) ?? "NOT_STARTED")
        : "NOT_STARTED",
      /** Legal's approval of the board resolution. Absent means no. */
      signatoryAuthorityApproved: signatory?.authorityApproved ?? false,
      /**
       * Read, not assumed. One parcel whose own verdict is VERIFIED is enough
       * to sign a lease for that parcel — and the parcel's verdict is a
       * stronger thing than "Legal approved the documents", because it also
       * accounts for co-owners and for somebody else having claimed the same
       * khasra number.
       */
      landDocumentsApproved: await landIsLeasable(this.db, userId),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Webhook                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Handles a vendor webhook.
   *
   * The order is deliberate and each step is load-bearing:
   *
   *   1. verify the signature over the RAW bytes  — it is really the vendor
   *   2. check the replay guard                   — we have not done this already
   *   3. fetch the result server-to-server        — do not trust the body
   *   4. decideKyc()                              — the only place a status is decided
   *   5. one transaction                          — all five tables or none
   *
   * Step 3 is the one that looks redundant and is not. The webhook body
   * announces that a result is ready; it is not the result. Reading a status
   * out of it would mean trusting a payload an attacker can replay or forge if
   * step 1 ever regresses.
   */
  async handleWebhook(params: {
    vendor: string;
    rawBody: Buffer | undefined;
    signatureHeader: string | undefined;
  }): Promise<{ handled: boolean; reason?: string; status?: KycStatus }> {
    const { vendor, rawBody, signatureHeader } = params;

    if (!rawBody || rawBody.length === 0) {
      throw ApiError.unauthorized("WEBHOOK_EMPTY_BODY", "Empty webhook body.");
    }

    const verification = verifyWebhook({
      scheme: this.provider.webhookScheme,
      /**
       * The raw bytes, not a re-serialised object. The signature covers
       * exactly what was sent, so JSON.stringify(req.body) passes in
       * development and fails the first time a vendor changes key order or
       * whitespace.
       */
      rawBody: rawBody.toString("utf8"),
      signatureHeader: signatureHeader ?? "",
      secret: this.config.KYC_WEBHOOK_SECRET,
      now: this.clock(),
      toleranceSeconds: this.config.KYC_WEBHOOK_TOLERANCE_SECONDS,
    });

    if (!verification.valid) {
      /**
       * 401 and nothing else. Never say which check failed: that tells
       * someone probing the endpoint whether they have the secret, the wrong
       * timestamp, or a malformed header.
       */
      this.logger.warn(`Webhook rejected for ${vendor}: ${verification.reason}`);
      throw ApiError.unauthorized("WEBHOOK_UNAUTHORIZED", "Invalid signature.");
    }

    const body = JSON.parse(rawBody.toString("utf8")) as {
      eventId?: string;
      sessionId?: string;
    };

    if (!body.eventId || !body.sessionId) {
      throw ApiError.badRequest(
        "WEBHOOK_MALFORMED",
        "Webhook is missing eventId or sessionId.",
      );
    }

    const replay = await this.replayGuard.check(vendor, body.eventId, this.clock());
    if (!replay.fresh) {
      /**
       * 200, not an error. A duplicate delivery is the vendor behaving
       * correctly — answering 4xx would make it retry harder.
       */
      this.logger.log(`Ignoring replayed webhook ${vendor}:${body.eventId}`);
      return { handled: false, reason: "REPLAY" };
    }

    const result = await this.provider.fetchResult(body.sessionId);
    const status = await this.decideAndApply(result);

    return { handled: true, status };
  }

  /**
   * Turns a vendor result into a decision and writes it.
   *
   * Delegates to @kilowattx/kyc-pipeline, which the worker's reconciliation
   * job also calls. This used to be ~90 lines of private method here —
   * duplicate-PAN lookup, PAN encryption, the checks array, the five-table
   * transaction — and the worker was about to grow its own copy of all of it.
   */
  private async decideAndApply(result: VendorKycResult): Promise<KycStatus> {
    const thresholds = await this.thresholds();

    const outcome = await withContext(this.db, { role: "system" }, (tx) =>
      applyVendorResult(tx, {
        result,
        thresholds,
        blindIndexKey: this.blindIndexKey(),
        encryptor: this.panEncryptor,
        now: this.clock(),
      }),
    );

    return outcome.status;
  }

  private blindIndexKey(): Buffer {
    return Buffer.from(this.config.KYC_BLIND_INDEX_KEY, "base64");
  }
}
