import { isValidAadhaarNumber } from "@kilowattx/validation";
import {
  VendorRequestError,
  type AadhaarOtpChallenge,
  type AadhaarOtpResult,
  type CreateSessionRequest,
  type KycProvider,
  type KycSession,
  type VendorKycResult,
} from "./providers.js";
import { SandboxClient, isoDate } from "./sandboxClient.js";

/**
 * Sandbox (sandbox.co.in), by Quicko — the Aadhaar OKYC gateway.
 *
 * Chosen as the primary because its Aadhaar flow is the shape this system
 * already assumed: two calls, OTP out and OTP back, with consent as an
 * explicit field on the first one. Written against their published request and
 * response documents.
 *
 * What their verify call deliberately does NOT return is the Aadhaar number —
 * only the name, date of birth, address, a photo and hashed contact details.
 * That is the same position our schema takes, which is why `last4` is captured
 * when the OTP is requested rather than when it is verified.
 *
 * The transport — authentication, the token cache, the envelope and the error
 * mapping — lives in SandboxClient, shared with the KYB adapter so that one
 * access token serves the whole process rather than one per provider.
 *
 * NOT YET EXERCISED AGAINST THE LIVE GATEWAY. Everything here follows their
 * documentation, but no request has been made with a real key, so the field
 * mapping below is the thing to check first when one arrives.
 */

export interface SandboxKycProviderOptions {
  apiKey: string;
  apiSecret: string;
  /** Anything other than "production" talks to the test host. */
  nodeEnv: string;
  webhookSecret: string;
  clock?: () => Date;
  /**
   * An existing client, so the KYC and KYB adapters share one access token.
   *
   * Optional: given credentials and nothing else, this builds its own. The
   * application wiring passes one in; a test constructing the provider alone
   * does not have to care.
   */
  client?: SandboxClient;
}

export class SandboxKycProvider implements KycProvider {
  readonly name = "sandbox";

  /**
   * Their callbacks are not used for the OTP flow, which is synchronous.
   * Declared because the interface requires it and because the reconciliation
   * path still needs to know how to verify anything they do send.
   */
  readonly webhookScheme = "hmac-body" as const;

  private readonly client: SandboxClient;

  constructor(options: SandboxKycProviderOptions) {
    /** The credential check lives in the client, which is what uses them. */
    this.client = options.client ?? new SandboxClient(options);
  }

  /* ---------------------------------------------------------------- */
  /* Aadhaar OKYC                                                     */
  /* ---------------------------------------------------------------- */

  async sendAadhaarOtp(aadhaarNumber: string): Promise<AadhaarOtpChallenge> {
    const digits = aadhaarNumber.replace(/\D/g, "");

    /**
     * Checked here as well as at the API boundary. This is the last point
     * before a number leaves our network, and a Verhoeff failure costs
     * nothing to catch where a rejected gateway call costs a request.
     */
    if (!isValidAadhaarNumber(digits)) {
      throw new VendorRequestError(
        this.name,
        "That Aadhaar number is not valid. Please check the twelve digits and try again.",
      );
    }

    const body = await this.client.call<{ reference_id: number; message: string }>(
      "/kyc/aadhaar/okyc/otp",
      {
        "@entity": "in.co.sandbox.kyc.aadhaar.okyc.otp.request",
        aadhaar_number: digits,
        /**
         * Their consent flag. We send "Y" only because a consent row was
         * already written before this method was reached — the API service
         * refuses to call it otherwise. Sending "Y" by default here would
         * make this field a formality, which is the opposite of its purpose.
         */
        consent: "Y",
        reason: "KYC verification for a solar lease or investment",
      },
    );

    return {
      referenceId: String(body.data.reference_id),
      /** They do not return a masked mobile, so it is derived from what we sent. */
      sentTo: `XXXXXX${digits.slice(-4)}`,
      last4: digits.slice(-4),
    };
  }

  async verifyAadhaarOtp(referenceId: string, otp: string): Promise<AadhaarOtpResult> {
    const body = await this.client.call<{
      status: string;
      message: string;
      name?: string;
      date_of_birth?: string;
      gender?: string;
      year_of_birth?: string;
    }>("/kyc/aadhaar/okyc/otp/verify", {
      "@entity": "in.co.sandbox.kyc.aadhaar.okyc.request",
      reference_id: referenceId,
      otp,
    });

    const record = body.data;

    return {
      /**
       * Anything other than VALID is a failure, not an absence. A missing
       * check must never read as a passing one, which is why this maps to
       * FAILED rather than leaving the field undefined.
       */
      status: record.status === "VALID" ? "SUCCESS" : "FAILED",
      nameOnRecord: record.name,
      dateOfBirth: isoDate(record.date_of_birth),
      /** Their transaction id is what we quote back when asked what we checked. */
      refToken: body.transaction_id,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Not implemented: the hosted-session route                        */
  /* ---------------------------------------------------------------- */

  /**
   * This gateway is called server to server, so there is no hosted flow to
   * redirect anybody into and no webhook to wait for. Both throw rather than
   * returning something empty, because a silent no-op here would look like a
   * session that was created and never came back.
   */
  async createSession(_request: CreateSessionRequest): Promise<KycSession> {
    throw new Error(
      "SandboxKycProvider has no hosted session: Aadhaar is verified by direct OTP calls. " +
        "Use sendAadhaarOtp and verifyAadhaarOtp.",
    );
  }

  async fetchResult(_vendorSessionId: string): Promise<VendorKycResult> {
    throw new Error(
      "SandboxKycProvider has no session to fetch: the OTP flow returns its result synchronously.",
    );
  }
}
