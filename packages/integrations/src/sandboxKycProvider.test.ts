import { describe, expect, test } from "vitest";
import {
  SandboxKycProvider,
  type SandboxKycProviderOptions,
} from "./sandboxKycProvider.js";
/** Moved to the shared client when the KYB adapter began using them too. */
import { expiryOf, isoDate } from "./sandboxClient.js";

/**
 * The parts of the Sandbox adapter that can be tested without a key.
 *
 * Not the HTTP calls — those need credentials and a live gateway, and a test
 * that mocked fetch would only prove the mock matches my reading of the docs,
 * which is the very thing in doubt. What IS tested here is everything that is
 * ours: the date conversion, the construction rules, and the refusal to send
 * an invalid number.
 */

const OPTIONS = {
  apiKey: "key_test",
  apiSecret: "secret_test",
  nodeEnv: "development",
  webhookSecret: "whsec_sandbox_testing_000",
};

describe("dates coming back from the gateway", () => {
  /**
   * Their format is DD-MM-YYYY and ours is YYYY-MM-DD. The two are
   * indistinguishable for the first twelve days of any month, so a silent
   * mis-parse would be invisible in most test data and would put a birthday
   * in the wrong month — which, near a birthday, decides somebody is
   * seventeen.
   */
  test("DD-MM-YYYY becomes YYYY-MM-DD", () => {
    expect(isoDate("21-04-1985")).toBe("1985-04-21");
  });

  test("the ambiguous days convert the same way", () => {
    expect(isoDate("05-11-1990")).toBe("1990-11-05");
    expect(isoDate("11-05-1990")).toBe("1990-05-11");
  });

  /**
   * Undefined rather than a guess. A date we cannot read must not become a
   * date we invented: decideKyc treats a missing date of birth as a check it
   * could not make, which is the safe direction.
   */
  test("anything unreadable is undefined, never guessed", () => {
    expect(isoDate(undefined)).toBeUndefined();
    expect(isoDate("")).toBeUndefined();
    expect(isoDate("1985-04-21")).toBeUndefined();
    expect(isoDate("not a date")).toBeUndefined();
  });

  test("surrounding whitespace is tolerated", () => {
    expect(isoDate("  21-04-1985 ")).toBe("1985-04-21");
  });
});

describe("construction", () => {
  test("refuses to construct without credentials", () => {
    expect(() => new SandboxKycProvider({ ...OPTIONS, apiKey: "" })).toThrow(
      /API key and an API secret/,
    );
    expect(() => new SandboxKycProvider({ ...OPTIONS, apiSecret: "" })).toThrow(
      /API key and an API secret/,
    );
  });

  test("it names itself, so the audit trail records which gateway answered", () => {
    expect(new SandboxKycProvider(OPTIONS).name).toBe("sandbox");
  });
});

describe("what it refuses before making a request", () => {
  /**
   * The Verhoeff check runs before the number leaves our network. Catching it
   * here costs nothing; letting it through costs a billable request and
   * returns an error written for a developer rather than for the person who
   * mistyped.
   */
  test("an Aadhaar number failing the checksum never reaches the gateway", async () => {
    const provider = new SandboxKycProvider(OPTIONS);

    await expect(provider.sendAadhaarOtp("123456789012")).rejects.toThrow(
      /not valid/,
    );
  });

  test("a number of the wrong length is refused too", async () => {
    const provider = new SandboxKycProvider(OPTIONS);
    await expect(provider.sendAadhaarOtp("12345")).rejects.toThrow(/not valid/);
  });
});

/* ------------------------------------------------------------------ */

/**
 * A stand-in for the transport, so the field mapping can be tested.
 *
 * The rest of this file avoids HTTP on the grounds that a mocked fetch only
 * proves the mock matches my reading of the docs. This is narrower: the body
 * below is copied from their published verify response, and what is under
 * test is purely what our adapter does with it.
 */
function clientReturning(data: unknown) {
  return {
    name: "sandbox",
    call: async () => ({
      code: 200,
      timestamp: 0,
      transaction_id: "txn_test_1",
      data,
    }),
  } as unknown as SandboxKycProviderOptions["client"];
}

describe("the Aadhaar photograph", () => {
  /**
   * Their verify response carries a photo and it used to be dropped.
   *
   * It matters now because this gateway sells no face match: the comparison
   * against the selfie is done by a reviewer, and without this image there is
   * nothing on screen to compare against.
   */
  test("the photograph is surfaced from the verify response", async () => {
    const provider = new SandboxKycProvider({
      ...OPTIONS,
      client: clientReturning({
        status: "VALID",
        message: "Aadhaar Card Exists",
        name: "John Doe",
        date_of_birth: "21-04-1985",
        photo: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
      }),
    });

    const result = await provider.verifyAadhaarOtp("1234567", "121212");

    expect(result.status).toBe("SUCCESS");
    expect(result.photo).toBe("data:image/jpeg;base64,/9j/4AAQSkZJRg==");
  });

  /** Absent rather than empty: the fake gateway returns no photograph at all. */
  test("a response with no photograph leaves it undefined", async () => {
    const provider = new SandboxKycProvider({
      ...OPTIONS,
      client: clientReturning({
        status: "VALID",
        message: "Aadhaar Card Exists",
        name: "John Doe",
        date_of_birth: "21-04-1985",
      }),
    });

    const result = await provider.verifyAadhaarOtp("1234567", "121212");
    expect(result.photo).toBeUndefined();
  });
});

describe("the routes this gateway does not have", () => {
  /**
   * It is called server to server, so there is no hosted page to send anybody
   * to. Both throw rather than returning an empty value, because a silent
   * no-op would look like a session that was opened and never came back —
   * and the reconciliation job would then chase it forever.
   */
  test("there is no hosted session to create", async () => {
    const provider = new SandboxKycProvider(OPTIONS);

    await expect(
      provider.createSession({
        subjectId: "usr_1",
        level: "FULL",
        role: "LAND_OWNER",
        locale: "en",
        redirectUrl: "https://example.test/return",
        idempotencyKey: "k1",
      }),
    ).rejects.toThrow(/no hosted session/);
  });

  test("and no session result to fetch", async () => {
    const provider = new SandboxKycProvider(OPTIONS);
    await expect(provider.fetchResult("anything")).rejects.toThrow(/no session to fetch/);
  });
});

describe("how long the access token is good for", () => {
  /** A JWT with a known exp, built here so the test needs no network. */
  function tokenExpiringIn(seconds: number): string {
    const claims = Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds }),
    ).toString("base64url");
    return `header.${claims}.signature`;
  }

  /**
   * This replaced a nine-minute guess. A live call to their /authenticate
   * showed the token carries `exp` and lasts 24 hours, so the guess meant
   * re-authenticating about 160 times a day for nothing.
   */
  test("the expiry is read from the token, a minute early", () => {
    const expiry = expiryOf(tokenExpiringIn(24 * 60 * 60));
    const hours = (expiry! - Date.now()) / 3_600_000;

    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThan(24);
  });

  /**
   * Undefined, not a guess, so the caller falls back to a short window. A
   * token trusted past its expiry fails the verification it was fetched for,
   * which is the expensive direction to be wrong in.
   */
  test("an unreadable token yields no expiry at all", () => {
    expect(expiryOf("")).toBeUndefined();
    expect(expiryOf("not-a-jwt")).toBeUndefined();
    expect(expiryOf("header.!!!notbase64!!!.sig")).toBeUndefined();
    expect(expiryOf(`header.${Buffer.from("{}").toString("base64url")}.sig`)).toBeUndefined();
  });
});

describe("how this gateway collects Aadhaar", () => {
  test("OKYC is an OTP route", () => {
    expect(new SandboxKycProvider(OPTIONS).aadhaarRoute).toBe("OTP");
  });
});

describe("dates from DigiLocker", () => {
  /**
   * Their user profile uses slashes where OKYC used hyphens. Confirmed
   * against a real completed session; the published example showed an epoch
   * number instead, which is why this is asserted rather than assumed.
   */
  test("DD/MM/YYYY converts too", () => {
    expect(isoDate("26/05/2004")).toBe("2004-05-26");
    expect(isoDate("21/04/1985")).toBe("1985-04-21");
  });

  /** Still refuses anything it cannot read, rather than guessing a date. */
  test("a mixed or malformed separator is still undefined", () => {
    expect(isoDate("26/05-2004")).toBeUndefined();
    expect(isoDate("2004/05/26")).toBeUndefined();
  });
});
