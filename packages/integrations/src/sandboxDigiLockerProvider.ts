import {
  VendorError,
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
 * DigiLocker, through Sandbox — the replacement for Aadhaar OKYC.
 *
 * OKYC is gone. Both of its calls have returned 503 "Source Unavailable" on
 * live keys since 16 October while Sandbox's own layer stayed healthy, and
 * their documentation records the endpoint as deprecated by UIDAI. The design
 * is in docs/superpowers/specs/2026-10-21-digilocker-migration-design.md.
 *
 * WHAT CHANGES, AND IT IS THE WHOLE POINT: the Aadhaar number never reaches
 * this system. The person authenticates at digilocker.meripehchaan.gov.in —
 * the government's own site, under their own DigiLocker account — and the OTP
 * is UIDAI's, handled there. We send a redirect URL and ask afterwards what
 * happened. There is no number to validate, hold between two calls, or
 * refuse to store.
 *
 * So this is the hosted-session shape the `KycProvider` interface already
 * describes: createSession() hands back a URL to send somebody to, and
 * fetchResult() asks server-to-server what came of it. The OTP methods throw,
 * because this gateway has no OTP of its own.
 *
 * NOT YET EXERCISED AGAINST A COMPLETED SESSION. The session can be opened —
 * that is confirmed against the live gateway — but no one has walked through
 * DigiLocker and come back, so the field mapping in `fetchResult` follows the
 * published examples and nothing more. That is the first thing to check when
 * somebody does, and the spec says so.
 */

/** Sandbox's DigiLocker routes. */
const ROUTES = {
  init: "/kyc/digilocker/sessions/init",
  status: (id: string) => `/kyc/digilocker/sessions/${id}/status`,
  /**
   * The person's details, confirmed against a real completed session.
   *
   * NOT /documents/{type}. That route returns S3 links to the issued files —
   * the UIDAI XML — which would have to be downloaded and parsed. The profile
   * is the parsed form and is what an AadhaarResult actually needs.
   */
  profile: (id: string) => `/kyc/digilocker/sessions/${id}/user/profile`,
  /**
   * The issued Aadhaar itself: a short-lived S3 link to UIDAI's signed XML.
   *
   * Fetched for the one thing the profile lacks — the photograph, which is
   * what a selfie is compared against. The same XML also carries the masked
   * number, so this is where the last four come from too.
   */
  document: (id: string) => `/kyc/digilocker/sessions/${id}/documents/aadhaar`,
} as const;

/** The S3 link is good for an hour; a download that takes longer is dead. */
const DOCUMENT_TIMEOUT_MS = 15_000;

/**
 * How long a session is worth chasing when the gateway does not say.
 *
 * Their authorization URL normally carries `consent_valid_till`. When it does
 * not, this stands in — short enough that reconciliation gives up on a dead
 * session, long enough for somebody to find their DigiLocker password.
 */
const DEFAULT_SESSION_MINUTES = 30;

export interface SandboxDigiLockerOptions {
  apiKey: string;
  apiSecret: string;
  /** Guards the key/host pairing. See SandboxClient. */
  nodeEnv: string;
  webhookSecret: string;
  clock?: () => Date;
  /** Shared so one access token serves every Sandbox adapter in the process. */
  client?: SandboxClient;
  /** Downloads the issued document. Injected by tests; `fetch` otherwise. */
  download?: (url: string) => Promise<string>;
  /** Where a lost photograph is reported. It never fails the verification. */
  warn?: (line: string) => void;
}

export class SandboxDigiLockerProvider implements KycProvider {
  readonly name = "digilocker";

  /** The person authenticates at DigiLocker; no number reaches us. */
  readonly aadhaarRoute = "HOSTED" as const;

  /** Same scheme as the other Sandbox adapters, for the reconciliation path. */
  readonly webhookScheme = "hmac-body" as const;

  private readonly client: SandboxClient;
  private readonly clock: () => Date;
  private readonly download: (url: string) => Promise<string>;
  private readonly warn: (line: string) => void;

  constructor(options: SandboxDigiLockerOptions) {
    this.client = options.client ?? new SandboxClient(options);
    this.clock = options.clock ?? (() => new Date());
    this.download = options.download ?? downloadText;
    this.warn = options.warn ?? ((line) => console.warn(line));
  }

  /* ---------------------------------------------------------------- */
  /* The hosted session                                               */
  /* ---------------------------------------------------------------- */

  async createSession(request: CreateSessionRequest): Promise<KycSession> {
    const body = await this.client.call<{
      authorization_url: string;
      session_id: string;
    }>(ROUTES.init, {
      "@entity": "in.co.sandbox.kyc.digilocker.session.request",
      /**
       * "signin" rather than "signup": somebody who has no DigiLocker account
       * can still create one at their end, and asking for the signup flow
       * would push every existing account holder through registration.
       */
      flow: "signin",
      redirect_url: request.redirectUrl,
      /**
       * Only what the check needs.
       *
       * Their API will share a driving licence and more besides, and the
       * consent screen lists whatever we ask for. Asking for documents we
       * have no use for would be collecting them, which is the thing DPDP is
       * about — and it would make the consent screen look like a fishing
       * expedition at the exact moment we need somebody to trust it.
       */
      doc_types: ["aadhaar"],
    });

    return {
      vendorSessionId: body.data.session_id,
      hostedUrl: body.data.authorization_url,
      expiresAt: this.consentWindowOf(body.data.authorization_url),
    };
  }

  /**
   * Reads `consent_valid_till` out of the authorization URL.
   *
   * Taken from what they built rather than computed here, because the
   * reconciliation job decides from this whether a session is still worth
   * asking about: a guessed value either abandons a live session or chases a
   * dead one for ever.
   */
  private consentWindowOf(authorizationUrl: string): Date {
    const fallback = new Date(
      this.clock().getTime() + DEFAULT_SESSION_MINUTES * 60_000,
    );

    try {
      const raw = new URL(authorizationUrl).searchParams.get("consent_valid_till");
      if (!raw || !/^[0-9]+$/.test(raw)) return fallback;

      /** Seconds, like every other epoch in their payloads. */
      const at = new Date(Number(raw) * 1000);
      return Number.isNaN(at.getTime()) ? fallback : at;
    } catch {
      return fallback;
    }
  }

  /* ---------------------------------------------------------------- */
  /* The result                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Asks what came of the session, server to server.
   *
   * Never from the browser's word for it. The person's return to our page is
   * a hint that something happened; this is how we find out what, and it is
   * the same rule the deleted hosted-vendor path observed.
   */
  async fetchResult(vendorSessionId: string): Promise<VendorKycResult> {
    const status = await this.client.call<{ id: string; status: string }>(
      ROUTES.status(vendorSessionId),
      undefined,
      "GET",
    );

    const state = String(status.data?.status ?? "").toLowerCase();

    /**
     * Still at DigiLocker. Retryable, so reconciliation asks again rather
     * than recording a failure for somebody who is mid-flow.
     */
    if (state === "created" || state === "initiated" || state === "pending") {
      throw new VendorError(
        `The DigiLocker session has not been completed yet (status "${state}").`,
        this.name,
        true,
      );
    }

    /**
     * Anything that is not a known completion is refused rather than
     * retried. An unrecognised status looping for ever is worse than one
     * that reaches a human: the person is left waiting either way, and only
     * one of those gets looked at.
     *
     * "succeeded" is the real one, confirmed against a completed session —
     * their documentation shows only "created" and never enumerates the rest.
     * It was guessed as "success" and a finished verification was therefore
     * refused, which is the whole reason this list is now evidence and not
     * inference. The other two are kept as a hedge, not as knowledge.
     */
    if (state !== "succeeded" && state !== "consented" && state !== "completed") {
      throw new VendorRequestError(
        this.name,
        `DigiLocker reported the session as "${state || "unknown"}", ` +
          "which is not a completed verification. If the person declined to " +
          "share their Aadhaar, they will need to start again and consent.",
      );
    }

    /**
     * The user profile, for the name and date of birth.
     *
     * Confirmed against a real session: this returns name, date_of_birth,
     * gender, mobile and email as parsed fields. What it does NOT return is
     * an Aadhaar number in any form, or a photograph — those are in the
     * issued document, fetched below.
     */
    const profile = await this.client.call<{
      name?: string;
      /** "26/05/2004" — DD/MM/YYYY, with slashes. Not the epoch their docs show. */
      date_of_birth?: string;
      gender?: string;
      /** True when the shared document was an Aadhaar. */
      eaadhaar?: boolean;
    }>(ROUTES.profile(vendorSessionId), undefined, "GET");

    const record = profile.data;
    const issued = await this.issuedAadhaar(vendorSessionId);

    return {
      vendorSessionId,
      vendor: this.name,
      vendorVersion: "digilocker-1.0.0",
      /** Their transaction id is the event identity for the replay guard. */
      eventId: profile.transaction_id,
      aadhaar: {
        status: record?.name ? "SUCCESS" : "FAILED",
        nameOnRecord: record?.name,
        /** They have used both spellings in published examples. */
        dateOfBirth: isoDate(record?.date_of_birth),
        /**
         * From the issued XML's masked `uid`, when the document could be
         * fetched; absent otherwise, never guessed — a fabricated four would
         * show somebody a stranger's. `remainingSteps` keys off the reference
         * token, so a missing four does not hold anybody up.
         */
        last4: issued.last4,
        /** Base64 JPEG, for the selfie comparison. Absent when unavailable. */
        photo: issued.photo,
        /**
         * The session id is what we quote back when asked what we checked.
         * It is not derived from the Aadhaar number, because we never see one.
         */
        refToken: vendorSessionId,
      },
      rawResponseKey: `kyc-docs/raw/${vendorSessionId}.json`,
      completedAt: this.clock(),
    };
  }

  /**
   * The photograph and masked number from the issued Aadhaar XML.
   *
   * Never throws. The person has already verified at DigiLocker and the
   * profile is in hand; losing the photograph costs an automatic face match,
   * which then falls to a reviewer — a worse check, not a wrong one. Failing
   * here instead would throw away a completed verification over a download.
   */
  private async issuedAadhaar(
    vendorSessionId: string,
  ): Promise<{ photo?: string; last4?: string }> {
    try {
      const body = await this.client.call<{
        files?: { url?: string; metadata?: { ContentType?: string } }[];
      }>(ROUTES.document(vendorSessionId), undefined, "GET");

      const files = body.data?.files ?? [];
      const file =
        files.find((f) => /xml/i.test(f.metadata?.ContentType ?? "")) ?? files[0];

      if (!file?.url) {
        this.warn(`DigiLocker session ${vendorSessionId}: no Aadhaar file was shared.`);
        return {};
      }

      const issued = readAadhaarXml(await this.download(file.url));
      if (!issued.photo) {
        this.warn(`DigiLocker session ${vendorSessionId}: the Aadhaar XML had no photograph.`);
      }
      return issued;
    } catch (error) {
      this.warn(
        `DigiLocker session ${vendorSessionId}: could not fetch the Aadhaar document — ` +
          `the selfie will go to a reviewer instead of being matched. ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
      return {};
    }
  }

  /* ---------------------------------------------------------------- */
  /* Not implemented: there is no OTP here                            */
  /* ---------------------------------------------------------------- */

  /**
   * Both throw, rather than returning something empty.
   *
   * The one-time password in this flow is UIDAI's, sent and checked on the
   * government's own site inside DigiLocker. A method here that quietly did
   * nothing would read as an OTP that had been sent to somebody — and the
   * caller would then wait for a code that was never coming.
   */
  async sendAadhaarOtp(_aadhaarNumber: string): Promise<AadhaarOtpChallenge> {
    throw new Error(
      "DigiLocker has no OTP to send: the one-time password is UIDAI's and is " +
        "handled on the government's own site. Use createSession() and send the " +
        "person to its hostedUrl.",
    );
  }

  async verifyAadhaarOtp(_referenceId: string, _otp: string): Promise<AadhaarOtpResult> {
    throw new Error(
      "DigiLocker has no OTP to verify: it is checked at digilocker.meripehchaan.gov.in. " +
        "Use fetchResult() once the person returns.",
    );
  }
}

/**
 * The only part of an Aadhaar number we may keep.
 *
 * Takes the last four digits of whatever the issuer shared, which is usually
 * already masked. Returns undefined rather than a guess when there is nothing
 * usable — the design spec flags that DigiLocker may not supply this at all,
 * and a fabricated four digits would show a person somebody else's number.
 */
function lastFourOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : undefined;
}

/**
 * Reads the two fields we use out of UIDAI's KycRes XML.
 *
 * Two regular expressions rather than an XML parser, because both targets are
 * flat and fixed by UIDAI's schema — `<Pht>` holds base64 and nothing else,
 * `uid` is an attribute on `<UidData>` — and a parser would be a dependency
 * that reads the whole signed document to find two values in it. The
 * signature is not verified here; the document came from DigiLocker over
 * Sandbox's authenticated API, which is the trust we already extend to the
 * name and date of birth.
 */
export function readAadhaarXml(xml: string): { photo?: string; last4?: string } {
  const photo = /<Pht>\s*([A-Za-z0-9+/=\s]+?)\s*<\/Pht>/.exec(xml)?.[1]?.replace(/\s+/g, "");
  const uid = /<UidData\b[^>]*\buid="([^"]*)"/.exec(xml)?.[1];

  return {
    photo: photo && photo.length > 0 ? photo : undefined,
    last4: lastFourOf(uid),
  };
}

/** Plain HTTPS GET of the pre-signed link. No credentials go with it. */
async function downloadText(url: string): Promise<string> {
  if (!url.startsWith("https://")) {
    throw new Error("the document link is not HTTPS");
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(DOCUMENT_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`document download returned HTTP ${response.status}`);
  return response.text();
}
