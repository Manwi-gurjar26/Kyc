import { randomUUID } from "node:crypto";
import {
  can,
  canTransition,
  decideKyc,
  panBlindIndex,
  type KycAction,
  type KycLevel,
  type KycStatus,
  type KycThresholds,
  type PanResult,
  type SubjectKycState,
} from "@kilowattx/core";
import {
  applyKycDecision,
  consentRecords,
  aadhaarOtpChallenges,
  documents,
  kycRecords,
  orgMembers,
  organisations,
  settings,
  users,
  withContext,
  type Database,
} from "@kilowattx/db";
import {
  KYC_DOCS_PREFIX,
  LocalDiskBucket,
  ReplayGuard,
  verifyWebhook,
  type KybProvider,
  type KycProvider,
  type VendorKycResult,
  VendorRequestError,
} from "@kilowattx/integrations";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
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
    /**
     * The PAN check lives on the KYB adapter because the Income Tax
     * Department's route is the same one for a person and a company. It is
     * selected by KYC_PROVIDER, so there is no way to run a real KYC gateway
     * against a fake PAN check.
     */
    @Inject(DI.KYB_PROVIDER) private readonly kyb: KybProvider,
    /**
     * Where the UIDAI photograph goes. The row holds a key, never the image.
     */
    @Inject(DI.FILE_BUCKET) private readonly bucket: LocalDiskBucket,
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
    /**
     * Absent for a gateway whose hosted URL is its own credential, which
     * DigiLocker's is — there is no second token to hand the browser.
     */
    clientToken?: string;
    vendorSessionId: string;
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
      /**
       * An outage must not spend one of the three tries.
       *
       * `claimChallenge` counts the attempt before the call, which is right:
       * a wrong OTP that threw on the way out would otherwise never be
       * counted and the limit would be unenforceable. But it counts every
       * failure the same way, including the ones where the gateway never
       * looked at the OTP at all.
       *
       * That is not hypothetical. The gateway answered 503 "Source
       * Unavailable" — UIDAI being unreachable on their side — and that
       * still burned a try. Three of those and somebody is locked out of a
       * challenge whose OTP was never once checked, told to request a new
       * one, and met by the same outage on the next three. The guess has to
       * be adjudicated to be counted.
       *
       * A VendorRequestError IS adjudication: the gateway looked and refused
       * the input. Anything else — 5xx, a timeout, a refused connection —
       * is refunded.
       */
      if (!(error instanceof VendorRequestError)) {
        await this.refundAttempt(userId);
        throw this.vendorFailure(
          error,
          "The verification service is temporarily unavailable. " +
            "Your OTP has not been used up, so the same one will still work.",
        );
      }

      throw this.vendorFailure(error, "We could not check that OTP just now.");
    }

    /**
     * A gateway that answers but reports the record as not valid is a failed
     * check, not a passed one. Treating a non-SUCCESS status as success is the
     * single worst bug available here, so it is refused explicitly rather than
     * left to fall through into a stored reference token.
     *
     * What it must not do is blame the number. This said "please check the
     * number and try again", which is wrong twice over: the twelve digits
     * already passed a Verhoeff check here, and the gateway itself accepted
     * them one call earlier when it sent the OTP. By far the likeliest causes
     * are a mistyped OTP or a reference id that has expired, and the gateway
     * says which — so its reason is logged and the person is pointed at the
     * OTP, with a fresh one being the fix.
     */
    if (result.status !== "SUCCESS") {
      this.logger.warn(
        `Aadhaar OTP check returned a failure${
          result.failureReason ? `: ${result.failureReason}` : " with no stated reason"
        }`,
      );

      throw ApiError.badRequest(
        "AADHAAR_CHECK_FAILED",
        "That OTP could not be confirmed. It may be mistyped or expired — " +
          "please request a new one and try again.",
      );
    }

    /**
     * The name and date are recorded here, not handed to the browser and
     * forgotten. They are what the PAN check matches against, and they have
     * to come from UIDAI rather than from a form the subject fills in.
     */
    const stored = await this.rememberAadhaar(userId, {
      refToken: result.refToken,
      name: result.nameOnRecord,
      dob: result.dateOfBirth,
      photoKey: await this.storeAadhaarPhoto(userId, result.photo),
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

  /* ------------------------------------------------------------------ */
  /* PAN                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Verifies a PAN against the Income Tax Department.
   *
   * The Department does not tell us the name on a PAN. It takes a name from us
   * and answers whether it matched, so the entire value of `nameMatch` rests
   * on where that name came from. It comes from `aadhaar_name` — what UIDAI
   * returned — and never from this request. A name the subject supplies is a
   * name they can read off the card in front of them, and matching it would
   * catch a typo and nothing else.
   *
   * That is why Aadhaar has to be done first, and why this refuses rather than
   * falling back to the display name. A weaker check that looks like the real
   * one is worse than a missing one.
   *
   * Like the Aadhaar step, the record stays IN_PROGRESS. `decideKyc()` is the
   * only thing that sets a status.
   */
  async verifyPan(
    userId: string,
    pan: string,
  ): Promise<{
    last4: string;
    status: PanResult["status"];
    nameMatch: boolean;
    dobMatch: boolean;
    linkedToAadhaar: boolean;
  }> {
    if (!(await this.hasLiveConsent(userId, "KYC_VERIFICATION"))) {
      throw ApiError.forbidden(
        "CONSENT_REQUIRED",
        "We need your agreement before sending your PAN to the Income Tax Department.",
      );
    }

    const identity = await this.verifiedIdentity(userId);

    if (!identity) {
      throw ApiError.badRequest(
        "AADHAAR_REQUIRED_FIRST",
        "Please confirm your Aadhaar first. The name on your PAN is checked " +
          "against the name on your Aadhaar, so we need that before we can check your PAN.",
      );
    }

    /**
     * Computed before the Department is called, because it is also the
     * duplicate check — and a PAN already registered to somebody else is a
     * refusal we can make for free, without a paid call.
     */
    const blindIndex = panBlindIndex(pan, this.blindIndexKey());

    if (await this.panBelongsToAnother(userId, blindIndex)) {
      throw ApiError.badRequest(
        "PAN_ALREADY_USED",
        "That PAN is already registered to another account. " +
          "If you believe this is a mistake, please contact support.",
      );
    }

    let result: PanResult;
    try {
      result = await this.kyb.verifyPan({
        pan,
        /** From UIDAI. Not from the request, and not the display name. */
        name: identity.name,
        dateOfBirth: identity.dob,
      });
    } catch (error) {
      throw this.panFailure(error);
    }

    await this.rememberPan(userId, { pan, blindIndex });

    /**
     * Decided here, with the result still in hand.
     *
     * This is the last step a person can currently complete, and it is the
     * only moment the PAN findings exist anywhere: `rememberPan` stores
     * ciphertext, four digits and a blind index, and nothing about whether
     * the Department matched the name. A decision endpoint called later would
     * have to rebuild `nameMatch` from the kyc_checks rows, which means two
     * sources of truth for one answer.
     */
    await this.decideFromSteps(userId, result);

    return {
      last4: pan.slice(-4),
      status: result.status,
      nameMatch: result.nameMatch,
      dobMatch: result.dobMatch,
      linkedToAadhaar: result.linkedToAadhaar,
    };
  }

  /**
   * Runs `decideKyc()` over what the step-by-step flow has recorded.
   *
   * The gap this closes: nothing in this flow ever decided anything. A person
   * who confirmed their Aadhaar and verified their PAN stayed IN_PROGRESS for
   * good — not reviewable, not rejected, not visible in the review queue, and
   * carrying a status that was simply untrue. `decideKyc()` was only ever
   * reached by the webhook path, which the OTP flow does not use.
   *
   * It is deliberately NOT a "submit" the person triggers. The decision is
   * ours to make from evidence we hold, and an explicit submit would invite a
   * client to decide when it had collected enough.
   *
   * For a FULL verification this produces MANUAL_REVIEW rather than VERIFIED,
   * because there is no selfie step yet and `decideKyc()` sends a FULL
   * verification with no selfie to a human. That is the right answer and not
   * a limitation to route around: the case now reaches a reviewer with a
   * reason attached instead of sitting still.
   */
  private async decideFromSteps(userId: string, pan: PanResult): Promise<void> {
    const thresholds = await this.thresholds();
    const now = this.clock();

    const rows = await withContext(this.db, { role: "system" }, (tx) =>
      tx
        .select({
          id: kycRecords.id,
          level: kycRecords.level,
          status: kycRecords.status,
          refToken: kycRecords.aadhaarRefToken,
          name: kycRecords.aadhaarName,
          dob: kycRecords.aadhaarDob,
        })
        .from(kycRecords)
        .where(eq(kycRecords.userId, userId))
        .limit(1),
    );

    const record = rows[0];
    if (!record) return;

    /**
     * The reference token is what says the OTP was actually confirmed.
     *
     * Not the last four digits, which are written when the OTP is merely
     * requested — treating those as proof would report an Aadhaar success for
     * somebody who never typed the code.
     */
    const aadhaar = record.refToken
      ? {
          status: "SUCCESS" as const,
          nameOnRecord: record.name ?? undefined,
          dateOfBirth: record.dob ?? undefined,
        }
      : undefined;

    const decision = decideKyc(
      {
        level: record.level as KycLevel,
        now,
        aadhaar,
        pan,
        /**
         * Always undefined, and that is not an oversight.
         *
         * A SelfieResult carries `livenessPassed` and a face-match score, and
         * this gateway sells neither — there is no call that would produce
         * them. Supplying a made-up pair here would auto-approve a biometric
         * nobody examined, which is the same failure the fake virus scanner
         * is refused in production for.
         */
        selfie: undefined,
        /**
         * What we can say truthfully: a selfie is on file and unscored. It
         * reviews either way; this only changes what the reviewer is told.
         */
        selfieCollectedButNotScored: await this.hasCleanSelfie(userId),
        /**
         * False by construction: `verifyPan` refuses a PAN held by another
         * subject before the Department is ever called, so a duplicate
         * cannot reach this point.
         */
        duplicatePan: false,
      },
      thresholds,
    );

    /**
     * Asked before writing, rather than discovered by throwing.
     *
     * `applyKycDecision` throws on an illegal move, which is correct of it —
     * but two legitimate requests reach here with nothing legal to do, and
     * neither deserves a 500:
     *
     *   - a re-submitted PAN re-decides to the status already held, and
     *     `canTransition` treats from === to as illegal;
     *   - a record already VERIFIED or REJECTED cannot be moved by this flow
     *     at all, and must not be. Re-KYC starts a new record; reopening a
     *     cleared subject is a deliberate, logged action and not a side
     *     effect of somebody typing their PAN again.
     *
     * So the move is checked first and skipped quietly. Nothing is written,
     * which is also the honest audit outcome: there was no new decision.
     */
    if (!canTransition(record.status as KycStatus, decision.status)) return;

    await withContext(this.db, { role: "system" }, (tx) =>
      applyKycDecision(tx, {
        kycRecordId: record.id,
        decision,
        thresholds,
        now,
        /** One row per check this flow actually performed. */
        checks: [
          ...(aadhaar
            ? [
                {
                  checkType: "AADHAAR" as const,
                  status: "PASSED" as const,
                  detail: "OTP confirmed with the gateway.",
                },
              ]
            : []),
          {
            checkType: "PAN" as const,
            status:
              pan.status === "VALID" && pan.nameMatch
                ? ("PASSED" as const)
                : ("FAILED" as const),
            detail: `Income Tax Department reported ${pan.status}; name match ${
              pan.nameMatch ? "yes" : "no"
            }, date of birth match ${pan.dobMatch ? "yes" : "no"}.`,
          },
        ],
        actorType: "SYSTEM",
      }),
    );
  }

  /**
   * Puts the UIDAI photograph in the object store and returns its key.
   *
   * In the bucket rather than a column, like every other raw vendor artefact.
   * A base64 JPEG on `kyc_records` would be copied into each backup, each
   * replica and every `SELECT *` somebody runs while debugging, and a
   * biometric should not travel that freely.
   *
   * Undefined in, undefined out: the fake gateway returns no photograph, and
   * a missing one is normal rather than an error.
   *
   * A failure here must not fail the verification. The OTP was confirmed, the
   * reference token is the thing that proves it, and losing the photograph
   * costs a reviewer a side-by-side comparison — which is a worse review, not
   * a wrong one. Throwing instead would discard a successful check and bill
   * the person a second gateway call to recover it.
   */
  private async storeAadhaarPhoto(
    userId: string,
    photo: string | undefined,
  ): Promise<string | undefined> {
    if (!photo) return undefined;

    try {
      /** Accepts a bare base64 payload as well as the data URL they send. */
      const base64 = photo.replace(/^data:image\/[a-z]+;base64,/i, "");
      const bytes = Buffer.from(base64, "base64");

      if (bytes.length === 0) return undefined;

      const key = `${KYC_DOCS_PREFIX}${userId}/AADHAAR_PHOTO/${randomUUID()}.jpg`;
      await this.bucket.put(key, bytes, "image/jpeg");
      return key;
    } catch (error) {
      this.logger.error(
        "Could not store the Aadhaar photograph; the verification itself stands",
        error instanceof Error ? error.stack : String(error),
      );
      return undefined;
    }
  }

  /**
   * Whether a selfie is on file and safe to look at.
   *
   * CLEAN specifically, not merely uploaded. A quarantined or unscanned file
   * is not evidence a reviewer can act on — and `ScanResult` keeps ERRORED
   * separate from CLEAN for exactly this reason: a scanner that could not be
   * reached has found nothing, which is not the same as having found nothing
   * wrong. Either way the reviewer would be told a selfie is waiting for them
   * when there is nothing they may safely open.
   */
  private async hasCleanSelfie(userId: string): Promise<boolean> {
    const rows = await withContext(this.db, { role: "system" }, (tx) =>
      tx
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.ownerUserId, userId),
            eq(documents.docType, "SELFIE"),
            eq(documents.scanStatus, "CLEAN"),
          ),
        )
        .limit(1),
    );

    return rows.length > 0;
  }

  /**
   * The UIDAI-verified name and date, or null when Aadhaar is not done.
   *
   * Both or neither: a name without a date cannot be sent to the Department,
   * which matches them together, so a half-filled record is treated as no
   * record rather than as something to work around.
   */
  private async verifiedIdentity(
    userId: string,
  ): Promise<{ name: string; dob: string } | null> {
    const rows = await withContext(this.db, { role: "system" }, (tx) =>
      tx
        .select({ name: kycRecords.aadhaarName, dob: kycRecords.aadhaarDob })
        .from(kycRecords)
        .where(eq(kycRecords.userId, userId))
        .limit(1),
    );

    const row = rows[0];
    if (!row?.name || !row.dob) return null;
    return { name: row.name, dob: row.dob };
  }

  /**
   * Whether this PAN is already on somebody else's record.
   *
   * The unique index on `pan_blind_index` is the real enforcement, and it
   * stays the thing that cannot be raced past. This check exists so the
   * ordinary case — a person mistyping a PAN that belongs to someone else —
   * reads as a refusal rather than as a constraint violation surfacing as a
   * 500, and so we do not pay for a vendor call to learn it.
   *
   * Scoped to OTHER records: re-submitting your own PAN is a retry, not a
   * duplicate.
   */
  private async panBelongsToAnother(
    userId: string,
    blindIndex: string,
  ): Promise<boolean> {
    const rows = await withContext(this.db, { role: "system" }, (tx) =>
      tx
        .select({ userId: kycRecords.userId })
        .from(kycRecords)
        .where(eq(kycRecords.panBlindIndex, blindIndex))
        .limit(1),
    );

    const owner = rows[0];
    return owner !== undefined && owner.userId !== userId;
  }

  /**
   * Stores the PAN: ciphertext, last four, and the blind index.
   *
   * The full PAN goes in encrypted and nowhere else — not in a log line, not
   * in the response, and not in the error when the Department rejects it.
   */
  private async rememberPan(
    userId: string,
    fields: { pan: string; blindIndex: string },
  ): Promise<void> {
    const now = this.clock();
    const encrypted = await this.panEncryptor.encrypt(fields.pan);

    /**
     * Deliberately does not touch `status`.
     *
     * It used to set IN_PROGRESS here, copying the Aadhaar step, and that was
     * wrong in a way the no-op guard in `decideFromSteps` exposed: the PAN
     * step runs after a decision may already exist, so re-submitting a PAN
     * reset MANUAL_REVIEW back to IN_PROGRESS and the decision was then
     * written a second time.
     *
     * The real damage was wider than a duplicate row. This is a bare UPDATE,
     * so it moved the status without consulting `canTransition` — meaning a
     * VERIFIED or REJECTED record could be quietly dragged back to
     * IN_PROGRESS by submitting a PAN again, which is precisely the kind of
     * transition the status machine exists to forbid.
     *
     * Only the decision point sets status now, through `applyKycDecision`,
     * which locks the row and validates the move. The Aadhaar step may still
     * set IN_PROGRESS because it is the first step and the record is
     * NOT_STARTED when it runs.
     */
    await withContext(this.db, { role: "system" }, (tx) =>
      tx
        .update(kycRecords)
        .set({
          panEncrypted: encrypted,
          panLast4: fields.pan.slice(-4),
          panBlindIndex: fields.blindIndex,
          updatedAt: now,
        })
        .where(eq(kycRecords.userId, userId)),
    );
  }

  /**
   * Turns a PAN vendor exception into something a customer can read.
   *
   * Separate from `vendorFailure` only so the codes say PAN rather than
   * AADHAAR — a support agent reading AADHAAR_CHECK_FAILED on a PAN step
   * would go looking in the wrong place.
   */
  private panFailure(error: unknown): ApiError {
    if (error instanceof VendorRequestError) {
      return ApiError.badRequest("PAN_CHECK_FAILED", error.message);
    }
    this.logger.error(
      "PAN gateway call failed",
      error instanceof Error ? error.stack : String(error),
    );
    return ApiError.badRequest(
      "PAN_UNAVAILABLE",
      "We could not check that PAN just now. Please try again shortly.",
    );
  }

  /** Removes a challenge, in a transaction of its own so it commits. */
  private async dropChallenge(userId: string): Promise<void> {
    await withContext(this.db, { role: "system" }, (tx) =>
      tx.delete(aadhaarOtpChallenges).where(eq(aadhaarOtpChallenges.userId, userId)),
    );
  }

  /**
   * Gives back the attempt `claimChallenge` took, after a call the gateway
   * never adjudicated.
   *
   * Guarded on `attempts > 0` rather than trusting the number just read: the
   * refund runs outside the transaction that counted, so a second request for
   * the same person could have moved it in between. A guarded decrement
   * cannot drive the counter negative, and a negative counter would hand out
   * unlimited guesses — the one outcome worse than spending a try on an
   * outage.
   *
   * Failing to refund must not replace the vendor error with a database one.
   * The person is already being told to try again; losing one try is a far
   * smaller problem than swallowing the reason their verification failed.
   */
  private async refundAttempt(userId: string): Promise<void> {
    try {
      await withContext(this.db, { role: "system" }, (tx) =>
        tx
          .update(aadhaarOtpChallenges)
          .set({ attempts: sql`${aadhaarOtpChallenges.attempts} - 1` })
          .where(
            and(
              eq(aadhaarOtpChallenges.userId, userId),
              gt(aadhaarOtpChallenges.attempts, 0),
            ),
          ),
      );
    } catch (error) {
      this.logger.error(
        "Could not refund an Aadhaar OTP attempt after a gateway failure",
        error instanceof Error ? error.stack : String(error),
      );
    }
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
    fields: {
      last4?: string;
      refToken?: string;
      /** UIDAI's name, kept so the PAN check has something real to match. */
      name?: string;
      /** ISO date. */
      dob?: string;
      /** Object-store key for the UIDAI photograph, never the image. */
      photoKey?: string;
    },
  ): Promise<{ last4: string | null }> {
    const now = this.clock();

    /**
     * Built once and shared by the update and the insert, so a field cannot
     * be added to one path and forgotten on the other — which is a bug that
     * only shows up for whoever happens to have no record yet.
     */
    const offered = {
      ...(fields.last4 ? { aadhaarLast4: fields.last4 } : {}),
      ...(fields.refToken ? { aadhaarRefToken: fields.refToken } : {}),
      ...(fields.name ? { aadhaarName: fields.name } : {}),
      ...(fields.dob ? { aadhaarDob: fields.dob } : {}),
      ...(fields.photoKey ? { aadhaarPhotoKey: fields.photoKey } : {}),
    };

    return withContext(this.db, { role: "system" }, async (tx) => {
      const existing = await tx
        .select({ id: kycRecords.id, aadhaarLast4: kycRecords.aadhaarLast4 })
        .from(kycRecords)
        .where(eq(kycRecords.userId, userId))
        .limit(1);

      if (existing[0]) {
        await tx
          .update(kycRecords)
          .set({ ...offered, status: "IN_PROGRESS", updatedAt: now })
          .where(eq(kycRecords.id, existing[0].id));

        return { last4: fields.last4 ?? existing[0].aadhaarLast4 };
      }

      await tx.insert(kycRecords).values({
        userId,
        subjectType: "PERSON",
        level: "FULL",
        status: "IN_PROGRESS",
        ...offered,
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
      remainingSteps: this.remainingSteps(record, await this.hasCleanSelfie(userId)),
      verifiedAt: record.verifiedAt,
    };
  }

  private remainingSteps(
    record: {
      aadhaarLast4: string | null;
      panLast4: string | null;
      livenessPassed: boolean | null;
      status: string;
    },
    /** A scanned, CLEAN selfie document exists for this subject. */
    hasCleanSelfie: boolean,
  ): string[] {
    if (record.status === "VERIFIED") return [];
    const steps: string[] = [];
    if (!record.aadhaarLast4) steps.push("AADHAAR");
    if (!record.panLast4) steps.push("PAN");

    /**
     * Done when a clean selfie is on file, or when liveness actually passed.
     *
     * It asked only the second question, and nothing sets `livenessPassed` —
     * no gateway this system can reach sells a liveness check. So somebody
     * who had uploaded a selfie was told the selfie step was still
     * outstanding, for ever, and the only reasonable thing to do with that
     * screen is take another photograph.
     *
     * Both halves are kept: the file is what there is today, and a real
     * liveness result is what there will be if a vendor is ever added, which
     * should clear the step without this line changing again.
     */
    if (record.livenessPassed !== true && !hasCleanSelfie) steps.push("SELFIE");

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
   * Collects the outcome of a hosted session, after the person comes back.
   *
   * The browser's return is a notification that something happened, never a
   * report of what. This asks the gateway itself — the same rule the webhook
   * path follows, and the reason a webhook body is not believed either.
   *
   * It exists because DigiLocker has no webhook: the person returning to our
   * page is the only signal there is. See
   * docs/superpowers/specs/2026-10-21-digilocker-migration-design.md.
   */
  async collectSession(
    userId: string,
    vendorSessionId: string,
  ): Promise<{ status: KycStatus; reasonCodes: string[] }> {
    const rows = await withContext(this.db, { role: "system" }, (tx) =>
      tx
        .select({
          id: kycRecords.id,
          status: kycRecords.status,
          userId: kycRecords.userId,
          reasons: kycRecords.decisionReasons,
        })
        .from(kycRecords)
        .where(eq(kycRecords.vendorSessionId, vendorSessionId))
        .limit(1),
    );

    const record = rows[0];

    /**
     * Scoped to the caller, and 404 rather than 403 for somebody else's
     * session.
     *
     * The id arrives through the browser, so it is a claim rather than a
     * credential — collecting another person's session would write their
     * verification onto your record. Answering "forbidden" would also confirm
     * the session exists, which is a question a stranger has no business
     * getting an answer to.
     */
    if (!record || record.userId !== userId) {
      throw ApiError.notFound(
        "SESSION_NOT_FOUND",
        "That verification session does not exist.",
      );
    }

    /**
     * Already decided, so say so without asking the gateway again.
     *
     * Somebody reloading the return page out of impatience must not re-apply
     * a decision: `applyKycDecision` refuses a transition to the status
     * already held and would turn a 201 into a 500. It also saves a paid
     * vendor call for an answer we have written down.
     */
    if (record.status !== "NOT_STARTED" && record.status !== "IN_PROGRESS") {
      return {
        status: record.status as KycStatus,
        reasonCodes: (record.reasons ?? []).map((r) => r.code),
      };
    }

    let result: VendorKycResult;
    try {
      result = await this.provider.fetchResult(vendorSessionId);
    } catch (error) {
      throw this.vendorFailure(error, "We could not check that verification just now.");
    }

    const status = await this.decideAndApply(result);

    const after = await withContext(this.db, { role: "system" }, (tx) =>
      tx
        .select({ reasons: kycRecords.decisionReasons })
        .from(kycRecords)
        .where(eq(kycRecords.id, record.id))
        .limit(1),
    );

    return {
      status,
      reasonCodes: (after[0]?.reasons ?? []).map((r) => r.code),
    };
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
