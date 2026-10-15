import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook signature verification.
 *
 * This is the trust boundary. The vendor's webhook is the only thing that
 * moves a KYC record to VERIFIED. If this function is wrong, anyone who can
 * reach the endpoint can verify themselves.
 *
 * Two rules it exists to enforce:
 *   1. the request really came from the vendor (signature)
 *   2. it is not a captured request being sent again (replay window)
 *
 * Replay also needs the event id to be remembered — that is `ReplayGuard`,
 * which is a database concern and lives separately.
 *
 * IMPORTANT: verify the RAW request body, byte for byte. Re-serialising the
 * parsed JSON and signing that will pass in development and fail in
 * production the first time a vendor changes key order or whitespace. The
 * NestJS controller keeps the raw buffer for this reason.
 */

export type WebhookScheme =
  /** Signature is HMAC-SHA256 over the raw body, with no timestamp. */
  | "hmac-body"
  /** Header is `t=<unix>,v1=<hex>`; the signature covers `${t}.${body}`. */
  | "hmac-timestamped";

export type WebhookRejection =
  | "MISSING_SIGNATURE"
  | "MALFORMED_SIGNATURE"
  | "SIGNATURE_MISMATCH"
  | "TIMESTAMP_OUTSIDE_TOLERANCE"
  | "EMPTY_BODY";

export interface VerifyWebhookOptions {
  scheme: WebhookScheme;
  /** The exact bytes received, not a re-serialised object. */
  rawBody: string;
  /** The vendor's signature header, verbatim. */
  signatureHeader: string;
  secret: string;
  now: Date;
  /** How far the signing timestamp may be from now. Default 5 minutes. */
  toleranceSeconds?: number;
}

export type VerifyWebhookResult =
  | { valid: true; signedAt?: Date }
  | { valid: false; reason: WebhookRejection };

/** Five minutes, the window most vendors use. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

const HEX_64 = /^[0-9a-f]{64}$/;

function reject(reason: WebhookRejection): VerifyWebhookResult {
  return { valid: false, reason };
}

/**
 * Constant-time comparison of two hex digests.
 *
 * Both are normalised to lowercase and length-checked first, because
 * timingSafeEqual throws on differing lengths — and a throw here would turn a
 * malformed header into a 500, which is both a worse signal and a way to make
 * the endpoint fall over.
 */
function digestsMatch(expectedHex: string, providedHex: string): boolean {
  const provided = providedHex.trim().toLowerCase();
  if (!HEX_64.test(provided)) return false;
  return timingSafeEqual(
    Buffer.from(expectedHex, "hex"),
    Buffer.from(provided, "hex"),
  );
}

/** Parses `t=123,v1=abc,other=x` into a map, ignoring unknown components. */
function parseComponents(header: string): Map<string, string> {
  const components = new Map<string, string>();
  for (const part of header.split(",")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key && value && !components.has(key)) {
      components.set(key, value);
    }
  }
  return components;
}

function hmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/**
 * Verifies a vendor webhook.
 *
 * Returns a result rather than throwing, so the controller can log the precise
 * reason and answer 401 — except for a missing secret, which is a deployment
 * fault and must be loud.
 */
export function verifyWebhook(options: VerifyWebhookOptions): VerifyWebhookResult {
  const {
    scheme,
    rawBody,
    signatureHeader,
    secret,
    now,
    toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  } = options;

  /**
   * An unset secret must never degrade into "accept anything". Throwing here
   * fails the deploy's smoke test instead of quietly opening the endpoint.
   */
  if (!secret) {
    throw new Error(
      "verifyWebhook: no signing secret configured. Load it from the secret store before serving webhooks.",
    );
  }

  if (!signatureHeader || signatureHeader.trim() === "") {
    return reject("MISSING_SIGNATURE");
  }

  if (rawBody === "") {
    return reject("EMPTY_BODY");
  }

  if (scheme === "hmac-body") {
    const provided = signatureHeader.trim();
    if (!HEX_64.test(provided.toLowerCase())) {
      return reject("MALFORMED_SIGNATURE");
    }
    return digestsMatch(hmacHex(secret, rawBody), provided)
      ? { valid: true }
      : reject("SIGNATURE_MISMATCH");
  }

  // hmac-timestamped
  const components = parseComponents(signatureHeader);
  const timestampRaw = components.get("t");
  const provided = components.get("v1");

  if (!timestampRaw || !provided) {
    return reject("MALFORMED_SIGNATURE");
  }
  if (!/^[0-9]+$/.test(timestampRaw)) {
    return reject("MALFORMED_SIGNATURE");
  }
  if (!HEX_64.test(provided.toLowerCase())) {
    return reject("MALFORMED_SIGNATURE");
  }

  const signedAtSeconds = Number(timestampRaw);
  const nowSeconds = Math.floor(now.getTime() / 1000);

  /**
   * Absolute difference, so a timestamp in the future is rejected too. A
   * future-dated signature is not clock skew — it is an attempt to mint a
   * request that stays valid long after it was captured.
   */
  if (Math.abs(nowSeconds - signedAtSeconds) > toleranceSeconds) {
    return reject("TIMESTAMP_OUTSIDE_TOLERANCE");
  }

  const expected = hmacHex(secret, `${signedAtSeconds}.${rawBody}`);
  if (!digestsMatch(expected, provided)) {
    return reject("SIGNATURE_MISMATCH");
  }

  return { valid: true, signedAt: new Date(signedAtSeconds * 1000) };
}
