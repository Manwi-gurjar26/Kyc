import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import { verifyWebhook } from "./webhookVerifier.js";
import type {
  VerifyWebhookResult,
  WebhookRejection,
} from "./webhookVerifier.js";

/**
 * Asserts the result is a rejection and returns its reason.
 *
 * VerifyWebhookResult is a discriminated union, so `reason` only exists on the
 * invalid branch. expect() cannot narrow a union, so the narrowing happens
 * here once instead of being cast away at every call site.
 */
function rejectionOf(result: VerifyWebhookResult): WebhookRejection {
  if (result.valid) {
    throw new Error("expected the webhook to be rejected, but it verified");
  }
  return result.reason;
}

const SECRET = "whsec_test_8f2b1c4d9e7a3f5b";
const BODY = JSON.stringify({
  event: "kyc.completed",
  id: "evt_01HQZX",
  data: { sessionId: "sess_4471", status: "auto_approved" },
});

function bodySignature(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function timestampedHeader(body: string, unixSeconds: number, secret = SECRET): string {
  const signed = createHmac("sha256", secret)
    .update(`${unixSeconds}.${body}`, "utf8")
    .digest("hex");
  return `t=${unixSeconds},v1=${signed}`;
}

const NOW = new Date("2026-10-08T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

/* ------------------------------------------------------------------ */
/* Scheme: hmac-body (signature over the raw body, no timestamp)       */
/* ------------------------------------------------------------------ */

describe("verifyWebhook — hmac-body scheme", () => {
  test("accepts a correctly signed body", () => {
    const result = verifyWebhook({
      scheme: "hmac-body",
      rawBody: BODY,
      signatureHeader: bodySignature(BODY),
      secret: SECRET,
      now: NOW,
    });
    expect(result.valid).toBe(true);
  });

  test("rejects a body that was altered after signing", () => {
    const signature = bodySignature(BODY);
    const tampered = BODY.replace("auto_approved", "manual_review");

    const result = verifyWebhook({
      scheme: "hmac-body",
      rawBody: tampered,
      signatureHeader: signature,
      secret: SECRET,
      now: NOW,
    });
    expect(rejectionOf(result)).toBe("SIGNATURE_MISMATCH");
  });

  test("rejects a signature made with a different secret", () => {
    const result = verifyWebhook({
      scheme: "hmac-body",
      rawBody: BODY,
      signatureHeader: bodySignature(BODY, "whsec_the_wrong_one"),
      secret: SECRET,
      now: NOW,
    });
    expect(rejectionOf(result)).toBe("SIGNATURE_MISMATCH");
  });

  test("accepts uppercase hex, since vendors differ on casing", () => {
    const result = verifyWebhook({
      scheme: "hmac-body",
      rawBody: BODY,
      signatureHeader: bodySignature(BODY).toUpperCase(),
      secret: SECRET,
      now: NOW,
    });
    expect(result.valid).toBe(true);
  });

  /**
   * A short or truncated signature must be rejected cleanly. A naive
   * timingSafeEqual on buffers of different lengths throws, and a handler that
   * throws on malformed input is a denial-of-service lever.
   */
  test("rejects a truncated signature without throwing", () => {
    const result = verifyWebhook({
      scheme: "hmac-body",
      rawBody: BODY,
      signatureHeader: bodySignature(BODY).slice(0, 32),
      secret: SECRET,
      now: NOW,
    });
    expect(rejectionOf(result)).toBe("MALFORMED_SIGNATURE");
  });

  test("rejects a non-hex signature without throwing", () => {
    const result = verifyWebhook({
      scheme: "hmac-body",
      rawBody: BODY,
      signatureHeader: "not-a-signature",
      secret: SECRET,
      now: NOW,
    });
    expect(rejectionOf(result)).toBe("MALFORMED_SIGNATURE");
  });

  test("rejects an empty signature header", () => {
    const result = verifyWebhook({
      scheme: "hmac-body",
      rawBody: BODY,
      signatureHeader: "",
      secret: SECRET,
      now: NOW,
    });
    expect(rejectionOf(result)).toBe("MISSING_SIGNATURE");
  });
});

/* ------------------------------------------------------------------ */
/* Scheme: hmac-timestamped (t=...,v1=... — replay window built in)   */
/* ------------------------------------------------------------------ */

describe("verifyWebhook — hmac-timestamped scheme", () => {
  test("accepts a signature made moments ago", () => {
    const result = verifyWebhook({
      scheme: "hmac-timestamped",
      rawBody: BODY,
      signatureHeader: timestampedHeader(BODY, NOW_SECONDS - 10),
      secret: SECRET,
      now: NOW,
    });
    expect(result.valid).toBe(true);
  });

  test("the timestamp is part of what is signed", () => {
    // Take a valid header and move its timestamp forward without re-signing.
    const header = timestampedHeader(BODY, NOW_SECONDS - 10);
    const forged = header.replace(`t=${NOW_SECONDS - 10}`, `t=${NOW_SECONDS}`);

    const result = verifyWebhook({
      scheme: "hmac-timestamped",
      rawBody: BODY,
      signatureHeader: forged,
      secret: SECRET,
      now: NOW,
    });
    expect(rejectionOf(result)).toBe("SIGNATURE_MISMATCH");
  });

  /**
   * The replay window. A captured request replayed an hour later is signed
   * perfectly correctly — only the age gives it away.
   */
  test("rejects a correctly signed request that is too old", () => {
    const result = verifyWebhook({
      scheme: "hmac-timestamped",
      rawBody: BODY,
      signatureHeader: timestampedHeader(BODY, NOW_SECONDS - 3600),
      secret: SECRET,
      now: NOW,
      toleranceSeconds: 300,
    });
    expect(rejectionOf(result)).toBe("TIMESTAMP_OUTSIDE_TOLERANCE");
  });

  test("accepts a request right at the edge of the tolerance", () => {
    const result = verifyWebhook({
      scheme: "hmac-timestamped",
      rawBody: BODY,
      signatureHeader: timestampedHeader(BODY, NOW_SECONDS - 300),
      secret: SECRET,
      now: NOW,
      toleranceSeconds: 300,
    });
    expect(result.valid).toBe(true);
  });

  test("rejects a request one second past the tolerance", () => {
    const result = verifyWebhook({
      scheme: "hmac-timestamped",
      rawBody: BODY,
      signatureHeader: timestampedHeader(BODY, NOW_SECONDS - 301),
      secret: SECRET,
      now: NOW,
      toleranceSeconds: 300,
    });
    expect(rejectionOf(result)).toBe("TIMESTAMP_OUTSIDE_TOLERANCE");
  });

  /**
   * A timestamp far in the future is not a clock-skew problem, it is someone
   * trying to mint a request that stays valid for hours.
   */
  test("rejects a timestamp far in the future", () => {
    const result = verifyWebhook({
      scheme: "hmac-timestamped",
      rawBody: BODY,
      signatureHeader: timestampedHeader(BODY, NOW_SECONDS + 3600),
      secret: SECRET,
      now: NOW,
      toleranceSeconds: 300,
    });
    expect(rejectionOf(result)).toBe("TIMESTAMP_OUTSIDE_TOLERANCE");
  });

  test("tolerates small clock skew in both directions", () => {
    for (const offset of [-30, -5, 0, 5, 30]) {
      const result = verifyWebhook({
        scheme: "hmac-timestamped",
        rawBody: BODY,
        signatureHeader: timestampedHeader(BODY, NOW_SECONDS + offset),
        secret: SECRET,
        now: NOW,
        toleranceSeconds: 300,
      });
      expect(result.valid, `offset ${offset}s should be accepted`).toBe(true);
    }
  });

  test("rejects a header with no v1 component", () => {
    const result = verifyWebhook({
      scheme: "hmac-timestamped",
      rawBody: BODY,
      signatureHeader: `t=${NOW_SECONDS}`,
      secret: SECRET,
      now: NOW,
    });
    expect(rejectionOf(result)).toBe("MALFORMED_SIGNATURE");
  });

  test("rejects a header with no timestamp", () => {
    const result = verifyWebhook({
      scheme: "hmac-timestamped",
      rawBody: BODY,
      signatureHeader: `v1=${bodySignature(BODY)}`,
      secret: SECRET,
      now: NOW,
    });
    expect(rejectionOf(result)).toBe("MALFORMED_SIGNATURE");
  });

  test("rejects a non-numeric timestamp", () => {
    const result = verifyWebhook({
      scheme: "hmac-timestamped",
      rawBody: BODY,
      signatureHeader: `t=yesterday,v1=${bodySignature(BODY)}`,
      secret: SECRET,
      now: NOW,
    });
    expect(rejectionOf(result)).toBe("MALFORMED_SIGNATURE");
  });

  /** Vendors add their own fields; unknown ones must not break parsing. */
  test("ignores extra components in the header", () => {
    const base = timestampedHeader(BODY, NOW_SECONDS);
    const result = verifyWebhook({
      scheme: "hmac-timestamped",
      rawBody: BODY,
      signatureHeader: `${base},v0=legacy,region=ap-south-1`,
      secret: SECRET,
      now: NOW,
    });
    expect(result.valid).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe("verifyWebhook — refusing to run unsafely", () => {
  test("throws when no secret is configured, rather than accepting everything", () => {
    expect(() =>
      verifyWebhook({
        scheme: "hmac-body",
        rawBody: BODY,
        signatureHeader: bodySignature(BODY),
        secret: "",
        now: NOW,
      }),
    ).toThrow(/secret/i);
  });

  /**
   * The signature covers the exact bytes the vendor sent. Verifying a
   * re-serialised object instead of the raw body is the classic way this check
   * silently stops working, so an empty body is called out explicitly.
   */
  test("rejects an empty body", () => {
    const result = verifyWebhook({
      scheme: "hmac-body",
      rawBody: "",
      signatureHeader: bodySignature(""),
      secret: SECRET,
      now: NOW,
    });
    expect(rejectionOf(result)).toBe("EMPTY_BODY");
  });
});
