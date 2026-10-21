import { KYC_ACTIONS, type KycAction } from "@kilowattx/core";
import {
  AadhaarOtpRequestSchema,
  AadhaarOtpVerifySchema,
  ConsentInputSchema,
  CreateKycSessionInputSchema,
  PanCheckInputSchema,
  type ConsentInput,
  type CreateKycSessionInput,
  type PanCheckInput,
} from "@kilowattx/validation";
import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiError } from "../common/errors.js";
import { SessionGuard, sessionOf, type RequestWithSession } from "../common/session.js";
import { ZodBody } from "../common/zodPipe.js";
import { KycService } from "./kyc.service.js";

/**
 * Narrows a path segment to a real action, or refuses the request.
 *
 * `can()` in packages/core is an exhaustive switch with no default branch, on
 * purpose: that is what makes adding an action without writing its guard a
 * compile error rather than a silently permitted action. The cost is that an
 * unrecognised string returns undefined and the next line throws, which
 * reaches the client as a 500 — a server error for what is plainly a bad
 * request.
 *
 * So the narrowing happens here, at the boundary, rather than by weakening the
 * exhaustiveness that protects every internal caller. Found by asking for
 * RECEIVE_PAYOUT after it was removed: a client that still had the old string
 * got "something went wrong on our side", which is both untrue and unactionable.
 */
function parseAction(raw: unknown): KycAction {
  if (typeof raw === "string" && (KYC_ACTIONS as readonly string[]).includes(raw)) {
    return raw as KycAction;
  }
  throw ApiError.badRequest(
    "UNKNOWN_ACTION",
    `"${typeof raw === "string" ? raw : ""}" is not an action this service gates. ` +
      "Actions are case-sensitive.",
    { actions: KYC_ACTIONS },
  );
}

/**
 * Customer-facing KYC endpoints, under /v1.
 *
 * Every one of them is behind SessionGuard, and every body is validated by the
 * same Zod schema the browser form uses.
 */
@Controller("v1/kyc")
@UseGuards(SessionGuard)
export class KycController {
  constructor(@Inject(KycService) private readonly kyc: KycService) {}

  /**
   * Status and remaining steps.
   *
   * Masked values only: last four digits, reason codes. Never a full PAN, and
   * there is no Aadhaar number anywhere to return.
   */
  @Get("me")
  async me(@Req() request: RequestWithSession) {
    const session = sessionOf(request);
    return this.kyc.statusFor(session.userId);
  }

  /**
   * Which purposes the caller currently consents to.
   *
   * So a client can decide whether to show a consent screen without having to
   * provoke an error to find out.
   */
  @Get("consents")
  async consents(@Req() request: RequestWithSession) {
    const session = sessionOf(request);
    return { purposes: await this.kyc.liveConsents(session.userId) };
  }

  /** Records consent. Nothing may reach a vendor before this. */
  @Post("consents")
  async createConsent(
    @Req() request: RequestWithSession,
    @Body(new ZodBody(ConsentInputSchema)) body: ConsentInput,
  ) {
    const session = sessionOf(request);
    return this.kyc.recordConsent(session.userId, body);
  }

  /**
   * Opens a vendor session.
   *
   * The idempotency key is required, not optional. Every paid vendor call has
   * one: a double-clicked "Verify" button must not open — and bill us for —
   * two sessions.
   */
  @Post("sessions")
  async createSession(
    @Req() request: RequestWithSession,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ZodBody(CreateKycSessionInputSchema)) body: CreateKycSessionInput,
  ) {
    const session = sessionOf(request);

    if (!idempotencyKey || idempotencyKey.trim().length < 8) {
      throw ApiError.badRequest(
        "IDEMPOTENCY_KEY_REQUIRED",
        "An Idempotency-Key header of at least 8 characters is required.",
      );
    }

    return this.kyc.createSession(session.userId, body, idempotencyKey.trim());
  }

  /**
   * Collects the outcome after a hosted flow sends the person back.
   *
   * Called by the return page, with the session id it was handed. The body is
   * empty on purpose: there is nothing the browser could tell us about the
   * outcome that we would believe. It says "they are back"; the server asks
   * the gateway what actually happened.
   *
   * Safe to call twice. Somebody reloading the page gets the decision already
   * recorded, without a second vendor call.
   */
  @Post("sessions/:vendorSessionId/collect")
  async collectSession(
    @Req() request: RequestWithSession,
    @Param("vendorSessionId") vendorSessionId: string,
  ) {
    const session = sessionOf(request);
    return this.kyc.collectSession(session.userId, vendorSessionId);
  }

  /* ---------------------------------------------------------------- */
  /* Aadhaar OTP                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Step one of Aadhaar eKYC: send the OTP.
   *
   * The number is validated here, offline, before it costs a gateway call —
   * the Verhoeff checksum catches a mistyped digit for nothing.
   */
  @Post("aadhaar/otp")
  async sendAadhaarOtp(
    @Req() request: RequestWithSession,
    @Body() body: unknown,
  ) {
    const session = sessionOf(request);
    const input = AadhaarOtpRequestSchema.parse(body);
    return this.kyc.startAadhaarOtp(session.userId, input.aadhaarNumber);
  }

  /** Step two: submit the OTP the person received. */
  @Post("aadhaar/verify")
  async verifyAadhaarOtp(
    @Req() request: RequestWithSession,
    @Body() body: unknown,
  ) {
    const session = sessionOf(request);
    const input = AadhaarOtpVerifySchema.parse(body);
    return this.kyc.confirmAadhaarOtp(session.userId, input.otp);
  }

  /* ---------------------------------------------------------------- */
  /* PAN                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Verifies a PAN against the Income Tax Department.
   *
   * The body carries the PAN and nothing else — deliberately no name and no
   * date of birth. Those are matched against what UIDAI returned at the
   * Aadhaar step, and accepting them here would let the subject choose the
   * input to their own name check.
   *
   * The ten characters are normalised and checked offline first, so a
   * mistyped PAN costs nothing rather than a paid call.
   */
  @Post("pan")
  async verifyPan(
    @Req() request: RequestWithSession,
    @Body(new ZodBody(PanCheckInputSchema)) body: PanCheckInput,
  ) {
    const session = sessionOf(request);
    return this.kyc.verifyPan(session.userId, body.pan);
  }

  /**
   * Whether a guarded action is available, and if not, why.
   *
   * The app calls this to decide which screen to show. The denial code is the
   * useful part: KYC_REQUIRED starts verification, KYC_IN_REVIEW shows "we are
   * looking at it", and PAN_ALREADY_USED needs support rather than a retry.
   */
  @Get("can/:action")
  async canDo(@Req() request: RequestWithSession) {
    const session = sessionOf(request);
    const action = parseAction(request.params.action);

    /**
     * `?orgId=` names which business the question is about.
     *
     * Only ESIGN_PPA needs it, and only when the person signs for more than
     * one company. A PPA binds one organisation, so asking whether somebody
     * "can sign a PPA" without saying which is an under-specified question —
     * and the wrong way to resolve it is to pick the company that happens to
     * be verified.
     */
    const orgId =
      typeof request.query.orgId === "string" ? request.query.orgId : undefined;

    if (action === "ESIGN_PPA" && !orgId) {
      const orgs = await this.kyc.signatoryOrgs(session.userId);

      if (orgs.length > 1) {
        return {
          allowed: false,
          code: "ORGANISATION_REQUIRED",
          message:
            "You are a signatory of more than one business. Say which one this agreement is for.",
          organisations: orgs.map((org) => ({
            id: org.orgId,
            legalName: org.legalName,
          })),
        };
      }
    }

    try {
      await this.kyc.assertCan(session.userId, action, { orgId });
      return { allowed: true };
    } catch (error) {
      if (error instanceof ApiError) {
        return { allowed: false, code: error.code, message: error.message };
      }
      throw error;
    }
  }
}
