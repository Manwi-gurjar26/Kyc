import { createHmac, randomUUID } from "node:crypto";
import { isValidAadhaarNumber } from "@kilowattx/validation";
import {
  VendorRequestError,
  type AadhaarRoute,
  VendorTimeoutError,
  type AadhaarOtpChallenge,
  type AadhaarOtpResult,
  type CreateSessionRequest,
  type FakeScenario,
  type KycProvider,
  type KycSession,
  type VendorKycResult,
} from "./providers.js";
import type { WebhookScheme } from "./webhookVerifier.js";

/**
 * A KYC provider that behaves like the real one, without a vendor contract.
 *
 * This is not a mock. It implements the same interface, returns the same
 * normalised shape, and emits a webhook that passes the real signature
 * verifier — so local development and CI exercise the same code path that
 * production will. Webhook bugs reach production precisely when the local
 * path is different.
 *
 * It exists because every legal route to Aadhaar needs an approval we do not
 * have yet: a DigiLocker requester registration from NeGD, an OVSE
 * registration with UIDAI, or MeitY sign-off for OTP eKYC. Until one of those
 * lands, no code anywhere can verify a real Aadhaar — so the honest thing is a
 * faithful stand-in behind the interface, and a swap of one line when the keys
 * arrive.
 *
 * What it deliberately does NOT do: decide anything. It returns vendor-shaped
 * facts. `core.decideKyc()` turns those into a status, exactly as it will for
 * HyperVerge.
 */

/**
 * Names the fake returns, chosen so a name match is not trivially perfect.
 *
 * A stand-in that always returned exactly the name typed into the form would
 * make the name-matching threshold untestable, and that threshold is what
 * sends a case to a human.
 */
const NAMES = [
  "Ramesh Kumar Sharma",
  "Priya Nair",
  "Mohan Lal Yadav",
  "Anita Desai",
  "Suresh Kumar",
] as const;

export interface FakeWebhook {
  rawBody: string;
  signatureHeader: string;
  /** Seconds the caller should wait before delivering, for the late scenario. */
  delaySeconds: number;
}

export interface FakeKycProviderOptions {
  /** The same secret the API verifies against. */
  webhookSecret: string;
  /** Injected so tests and the decision function share one clock. */
  clock?: () => Date;
  /** Applied when a request does not name its own scenario. */
  defaultScenario?: FakeScenario;
  /**
   * Which Aadhaar journey to pretend to be.
   *
   * The fake is the only adapter that can do both, which makes it the only
   * one where this is a choice rather than a fact. It defaults to "OTP"
   * because that is the flow the app has always used, and flipping the
   * default would silently change what every existing test walks.
   *
   * Set "HOSTED" to rehearse the DigiLocker journey — leave the site, come
   * back, collect — without the gateway.
   */
  aadhaarRoute?: AadhaarRoute;
}

/**
 * Short codes for the scenario, carried inside the session id.
 *
 * This is what makes the fake stateless: any instance, in any process, reads
 * the scenario straight off the id. A real adapter is stateless for the same
 * reason — it asks the vendor over HTTP — so this is the faithful shape rather
 * than a shortcut.
 */
const SCENARIO_CODES: Record<FakeScenario, string> = {
  pass: "ps",
  low_face_score: "lf",
  liveness_fail: "lv",
  pan_name_mismatch: "pn",
  pan_inoperative: "pi",
  pan_deactivated: "pd",
  minor: "mi",
  aadhaar_failed: "af",
  vendor_timeout: "vt",
  late_webhook: "lw",
};

const SCENARIO_BY_CODE: Record<string, FakeScenario> = Object.fromEntries(
  Object.entries(SCENARIO_CODES).map(([scenario, code]) => [code, scenario]),
) as Record<string, FakeScenario>;

const SESSION_ID_PATTERN = /^fake_sess_([a-z]{2})_([0-9a-f]{16})$/;

/** Session lifetime. Short, like the real thing. */
const SESSION_TTL_MINUTES = 20;

/** How late the late_webhook scenario is, in seconds. */
const LATE_WEBHOOK_DELAY_SECONDS = 90;

/**
 * Where the fake sends somebody instead of a real gateway.
 *
 * It used to be `http://localhost:4000/fake-vendor/kyc/{id}`, and no such
 * route was ever written — so the hosted flow could not actually be walked in
 * development, which is the one thing a fake hosted flow is for. The stand-in
 * is a page on the web app, because that is where a page a person looks at
 * belongs; the API has no business rendering a consent screen.
 *
 * The origin is taken from the caller's own redirect URL rather than pinned
 * to localhost, so this still works behind a tunnel, on a preview deployment,
 * or anywhere the web app is not where the fake guessed it would be.
 *
 * The redirect travels in the URL because the stand-in has to send the person
 * back, and that is the half of a hosted flow the gateway cannot be asked to
 * rehearse: leave the site, come back, and the server asks what happened.
 */
function standInUrl(
  redirectUrl: string,
  vendorSessionId: string,
  locale: string,
): string {
  let origin = "http://localhost:3000";
  try {
    origin = new URL(redirectUrl).origin;
  } catch {
    /* A malformed redirect is the caller's problem; the default keeps the
       fake usable rather than throwing inside a test fixture. */
  }

  const url = new URL("/fake-digilocker", origin);
  url.searchParams.set("session", vendorSessionId);
  url.searchParams.set("redirect_url", redirectUrl);
  url.searchParams.set("lang", locale);
  return url.toString();
}

export class FakeKycProvider implements KycProvider {
  readonly name = "fake";

  /** Both are available here; the option decides. See the options type. */
  readonly aadhaarRoute: AadhaarRoute;

  /**
   * The timestamped scheme, which is the stricter of the two: it gives local
   * development the replay window as well as the signature, so neither is
   * discovered to be broken only in staging.
   */
  readonly webhookScheme: WebhookScheme = "hmac-timestamped";

  private readonly secret: string;
  private readonly clock: () => Date;
  private readonly defaultScenario: FakeScenario;

  /**
   * Live OTP challenges, by reference id.
   *
   * In-memory, which is the one place this fake is NOT faithful: a real
   * gateway holds the challenge on its own side, so a second API container
   * could complete a challenge the first one started. Here it cannot. That is
   * acceptable for a stand-in and would not be for an adapter.
   */
  private readonly challenges = new Map<
    string,
    { aadhaarNumber: string; expiresAt: Date }
  >();

  /** Issued sessions, for idempotency only. Not needed to fetch a result. */
  private readonly sessions = new Map<string, KycSession>();
  /** Idempotency key -> vendor session id. */
  private readonly byIdempotencyKey = new Map<string, string>();

  constructor(options: FakeKycProviderOptions) {
    this.aadhaarRoute = options.aadhaarRoute ?? "OTP";
    if (!options.webhookSecret) {
      throw new Error(
        "FakeKycProvider: a webhook secret is required. Running without one would let local development skip signature verification entirely.",
      );
    }
    this.secret = options.webhookSecret;
    this.clock = options.clock ?? (() => new Date());
    this.defaultScenario = options.defaultScenario ?? "pass";
  }

  async createSession(request: CreateSessionRequest): Promise<KycSession> {
    const scenario = request.testScenario ?? this.defaultScenario;

    if (scenario === "vendor_timeout") {
      throw new VendorTimeoutError(this.name, 8000);
    }

    /** Idempotency: the same key always returns the first session. */
    const existingId = this.byIdempotencyKey.get(request.idempotencyKey);
    if (existingId) {
      const existing = this.sessions.get(existingId);
      if (existing) return existing;
    }

    const now = this.clock();
    const vendorSessionId =
      `fake_sess_${SCENARIO_CODES[scenario]}_` +
      randomUUID().replace(/-/g, "").slice(0, 16);

    const session: KycSession = {
      vendorSessionId,
      /**
       * Scoped to this one session and short-lived. Our API key stays on the
       * server; this is all the browser ever holds.
       */
      clientToken: `fake_tok_${createHmac("sha256", this.secret)
        .update(vendorSessionId)
        .digest("hex")
        .slice(0, 32)}`,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MINUTES * 60 * 1000),
      hostedUrl: standInUrl(request.redirectUrl, vendorSessionId, request.locale),
    };

    /**
     * Only the idempotency map is kept, and only as an optimisation inside
     * this process. The real guard against a duplicate session is the unique
     * index on `kyc_records.vendor_session_id`, which every task shares.
     */
    this.sessions.set(vendorSessionId, session);
    this.byIdempotencyKey.set(request.idempotencyKey, vendorSessionId);

    return session;
  }

  /* ---------------------------------------------------------------- */
  /* Aadhaar OTP                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * "Sends" an OTP. Nothing is sent anywhere.
   *
   * The number is checked with the real Verhoeff validator first, because a
   * mistyped Aadhaar has to fail the same way here as it will against UIDAI —
   * otherwise the first real typo is discovered in production.
   *
   * The last digit selects the outcome, so a developer can reach every branch
   * without a vendor account:
   *   ...0  the OTP will be refused as wrong
   *   ...1  the challenge is already expired
   *   else  a well-formed challenge that accepts 123456
   */
  async sendAadhaarOtp(aadhaarNumber: string): Promise<AadhaarOtpChallenge> {
    const digits = aadhaarNumber.replace(/\D/g, "");

    if (!isValidAadhaarNumber(digits)) {
      throw new VendorRequestError(
        "fake",
        "That Aadhaar number is not valid. Please check the twelve digits and try again.",
      );
    }

    const referenceId = `fake-otp-${randomUUID()}`;
    const minutes = digits.endsWith("1") ? -1 : 10;

    this.challenges.set(referenceId, {
      aadhaarNumber: digits,
      expiresAt: new Date(this.clock().getTime() + minutes * 60_000),
    });

    return {
      referenceId,
      /** Masked by the gateway. We are never told the whole number. */
      sentTo: `XXXXXX${digits.slice(-4)}`,
      last4: digits.slice(-4),
    };
  }

  /**
   * Checks an OTP against a challenge.
   *
   * Accepts 123456 and nothing else, which is stated in the development notes
   * rather than guessable — a fake that accepted anything would make the OTP
   * step look like it worked while testing nothing.
   */
  async verifyAadhaarOtp(referenceId: string, otp: string): Promise<AadhaarOtpResult> {
    const challenge = this.challenges.get(referenceId);

    if (!challenge) {
      throw new VendorRequestError(
        "fake",
        "That verification attempt is no longer valid. Please request a new OTP.",
      );
    }

    if (challenge.expiresAt.getTime() <= this.clock().getTime()) {
      this.challenges.delete(referenceId);
      throw new VendorRequestError("fake", "That OTP has expired. Please request a new one.");
    }

    /**
     * A number ending in 9 makes the gateway fall over on verification.
     *
     * The other markers all produce a gateway that answered — an expired
     * challenge, a wrong OTP — and there was no way to produce one that did
     * not answer at all. So the branch where the OTP is never adjudicated
     * went untested, and it was wrong: it spent one of the three attempts on
     * a gateway outage. The real gateway did exactly this, returning 503
     * "Source Unavailable", three times over.
     *
     * The challenge is deliberately left in place. Nothing was checked, so
     * nothing has been used up, and the same OTP must still work afterwards —
     * which is the half of the behaviour worth asserting.
     */
    if (challenge.aadhaarNumber.endsWith("9")) {
      throw new VendorTimeoutError(this.name, 8000);
    }

    if (challenge.aadhaarNumber.endsWith("0") || otp !== "123456") {
      /**
       * The challenge is deliberately NOT deleted on a wrong OTP: UIDAI allows
       * a few attempts against one challenge, and deleting it here would make
       * the fake stricter than the real thing in a way that hides a retry bug.
       */
      throw new VendorRequestError("fake", "That OTP is not correct. Please check and try again.");
    }

    this.challenges.delete(referenceId);
    const last4 = challenge.aadhaarNumber.slice(-4);

    return {
      status: "SUCCESS",
      /** Deterministic from the number, so repeated runs are comparable. */
      nameOnRecord: NAMES[Number(last4) % NAMES.length]!,
      dateOfBirth: "1986-04-17",
      refToken: `fake-ref-${last4}`,
    };
  }

  async fetchResult(vendorSessionId: string): Promise<VendorKycResult> {
    const scenario = this.scenarioOf(vendorSessionId);
    if (!scenario) {
      throw new Error(
        `FakeKycProvider: unknown session ${vendorSessionId} — not a fake session id. ` +
          "A result is never invented for a session we did not issue.",
      );
    }
    if (scenario === "vendor_timeout") {
      throw new VendorTimeoutError(this.name, 8000);
    }
    return this.resultFor(vendorSessionId, scenario);
  }

  /**
   * Builds a webhook the real verifier accepts.
   *
   * The body announces that a result is ready. It carries no status, because
   * the vendor does not decide the status — our server fetches the result and
   * `decideKyc()` decides. A webhook body that contained "VERIFIED" would be
   * an invitation to trust it.
   */
  async buildWebhook(vendorSessionId: string): Promise<FakeWebhook> {
    const scenario = this.scenarioOf(vendorSessionId);
    if (!scenario) {
      throw new Error(`FakeKycProvider: unknown session ${vendorSessionId}`);
    }

    const now = this.clock();
    const unixSeconds = Math.floor(now.getTime() / 1000);

    const rawBody = JSON.stringify({
      event: "kyc.session.completed",
      eventId: this.eventIdFor(vendorSessionId),
      sessionId: vendorSessionId,
      vendor: this.name,
      occurredAt: now.toISOString(),
    });

    const signature = createHmac("sha256", this.secret)
      .update(`${unixSeconds}.${rawBody}`, "utf8")
      .digest("hex");

    return {
      rawBody,
      signatureHeader: `t=${unixSeconds},v1=${signature}`,
      delaySeconds: scenario === "late_webhook" ? LATE_WEBHOOK_DELAY_SECONDS : 0,
    };
  }

  /**
   * Which scenario a session is for, read off the id itself.
   *
   * Works for a session this instance never issued, which is the whole point:
   * the worker's reconciliation job asks about sessions the API opened.
   */
  scenarioOf(vendorSessionId: string): FakeScenario | undefined {
    const match = SESSION_ID_PATTERN.exec(vendorSessionId);
    return match ? SCENARIO_BY_CODE[match[1]!] : undefined;
  }

  /**
   * Derived, not generated, so every process computes the same event id.
   *
   * It has to be stable: it is the key replay protection de-duplicates on, and
   * a per-process random id would make the worker's delivery look like a
   * different event from the API's.
   */
  private eventIdFor(vendorSessionId: string): string {
    return (
      "fake_evt_" +
      createHmac("sha256", this.secret)
        .update(`event:${vendorSessionId}`)
        .digest("hex")
        .slice(0, 16)
    );
  }

  /**
   * A distinct, well-formed PAN per session.
   *
   * It used to return one fixed PAN for everybody, which was wrong in a way
   * that only showed up once there were two cases: `kyc_records` has a unique
   * index on the PAN blind index, so the second person to verify collided with
   * the first and the request failed. The constraint was right — two people
   * genuinely cannot share a PAN — the fake was lying.
   *
   * Derived rather than random, so the same session always produces the same
   * PAN and a decision stays reproducible.
   *
   * Shape: five letters, four digits, one letter, with the 4th character 'P'
   * for an individual, which is what Investors and Land Owners must be.
   */
  private panFor(vendorSessionId: string): string {
    const digest = createHmac("sha256", this.secret)
      .update(`pan:${vendorSessionId}`)
      .digest();

    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const letter = (i: number) => letters[digest[i]! % 26]!;
    const digit = (i: number) => String(digest[i]! % 10);

    return (
      letter(0) +
      letter(1) +
      letter(2) +
      "P" +
      letter(3) +
      digit(4) +
      digit(5) +
      digit(6) +
      digit(7) +
      letter(8)
    );
  }

  /* ---------------------------------------------------------------- */

  /**
   * Vendor-shaped facts for a scenario.
   *
   * The Aadhaar number is never present — not even in the fake. A fixture that
   * carried one would eventually be copied into a log line or a test snapshot,
   * and the rule is that the number does not exist in our systems at all.
   */
  private resultFor(
    vendorSessionId: string,
    scenario: FakeScenario,
  ): VendorKycResult {
    const base = {
      vendorSessionId,
      vendor: this.name,
      vendorVersion: "fake-1.0.0",
      eventId: this.eventIdFor(vendorSessionId),
      rawResponseKey: `kyc-docs/raw/${vendorSessionId}.json`,
      completedAt: this.clock(),
    };

    const aadhaarOk = {
      status: "SUCCESS" as const,
      nameOnRecord: "Ramesh Kumar Sharma",
      dateOfBirth: "1979-03-14",
      last4: "7731",
      refToken: `fake_ref_${vendorSessionId.slice(-12)}`,
    };

    const pan = this.panFor(vendorSessionId);

    const panOk = {
      status: "VALID" as const,
      nameMatch: true,
      dobMatch: true,
      linkedToAadhaar: true,
      pan,
    };

    const selfieOk = { livenessPassed: true, faceMatchScore: 0.91 };

    switch (scenario) {
      case "pass":
      case "late_webhook":
        return { ...base, aadhaar: aadhaarOk, pan: panOk, selfie: selfieOk };

      case "low_face_score":
        return {
          ...base,
          aadhaar: aadhaarOk,
          pan: panOk,
          /** An Aadhaar photo from 2013, which is the usual cause. */
          selfie: { livenessPassed: true, faceMatchScore: 0.68 },
        };

      case "liveness_fail":
        return {
          ...base,
          aadhaar: aadhaarOk,
          pan: panOk,
          selfie: { livenessPassed: false, faceMatchScore: 0.88 },
        };

      case "pan_name_mismatch":
        return {
          ...base,
          aadhaar: { ...aadhaarOk, nameOnRecord: "Priya Nair" },
          pan: { ...panOk, nameMatch: false },
          selfie: selfieOk,
        };

      case "pan_inoperative":
        return {
          ...base,
          aadhaar: aadhaarOk,
          pan: { ...panOk, linkedToAadhaar: false },
          selfie: selfieOk,
        };

      case "pan_deactivated":
        return {
          ...base,
          aadhaar: aadhaarOk,
          pan: {
            status: "DEACTIVATED",
            nameMatch: false,
            dobMatch: false,
            linkedToAadhaar: false,
            pan,
          },
          selfie: selfieOk,
        };

      case "minor":
        return {
          ...base,
          aadhaar: {
            ...aadhaarOk,
            nameOnRecord: "Aarav Sharma",
            dateOfBirth: "2009-06-01",
            last4: "4412",
          },
          pan: panOk,
          selfie: selfieOk,
        };

      case "aadhaar_failed":
        /** DigiLocker down, or the mobile is not linked to the Aadhaar. */
        return {
          ...base,
          aadhaar: { status: "FAILED" },
          pan: panOk,
          selfie: selfieOk,
        };

      case "vendor_timeout":
        throw new VendorTimeoutError(this.name, 8000);
    }
  }
}
