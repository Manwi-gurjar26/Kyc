import { DEFAULT_KYC_THRESHOLDS, decideKyc } from "@kilowattx/core";
import { beforeEach, describe, expect, test } from "vitest";
import { FakeKycProvider } from "./fakeKycProvider.js";
import {
  VendorTimeoutError,
  type CreateSessionRequest,
  type FakeScenario,
} from "./providers.js";
import { verifyWebhook } from "./webhookVerifier.js";

const NOW = new Date("2026-10-08T12:00:00.000Z");
const SECRET = "whsec_fake_local_dev";

function request(overrides: Partial<CreateSessionRequest> = {}): CreateSessionRequest {
  return {
    subjectId: "usr_01HQZX",
    level: "FULL",
    role: "LAND_OWNER",
    locale: "en",
    redirectUrl: "http://localhost:3000/kyc/return",
    idempotencyKey: "idem_0001",
    ...overrides,
  };
}

let provider: FakeKycProvider;

beforeEach(() => {
  provider = new FakeKycProvider({
    webhookSecret: SECRET,
    clock: () => NOW,
  });
});

/* ------------------------------------------------------------------ */

describe("FakeKycProvider — sessions", () => {
  test("creates a session with a client token and an expiry", async () => {
    const session = await provider.createSession(request());

    expect(session.vendorSessionId).toMatch(/^fake_sess_/);
    expect(session.clientToken).toBeTruthy();
    expect(session.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  test("offers a hosted URL, so assisted KYC works without an app", async () => {
    const session = await provider.createSession(request());
    expect(session.hostedUrl).toContain(session.vendorSessionId);
  });

  /**
   * The hosted URL has to lead somewhere that exists.
   *
   * It pointed at http://localhost:4000/fake-vendor/kyc/… for as long as this
   * fake has existed, and no such route was ever written — so "walk the
   * hosted flow in development" was never actually possible. The stand-in
   * lives on the web app, which is where a page a person looks at belongs.
   */
  test("the hosted URL points at the stand-in on the web app", async () => {
    const session = await provider.createSession(
      request({ redirectUrl: "http://localhost:3000/verify/digilocker/return" }),
    );

    const url = new URL(session.hostedUrl!);
    expect(url.origin).toBe("http://localhost:3000");
    expect(url.pathname).toBe("/fake-digilocker");
  });

  /**
   * And it has to carry the way back.
   *
   * A hosted flow is only a flow if the person returns; `redirectUrl` was
   * accepted and then ignored, so the stand-in had nowhere to send anybody.
   * This is the half of the DigiLocker shape that the gateway cannot be asked
   * to rehearse.
   */
  test("the hosted URL carries the session and the way back", async () => {
    const session = await provider.createSession(
      request({ redirectUrl: "http://localhost:3000/verify/digilocker/return" }),
    );

    const url = new URL(session.hostedUrl!);
    expect(url.searchParams.get("session")).toBe(session.vendorSessionId);
    expect(url.searchParams.get("redirect_url")).toBe(
      "http://localhost:3000/verify/digilocker/return",
    );
  });

  /** Whatever host the caller is on — the fake must not pin it to localhost. */
  test("the stand-in follows the caller's origin", async () => {
    const session = await provider.createSession(
      request({ redirectUrl: "https://kyc.example.test/verify/digilocker/return" }),
    );

    expect(new URL(session.hostedUrl!).origin).toBe("https://kyc.example.test");
  });

  /**
   * The client token must be scoped to the session. A token that works for
   * any session is as good as the API key we were avoiding handing out.
   */
  test("two sessions get different tokens", async () => {
    const a = await provider.createSession(request({ idempotencyKey: "idem_A" }));
    const b = await provider.createSession(request({ idempotencyKey: "idem_B" }));
    expect(a.clientToken).not.toBe(b.clientToken);
    expect(a.vendorSessionId).not.toBe(b.vendorSessionId);
  });

  /**
   * Every paid vendor call is idempotent. A double-clicked "Verify" button
   * must not open two sessions and bill us twice.
   */
  test("the same idempotency key returns the same session", async () => {
    const first = await provider.createSession(request({ idempotencyKey: "idem_same" }));
    const second = await provider.createSession(request({ idempotencyKey: "idem_same" }));
    expect(second).toEqual(first);
  });

  test("a different idempotency key opens a new session", async () => {
    const first = await provider.createSession(request({ idempotencyKey: "idem_1" }));
    const second = await provider.createSession(request({ idempotencyKey: "idem_2" }));
    expect(second.vendorSessionId).not.toBe(first.vendorSessionId);
  });

  test("fetching an unknown session fails rather than inventing a result", async () => {
    await expect(provider.fetchResult("fake_sess_nope")).rejects.toThrow(/unknown/i);
  });
});

/* ------------------------------------------------------------------ */

describe("FakeKycProvider — the vendor is down", () => {
  test("the timeout scenario throws a retryable timeout", async () => {
    await expect(
      provider.createSession(request({ testScenario: "vendor_timeout" })),
    ).rejects.toThrow(VendorTimeoutError);
  });

  test("a timeout is marked retryable, so the breaker can act on it", async () => {
    try {
      await provider.createSession(request({ testScenario: "vendor_timeout" }));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(VendorTimeoutError);
      expect((error as VendorTimeoutError).retryable).toBe(true);
      expect((error as VendorTimeoutError).vendor).toBe("fake");
    }
  });
});

/* ------------------------------------------------------------------ */

/**
 * These are the tests that prove the layers fit: the fake's result goes
 * straight into the real decision function, and the status that comes out is
 * the one the scenario is named for.
 */
describe("FakeKycProvider — each scenario drives the real decision", () => {
  async function decide(scenario: FakeScenario) {
    const session = await provider.createSession(
      request({ testScenario: scenario, idempotencyKey: `idem_${scenario}` }),
    );
    const result = await provider.fetchResult(session.vendorSessionId);

    return decideKyc(
      {
        level: "FULL",
        now: NOW,
        aadhaar: result.aadhaar,
        pan: result.pan,
        selfie: result.selfie,
        duplicatePan: false,
      },
      DEFAULT_KYC_THRESHOLDS,
    );
  }

  test("pass verifies", async () => {
    const decision = await decide("pass");
    expect(decision.status).toBe("VERIFIED");
    expect(decision.reasons).toEqual([]);
  });

  test("low_face_score goes to review with FACE_MATCH_LOW", async () => {
    const decision = await decide("low_face_score");
    expect(decision.status).toBe("MANUAL_REVIEW");
    expect(decision.reasons.map((r) => r.code)).toContain("FACE_MATCH_LOW");
  });

  test("liveness_fail goes to review with LIVENESS_FAILED", async () => {
    const decision = await decide("liveness_fail");
    expect(decision.status).toBe("MANUAL_REVIEW");
    expect(decision.reasons.map((r) => r.code)).toContain("LIVENESS_FAILED");
  });

  test("pan_name_mismatch goes to review", async () => {
    const decision = await decide("pan_name_mismatch");
    expect(decision.status).toBe("MANUAL_REVIEW");
    expect(decision.reasons.map((r) => r.code)).toContain("PAN_NAME_MISMATCH");
  });

  test("pan_inoperative verifies but carries the TDS flag", async () => {
    const decision = await decide("pan_inoperative");
    expect(decision.status).toBe("VERIFIED");
    expect(decision.reasons.map((r) => r.code)).toContain("PAN_NOT_LINKED_TO_AADHAAR");
  });

  test("pan_deactivated is rejected", async () => {
    const decision = await decide("pan_deactivated");
    expect(decision.status).toBe("REJECTED");
    expect(decision.reasons.map((r) => r.code)).toContain("PAN_DEACTIVATED");
  });

  test("minor is rejected", async () => {
    const decision = await decide("minor");
    expect(decision.status).toBe("REJECTED");
    expect(decision.reasons.map((r) => r.code)).toContain("AGE_UNDER_18");
  });

  test("aadhaar_failed goes to review so the user can retry", async () => {
    const decision = await decide("aadhaar_failed");
    expect(decision.status).toBe("MANUAL_REVIEW");
    expect(decision.reasons.map((r) => r.code)).toContain("AADHAAR_NOT_VERIFIED");
  });
});

/* ------------------------------------------------------------------ */

describe("FakeKycProvider — results carry what an audit needs", () => {
  test("never returns a full Aadhaar number, only the last 4 and a token", async () => {
    const session = await provider.createSession(request());
    const result = await provider.fetchResult(session.vendorSessionId);

    expect(result.aadhaar?.last4).toMatch(/^[0-9]{4}$/);
    expect(result.aadhaar?.refToken).toBeTruthy();
    expect(JSON.stringify(result)).not.toMatch(/\b[2-9][0-9]{11}\b/);
  });

  test("records the vendor version, so a decision stays reproducible", async () => {
    const session = await provider.createSession(request());
    const result = await provider.fetchResult(session.vendorSessionId);
    expect(result.vendorVersion).toBeTruthy();
  });

  test("records an object-store key for the raw response", async () => {
    const session = await provider.createSession(request());
    const result = await provider.fetchResult(session.vendorSessionId);
    expect(result.rawResponseKey).toContain(session.vendorSessionId);
  });

  test("carries an event id, which replay protection needs", async () => {
    const session = await provider.createSession(request());
    const result = await provider.fetchResult(session.vendorSessionId);
    expect(result.eventId).toBeTruthy();
  });

  test("fetching twice gives the same result", async () => {
    const session = await provider.createSession(request());
    const first = await provider.fetchResult(session.vendorSessionId);
    const second = await provider.fetchResult(session.vendorSessionId);
    expect(second).toEqual(first);
  });
});

/* ------------------------------------------------------------------ */

/**
 * The fake has to emit a webhook that passes the real verifier, or local
 * development would exercise a different code path from production — which is
 * exactly how webhook bugs reach production.
 */
describe("FakeKycProvider — emits a genuinely signed webhook", () => {
  test("the emitted webhook verifies against the real verifier", async () => {
    const session = await provider.createSession(request());
    const webhook = await provider.buildWebhook(session.vendorSessionId);

    const result = verifyWebhook({
      scheme: provider.webhookScheme,
      rawBody: webhook.rawBody,
      signatureHeader: webhook.signatureHeader,
      secret: SECRET,
      now: NOW,
    });
    expect(result.valid).toBe(true);
  });

  test("a webhook signed for one body does not verify against another", async () => {
    const session = await provider.createSession(request());
    const webhook = await provider.buildWebhook(session.vendorSessionId);

    const result = verifyWebhook({
      scheme: provider.webhookScheme,
      rawBody: webhook.rawBody.replace("fake", "forged"),
      signatureHeader: webhook.signatureHeader,
      secret: SECRET,
      now: NOW,
    });
    expect(result.valid).toBe(false);
  });

  test("the body carries the session id and the event id", async () => {
    const session = await provider.createSession(request());
    const webhook = await provider.buildWebhook(session.vendorSessionId);
    const parsed = JSON.parse(webhook.rawBody) as Record<string, unknown>;

    expect(parsed.sessionId).toBe(session.vendorSessionId);
    expect(parsed.eventId).toBeTruthy();
  });

  /** The webhook announces readiness; it never carries the decision. */
  test("the body does not contain a KYC status", async () => {
    const session = await provider.createSession(request());
    const webhook = await provider.buildWebhook(session.vendorSessionId);

    expect(webhook.rawBody).not.toContain("VERIFIED");
    expect(webhook.rawBody).not.toContain("MANUAL_REVIEW");
  });

  test("refuses to build a webhook without a secret", () => {
    expect(
      () => new FakeKycProvider({ webhookSecret: "", clock: () => NOW }),
    ).toThrow(/secret/i);
  });

  test("the late_webhook scenario reports a delay the poller must cover", async () => {
    const session = await provider.createSession(
      request({ testScenario: "late_webhook" }),
    );
    const webhook = await provider.buildWebhook(session.vendorSessionId);
    expect(webhook.delaySeconds).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */

/**
 * THE FAKE MUST BE STATELESS, like the adapter it stands in for.
 *
 * A real HyperVerge adapter holds nothing: it asks the vendor over HTTP, so
 * the API and the worker can both ask and both get the same answer. The fake
 * kept its sessions in a Map, which made it process-bound — and that broke
 * something real. Reconciliation runs in the worker and asks the provider
 * about a session the API opened; with per-process state it always answered
 * "unknown session", so the self-healing path could not be exercised in
 * development at all. The fake exists to prevent exactly that class of
 * surprise.
 */
describe("FakeKycProvider — stateless across processes", () => {
  test("a different instance can fetch a result for the same session", async () => {
    const session = await provider.createSession(request({ testScenario: "pass" }));

    /** Stands in for the worker: a separate instance, same secret. */
    const otherProcess = new FakeKycProvider({
      webhookSecret: SECRET,
      clock: () => NOW,
    });

    const result = await otherProcess.fetchResult(session.vendorSessionId);
    expect(result.vendorSessionId).toBe(session.vendorSessionId);
  });

  test("the other instance sees the same scenario", async () => {
    const session = await provider.createSession(
      request({ testScenario: "low_face_score", idempotencyKey: "idem-cross-1" }),
    );
    const otherProcess = new FakeKycProvider({ webhookSecret: SECRET, clock: () => NOW });

    const result = await otherProcess.fetchResult(session.vendorSessionId);
    expect(result.selfie?.faceMatchScore).toBeLessThan(0.75);
  });

  test("the other instance derives the identical result, field for field", async () => {
    const session = await provider.createSession(
      request({ testScenario: "pass", idempotencyKey: "idem-cross-2" }),
    );
    const otherProcess = new FakeKycProvider({ webhookSecret: SECRET, clock: () => NOW });

    expect(await otherProcess.fetchResult(session.vendorSessionId)).toEqual(
      await provider.fetchResult(session.vendorSessionId),
    );
  });

  /** Including the event id, or replay protection would differ per process. */
  test("the event id is the same from either instance", async () => {
    const session = await provider.createSession(
      request({ testScenario: "pass", idempotencyKey: "idem-cross-3" }),
    );
    const otherProcess = new FakeKycProvider({ webhookSecret: SECRET, clock: () => NOW });

    const mine = await provider.fetchResult(session.vendorSessionId);
    const theirs = await otherProcess.fetchResult(session.vendorSessionId);
    expect(theirs.eventId).toBe(mine.eventId);
  });

  test("another instance can build a webhook the verifier accepts", async () => {
    const session = await provider.createSession(
      request({ testScenario: "pass", idempotencyKey: "idem-cross-4" }),
    );
    const otherProcess = new FakeKycProvider({ webhookSecret: SECRET, clock: () => NOW });

    const webhook = await otherProcess.buildWebhook(session.vendorSessionId);
    expect(
      verifyWebhook({
        scheme: otherProcess.webhookScheme,
        rawBody: webhook.rawBody,
        signatureHeader: webhook.signatureHeader,
        secret: SECRET,
        now: NOW,
      }).valid,
    ).toBe(true);
  });

  /** A session id it never issued, and could not have, is still refused. */
  test("a malformed session id is still unknown", async () => {
    const otherProcess = new FakeKycProvider({ webhookSecret: SECRET, clock: () => NOW });
    await expect(otherProcess.fetchResult("not_a_session_id")).rejects.toThrow(
      /unknown|not a fake/i,
    );
  });
});
