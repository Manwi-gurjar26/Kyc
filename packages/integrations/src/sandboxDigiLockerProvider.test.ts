import { describe, expect, test } from "vitest";
import {
  SandboxDigiLockerProvider,
  type SandboxDigiLockerOptions,
} from "./sandboxDigiLockerProvider.js";

/**
 * The DigiLocker adapter.
 *
 * Tested with an injected transport rather than against the gateway, for the
 * same reason the OKYC adapter is: a live call needs a key, a real DigiLocker
 * account and a person to authenticate at a government site. What is tested
 * here is everything that is ours — the request we send, what we do with each
 * answer, and the two routes this gateway does not have.
 *
 * The response bodies below are copied from Sandbox's published examples. The
 * field mapping they imply is NOT confirmed against a real session yet, and
 * the design spec lists that as the gate before anything is built on it — the
 * OKYC mapping also matched the documentation and was still wrong about which
 * calls would work.
 */

const AUTH_URL =
  "https://digilocker.meripehchaan.gov.in/public/oauth2/1/authorize" +
  "?response_type=code&client_id=IW55C7A3B0&state=abc" +
  "&consent_valid_till=1752061999";

/** A transport that answers per path, so one test can walk several calls. */
function clientFor(routes: Record<string, unknown>, seen?: unknown[]) {
  return {
    name: "sandbox",
    call: async (path: string, payload?: unknown, method = "POST") => {
      seen?.push({ path, payload, method });
      const key = Object.keys(routes).find((r) => path.includes(r));
      if (!key) throw new Error(`test transport: no route for ${path}`);
      const body = routes[key];
      if (body instanceof Error) throw body;
      return { code: 200, timestamp: 0, transaction_id: "txn_dl_1", data: body };
    },
  } as unknown as SandboxDigiLockerOptions["client"];
}

const OPTIONS = {
  apiKey: "key_test_0000000000000000000000000000000f",
  apiSecret: "secret_test_000000000000000000000000000000",
  nodeEnv: "development",
  webhookSecret: "whsec_digilocker_testing_000",
};

const SESSION = {
  "@entity": "in.co.sandbox.kyc.digilocker.session.response",
  authorization_url: AUTH_URL,
  session_id: "f1bd0342-cc1d-4051-8301-e8ee17e3a3c3",
};

function request() {
  return {
    subjectId: "usr_1",
    level: "FULL" as const,
    role: "LAND_OWNER" as const,
    locale: "en" as const,
    redirectUrl: "https://kilowattx.test/verify/digilocker/return",
    idempotencyKey: "idem-0000001",
  };
}

/* ------------------------------------------------------------------ */

describe("opening a session", () => {
  test("the person is sent to DigiLocker's own authorization URL", async () => {
    const provider = new SandboxDigiLockerProvider({
      ...OPTIONS,
      client: clientFor({ "/sessions/init": SESSION }),
    });

    const session = await provider.createSession(request());

    expect(session.vendorSessionId).toBe("f1bd0342-cc1d-4051-8301-e8ee17e3a3c3");
    expect(session.hostedUrl).toBe(AUTH_URL);
  });

  /**
   * The redirect we ask for has to be the one we gave, because it is where
   * the person lands afterwards — and a wrong one strands them on somebody
   * else's site holding a finished verification we never hear about.
   */
  test("our redirect url and only the Aadhaar document are requested", async () => {
    const seen: unknown[] = [];
    const provider = new SandboxDigiLockerProvider({
      ...OPTIONS,
      client: clientFor({ "/sessions/init": SESSION }, seen),
    });

    await provider.createSession(request());

    const sent = seen[0] as { path: string; payload: Record<string, unknown> };
    expect(sent.path).toBe("/kyc/digilocker/sessions/init");
    expect(sent.payload.redirect_url).toBe(
      "https://kilowattx.test/verify/digilocker/return",
    );
    /** Nothing beyond what the check needs. A driving licence is not ours to ask for. */
    expect(sent.payload.doc_types).toEqual(["aadhaar"]);
  });

  /**
   * Their consent window, read off the URL they built.
   *
   * Guessing an expiry would be worse than it sounds: the reconciliation job
   * decides from it whether a session is still worth asking about, so a made
   * up value either abandons a live session or chases a dead one for ever.
   */
  test("the expiry comes from the consent window in the URL", async () => {
    const provider = new SandboxDigiLockerProvider({
      ...OPTIONS,
      client: clientFor({ "/sessions/init": SESSION }),
    });

    const session = await provider.createSession(request());

    expect(session.expiresAt.getTime()).toBe(1752061999 * 1000);
  });

  test("a URL with no consent window still gets a sane expiry", async () => {
    const provider = new SandboxDigiLockerProvider({
      ...OPTIONS,
      client: clientFor({
        "/sessions/init": { ...SESSION, authorization_url: "https://digilocker.test/auth" },
      }),
      clock: () => new Date("2026-10-21T00:00:00Z"),
    });

    const session = await provider.createSession(request());

    expect(session.expiresAt.getTime()).toBeGreaterThan(
      new Date("2026-10-21T00:00:00Z").getTime(),
    );
  });
});

/* ------------------------------------------------------------------ */

describe("collecting the result", () => {
  const AADHAAR_DOC = {
    name: "Ramesh Kumar Sharma",
    date_of_birth: "14-03-1979",
    gender: "M",
    masked_aadhaar_number: "XXXXXXXX7731",
  };

  function provider(status: string, document: unknown = AADHAAR_DOC) {
    return new SandboxDigiLockerProvider({
      ...OPTIONS,
      clock: () => new Date("2026-10-21T10:00:00Z"),
      client: clientFor({ "/status": { id: "sess_1", status }, "/documents/": document }),
    });
  }

  test("a consented session becomes a verified Aadhaar result", async () => {
    const result = await provider("consented").fetchResult("sess_1");

    expect(result.aadhaar?.status).toBe("SUCCESS");
    expect(result.aadhaar?.nameOnRecord).toBe("Ramesh Kumar Sharma");
    /** Their DD-MM-YYYY becomes our ISO, as everywhere else. */
    expect(result.aadhaar?.dateOfBirth).toBe("1979-03-14");
    expect(result.vendor).toBe("digilocker");
  });

  /** The only part of the number we may keep, taken from their masked form. */
  test("four digits are kept from the masked number", async () => {
    const result = await provider("consented").fetchResult("sess_1");
    expect(result.aadhaar?.last4).toBe("7731");
  });

  /**
   * And never invented. The spec flags that DigiLocker may not supply a
   * number at all, and four fabricated digits would show somebody a stranger's.
   */
  test("no number shared means no last four, not a guess", async () => {
    const result = await provider("consented", {
      name: "Ramesh Kumar Sharma",
      date_of_birth: "14-03-1979",
    }).fetchResult("sess_1");

    expect(result.aadhaar?.last4).toBeUndefined();
    expect(result.aadhaar?.status).toBe("SUCCESS");
  });

  /**
   * A number too short to take four digits from is also not a guess.
   *
   * Added after a mutation test: the case above passes a document with no
   * number at all, so it never reached the branch that decides what to do
   * with an unusable one. Padding it to "0000" went undetected.
   */
  test("an unusable number yields no last four either", async () => {
    const result = await provider("consented", {
      name: "Ramesh Kumar Sharma",
      masked_aadhaar_number: "XXX",
    }).fetchResult("sess_1");

    expect(result.aadhaar?.last4).toBeUndefined();
  });

  /**
   * The reference token is the session, not anything derived from a number —
   * there is no number here to derive it from.
   */
  test("the session id is what we quote back as the reference", async () => {
    const result = await provider("consented").fetchResult("sess_1");
    expect(result.aadhaar?.refToken).toBe("sess_1");
  });

  /**
   * Somebody still at DigiLocker is not a failed verification. Retryable, so
   * reconciliation asks again instead of recording a refusal.
   */
  test("a session still in progress is retryable, not a failure", async () => {
    await expect(provider("created").fetchResult("sess_1")).rejects.toMatchObject({
      retryable: true,
    });
  });

  /**
   * Anything unrecognised is refused rather than retried for ever. The person
   * is waiting either way; only one of these outcomes gets looked at by a
   * human. Which strings DigiLocker actually returns is still unconfirmed.
   */
  test("an unknown status is refused, carrying the gateway's own word", async () => {
    await expect(provider("revoked").fetchResult("sess_1")).rejects.toThrow(/revoked/);
    await expect(provider("revoked").fetchResult("sess_1")).rejects.toMatchObject({
      retryable: false,
    });
  });

  /** A consented session with no name is not a pass. */
  test("a document with no name does not read as success", async () => {
    const result = await provider("consented", { gender: "M" }).fetchResult("sess_1");
    expect(result.aadhaar?.status).toBe("FAILED");
  });
});

/* ------------------------------------------------------------------ */

describe("the routes this gateway does not have", () => {
  /**
   * DigiLocker has no OTP of its own — the one-time password is UIDAI's, sent
   * and checked on the government's own site. Returning something empty would
   * look like an OTP that had been sent to somebody.
   */
  test("there is no OTP to send", async () => {
    const provider = new SandboxDigiLockerProvider({
      ...OPTIONS,
      client: clientFor({}),
    });

    await expect(provider.sendAadhaarOtp("999941057058")).rejects.toThrow(
      /no OTP|DigiLocker/i,
    );
  });

  test("there is no OTP to verify", async () => {
    const provider = new SandboxDigiLockerProvider({
      ...OPTIONS,
      client: clientFor({}),
    });

    await expect(provider.verifyAadhaarOtp("ref", "123456")).rejects.toThrow(
      /no OTP|DigiLocker/i,
    );
  });
});
