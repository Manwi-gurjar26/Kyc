import type {
  AadhaarResult,
  GstResult,
  KycLevel,
  PanResult,
  SelfieResult,
} from "@kilowattx/core";
import type { WebhookScheme } from "./webhookVerifier.js";

/**
 * Vendor interfaces.
 *
 * Business code calls these, never a vendor SDK directly. That is what makes
 * three things possible: swapping HyperVerge for Digio without touching the
 * API, running the whole flow against a fake in tests and local development,
 * and failing over when a vendor is down.
 *
 * It also means the Aadhaar route decision — DigiLocker, OVSE, or OTP eKYC —
 * is a KycProvider implementation detail. Legal can still be deciding it while
 * the rest of the system is built and tested.
 */

/* ------------------------------------------------------------------ */
/* Errors                                                             */
/* ------------------------------------------------------------------ */

/** Base for anything a vendor adapter throws, so callers can catch one type. */
export class VendorError extends Error {
  constructor(
    message: string,
    readonly vendor: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "VendorError";
  }
}

/** The vendor did not answer in time. Retryable, and trips the breaker. */
export class VendorTimeoutError extends VendorError {
  constructor(vendor: string, readonly timeoutMs: number) {
    super(`${vendor} did not respond within ${timeoutMs}ms`, vendor, true);
    this.name = "VendorTimeoutError";
  }
}

/** The vendor rejected the request. Not retryable — the input is wrong. */
export class VendorRequestError extends VendorError {
  constructor(vendor: string, message: string, readonly statusCode?: number) {
    super(message, vendor, false);
    this.name = "VendorRequestError";
  }
}

/* ------------------------------------------------------------------ */
/* KYC: Aadhaar, PAN, selfie                                          */
/* ------------------------------------------------------------------ */

/**
 * Every KYC gateway this system can be pointed at.
 *
 * Declared once, here, because it was declared twice and the two drifted: the
 * API gained "sandbox" while the worker still listed "surepass", so selecting
 * the real gateway brought the API up and left the worker refusing to start —
 * no outbox drain, no reconciliation, and an API that looked perfectly
 * healthy. Both config schemas now read this array, so the next value can only
 * be added in one place.
 */
export const KYC_PROVIDERS = [
  "fake",
  /** Sandbox's Aadhaar OKYC. Deprecated by UIDAI; see the DigiLocker spec. */
  "sandbox",
  /** Sandbox's DigiLocker flow — the replacement Aadhaar route. */
  "digilocker",
  "cashfree",
] as const;

export type KycProviderName = (typeof KYC_PROVIDERS)[number];

export type KycRole = "INVESTOR" | "LAND_OWNER" | "COMMERCIAL" | "SIGNATORY";

export interface CreateSessionRequest {
  /** Our id for the person, never a name or a phone number. */
  subjectId: string;
  level: KycLevel;
  role: KycRole;
  locale: "en" | "hi";
  /** Where the vendor returns the user once their flow finishes. */
  redirectUrl: string;
  /**
   * Makes session creation safe to retry. A double-clicked button must not
   * open — and bill us for — two vendor sessions.
   */
  idempotencyKey: string;
  /** Local and test only: forces a particular outcome. */
  testScenario?: FakeScenario;
}

export interface KycSession {
  /** The vendor's id for this session. Stored on kyc_records. */
  vendorSessionId: string;
  /**
   * Short-lived token handed to the browser or the SDK.
   *
   * Our vendor API key never leaves the server. This token is scoped to one
   * session and expires in minutes, so a leaked one is worth almost nothing.
   *
   * Optional, because not every hosted flow has one. DigiLocker's
   * authorization URL carries its own state and PKCE challenge, so the URL
   * IS the credential and there is no second token to hand over. Returning
   * the session id here to fill the field would describe it as a short-lived
   * secret, which it is not.
   */
  clientToken?: string;
  expiresAt: Date;
  /**
   * A vendor-hosted web flow, when the vendor offers one.
   *
   * This is what makes assisted KYC possible: staff start a session in the
   * Admin Panel and send this link by WhatsApp, with no app install.
   */
  hostedUrl?: string;
}

/**
 * A vendor result, normalised into our shape by the adapter.
 *
 * Everything needed to re-derive the decision later is carried here, because
 * `decideKyc()` is pure: given this plus the thresholds, a reviewer or an
 * auditor can reproduce the exact outcome eighteen months on.
 */
export interface VendorKycResult {
  vendorSessionId: string;
  vendor: string;
  /** The vendor's model or API version, recorded with every check. */
  vendorVersion: string;
  /** The vendor's own event id, used for replay protection. */
  eventId: string;
  aadhaar?: AadhaarResult & {
    /** The only part of the number we may keep. */
    last4?: string;
    /** The vendor's opaque handle for the verified identity. */
    refToken?: string;
    /**
     * The UIDAI photograph as base64 JPEG, for the selfie comparison.
     * Passed through, never stored by the adapter — the caller puts it in the
     * object store, the same as the OTP route's photo.
     */
    photo?: string;
  };
  pan?: PanResult & {
    /** Returned so we can encrypt and blind-index it. Never logged. */
    pan?: string;
  };
  selfie?: SelfieResult;
  /** Object-store key of the raw vendor response, stored encrypted. */
  rawResponseKey: string;
  completedAt: Date;
}

/**
 * What comes back from asking a gateway to send an Aadhaar OTP.
 *
 * `sentTo` is masked by the gateway before it reaches us. We are not told the
 * registered mobile number, only enough of it for the person to recognise
 * which handset to look at.
 */
export interface AadhaarOtpChallenge {
  /** The gateway handle for this attempt. Expires, usually in minutes. */
  referenceId: string;
  /** Masked, e.g. "XXXXXX7731". Never the full number. */
  sentTo: string;
  /**
   * The last four digits, captured here rather than at verification.
   *
   * This moved after reading a real gateway's documentation. Their verify
   * response returns the name, date of birth, address and photo — and no
   * Aadhaar number at all, which is correct of them and exactly what our own
   * schema assumes. But it means an adapter physically cannot produce the
   * last four at that point.
   *
   * The number IS in hand one step earlier, when the OTP is requested. So it
   * is taken there. The alternative — an adapter keeping a reference-id to
   * number map in memory — would have broken the moment there were two API
   * containers, and would have kept Aadhaar numbers in process memory for the
   * life of a challenge, which is precisely what we avoid everywhere else.
   */
  last4: string;
}

/**
 * The result of submitting the OTP.
 *
 * Note what is absent: the Aadhaar number. A gateway returns the demographic
 * record and a reference token, and the number itself is never persisted —
 * there is no column in this system that could hold one.
 */
export interface AadhaarOtpResult extends AadhaarResult {
  /**
   * The gateway's handle for this verification, kept for the audit trail.
   *
   * Not the Aadhaar number and not derived from it: it is what we quote back
   * to the vendor when somebody asks, eighteen months later, what we checked
   * and when.
   */
  refToken: string;
  /**
   * The UIDAI photograph, as the gateway returned it — usually a data URL.
   *
   * Carried because the comparison against a selfie has to be made by a
   * person: no gateway this system can reach sells a face match, so the only
   * face check available is a reviewer looking at two images. Without this
   * one there is nothing to look at.
   *
   * Passed through, never stored by the adapter. The caller decides where the
   * bytes go, and it puts them in the object store rather than a column.
   */
  photo?: string;
  /**
   * Why the gateway said no, in its own words. Only set on a FAILED status.
   *
   * Without it a failed check is indistinguishable from every other failed
   * check, and the only message we could honestly show was "check the number"
   * — which sends somebody to re-read the twelve digits they typed correctly
   * when the real answer was a wrong OTP or an expired reference. Carries a
   * status and a sentence, never demographic data.
   */
  failureReason?: string;
}

/**
 * How a gateway collects an Aadhaar.
 *
 * "OTP"    — we take the number, the gateway sends a code, we send it back.
 * "HOSTED" — the person goes to the gateway's own site and we never see a
 *            number at all.
 *
 * Declared by each adapter rather than inferred from its name, because the
 * screen a person sees differs entirely between the two and the web has to
 * know which to render. Guessing from a provider string would mean every new
 * adapter silently falls into whichever branch the comparison happens to
 * miss — and the one that renders an Aadhaar number field for a gateway that
 * must never receive one is the wrong way to be wrong.
 */
export type AadhaarRoute = "OTP" | "HOSTED";

export interface KycProvider {
  readonly name: string;
  /** How this vendor signs its webhooks. */
  readonly webhookScheme: WebhookScheme;
  /** Which Aadhaar journey this gateway supports. See AadhaarRoute. */
  readonly aadhaarRoute: AadhaarRoute;

  createSession(request: CreateSessionRequest): Promise<KycSession>;

  /**
   * Asks the gateway to send an OTP to the mobile registered against an
   * Aadhaar number.
   *
   * Two round trips rather than one, because that is what Aadhaar eKYC is:
   * UIDAI sends a one-time password to the registered mobile, and the person
   * typing it back IS the consent. A single call that took a number and
   * returned a verdict would be verifying a number somebody typed, not a
   * person who holds it.
   */
  sendAadhaarOtp(aadhaarNumber: string): Promise<AadhaarOtpChallenge>;

  /** Submits the OTP against the challenge and returns the record. */
  verifyAadhaarOtp(referenceId: string, otp: string): Promise<AadhaarOtpResult>;

  /**
   * Fetches the full result server-to-server.
   *
   * Called after a webhook arrives, and never trusting the webhook body for
   * the result itself — the webhook is a notification that something is ready,
   * not the thing itself.
   */
  fetchResult(vendorSessionId: string): Promise<VendorKycResult>;
}

/* ------------------------------------------------------------------ */
/* KYB: GST, CIN, PAN lookup                                          */
/* ------------------------------------------------------------------ */

export interface GstLookupResult {
  gstin: string;
  legalName: string;
  tradeName?: string;
  status: GstResult["status"];
  /** Pvt Ltd, LLP, Partnership, Proprietorship... */
  constitution: string;
  registeredOn: string;
  registeredAddress: string;
  stateCode: string;
}

export interface CinLookupResult {
  cin: string;
  companyName: string;
  status: "ACTIVE" | "STRUCK_OFF" | "UNDER_LIQUIDATION" | "DORMANT";
  incorporatedOn: string;
  directors: string[];
}

export interface PanVerifyRequest {
  pan: string;
  /** Taken from Aadhaar, never from what the user typed. */
  name: string;
  /** ISO date. Date of incorporation for a business PAN. */
  dateOfBirth: string;
}

export interface KybProvider {
  readonly name: string;
  /** Runs on the Income Tax Department's authorised channel (Protean). */
  verifyPan(request: PanVerifyRequest): Promise<PanResult>;
  lookupGstin(gstin: string): Promise<GstLookupResult>;
  lookupCin(cin: string): Promise<CinLookupResult>;
}

/* ------------------------------------------------------------------ */
/* Documents: virus scanning and OCR extraction                       */
/* ------------------------------------------------------------------ */

/**
 * Mirrors the `document_type` enum in the database.
 *
 * Declared here rather than imported so this package stays free of a
 * dependency on the schema — an adapter has no business knowing how its
 * inputs are stored.
 */
export type DocumentType =
  | "SELFIE"
  | "GST_CERTIFICATE"
  | "SALE_DEED"
  | "JAMABANDI"
  | "KHASRA_KHATAUNI"
  | "MUTATION_RECORD"
  | "BOARD_RESOLUTION"
  | "AUTHORISATION_LETTER"
  | "PARTNERSHIP_DEED"
  | "UDYAM_CERTIFICATE"
  | "OTHER";

/**
 * The outcome of a virus scan.
 *
 * Three outcomes, not two. A scanner that could not be reached has found
 * nothing, which is not the same as having found nothing wrong: collapsing
 * ERRORED into CLEAN means an outage silently admits every file uploaded
 * during it.
 */
export interface ScanResult {
  status: "CLEAN" | "INFECTED" | "ERRORED";
  /** The signature name on a match, for the quarantine record. */
  signature?: string;
  /** Why the scan could not be completed, when it could not. */
  error?: string;
  scannedAt: Date;
}

export interface DocumentScanner {
  scan(params: { key: string }): Promise<ScanResult>;
}

/**
 * One field read off a document, with how sure the reader is.
 *
 * The confidence is the point. OCR on a faded 1970s Jamabandi is frequently
 * wrong, and a value without a confidence invites the caller to trust it —
 * which is how a mistyped khasra number ends up on a registered lease.
 */
export interface ExtractedField {
  value: string;
  /** 0 to 1. Extraction services usually report percentages; adapters normalise. */
  confidence: number;
}

export interface ExtractionResult {
  /** Empty when there was nothing to read — a selfie, or a blank scan. */
  fields: Record<string, ExtractedField>;
  extractedAt: Date;
}

export interface DocumentExtractor {
  extract(params: { key: string; docType: DocumentType }): Promise<ExtractionResult>;
}

/* ------------------------------------------------------------------ */
/* Test scenarios                                                     */
/* ------------------------------------------------------------------ */

/**
 * The outcomes the fake adapters can produce.
 *
 * These are the cases the guide names, plus the ones that turned out to matter
 * while building the decision function. Every one of them is a real situation
 * support will see.
 */
export const FAKE_SCENARIOS = [
  /** Everything passes. */
  "pass",
  /** Aadhaar photo is old; face match lands under the threshold. */
  "low_face_score",
  /** Liveness fails — a photo of a photo, or bad light. */
  "liveness_fail",
  /** PAN is valid but the name does not match (marriage name change). */
  "pan_name_mismatch",
  /** PAN is not linked to Aadhaar — flagged for TDS, not blocked. */
  "pan_inoperative",
  /** PAN has been deactivated by the Income Tax Department. Hard fail. */
  "pan_deactivated",
  /** Aadhaar date of birth makes the subject a minor. Hard fail. */
  "minor",
  /** DigiLocker is down; Aadhaar does not come back. */
  "aadhaar_failed",
  /** The vendor does not answer at all. */
  "vendor_timeout",
  /** The result is ready but the webhook arrives late, after a reminder. */
  "late_webhook",
] as const;

export type FakeScenario = (typeof FAKE_SCENARIOS)[number];
