import { afterEach, describe, expect, it, vi } from "vitest";
import { VendorAccountError, VendorRequestError } from "./providers.js";
import { SandboxClient } from "./sandboxClient.js";

/**
 * Which host a key talks to.
 *
 * This is the whole of what is tested here, and it is tested because getting
 * it wrong does not look like getting it wrong. The host used to come from
 * NODE_ENV, so a live key in development was sent to the test host — where
 * `/authenticate` happily issues a token and every product call then returns
 * 403 "Use test API key for test environment". A working token followed by a
 * 403 reads as an unentitled account, not a mismatched host.
 *
 * So the assertion is on the URL actually requested, not on anything the
 * client reports about itself.
 */

/** Captures the host of the first request, and answers like the gateway. */
function captureHost() {
  const urls: string[] = [];

  const fetchMock = vi.fn(async (url: string | URL) => {
    urls.push(String(url));
    return new Response(
      JSON.stringify({
        code: 200,
        timestamp: Date.now(),
        transaction_id: "test",
        /** No `exp` to read, which exercises the fallback expiry too. */
        data: { access_token: "token-without-an-exp" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  vi.stubGlobal("fetch", fetchMock);
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("host selection", () => {
  it("sends a live key to the live host, even outside production", async () => {
    const urls = captureHost();

    const client = new SandboxClient({
      apiKey: "key_live_0000000000000000000000000000000f",
      apiSecret: "secret_live_000000000000000000000000000000",
      nodeEnv: "development",
    });

    await client.call("/kyc/aadhaar/okyc/otp", {});

    expect(urls[0]).toBe("https://api.sandbox.co.in/authenticate");
    expect(urls[1]).toBe("https://api.sandbox.co.in/kyc/aadhaar/okyc/otp");
  });

  it("sends a test key to the test host", async () => {
    const urls = captureHost();

    const client = new SandboxClient({
      apiKey: "key_test_0000000000000000000000000000000f",
      apiSecret: "secret_test_000000000000000000000000000000",
      nodeEnv: "development",
    });

    await client.call("/kyc/pan/verify", {});

    expect(urls[0]).toBe("https://test-api.sandbox.co.in/authenticate");
    expect(urls[1]).toBe("https://test-api.sandbox.co.in/kyc/pan/verify");
  });

  /**
   * The property the old NODE_ENV check was protecting, kept explicitly: a
   * test key in production verifies nobody, and must stop the process rather
   * than quietly pass everyone who tries.
   */
  it("refuses a test key in production", () => {
    expect(
      () =>
        new SandboxClient({
          apiKey: "key_test_0000000000000000000000000000000f",
          apiSecret: "secret_test_000000000000000000000000000000",
          nodeEnv: "production",
        }),
    ).toThrow(/non-live API key is refused in production/);
  });

  it("accepts a live key in production", () => {
    expect(
      () =>
        new SandboxClient({
          apiKey: "key_live_0000000000000000000000000000000f",
          apiSecret: "secret_live_000000000000000000000000000000",
          nodeEnv: "production",
        }),
    ).not.toThrow();
  });

  /** Unchanged, and asserted so the new check cannot be reached without it. */
  it("still requires both halves of the credential", () => {
    expect(
      () =>
        new SandboxClient({
          apiKey: "key_live_0000000000000000000000000000000f",
          apiSecret: "",
          nodeEnv: "development",
        }),
    ).toThrow(/API key and an API secret are required/);
  });
});

/**
 * Whose problem a refusal is.
 *
 * "Insufficient credits" came back as a VendorRequestError — the class that
 * means "your input was wrong" and whose message is put on the person's
 * screen — so a customer's PAN step showed our billing problem as theirs, and
 * nothing was logged for whoever tops the wallet up.
 */
describe("refusals that are about our account, not the input", () => {
  /** Authenticates, then answers the product call with `status` and `body`. */
  function gatewayAnswering(status: number, body: object, authStatus = 200) {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(
            JSON.stringify(
              authStatus === 200
                ? { code: 200, timestamp: 0, transaction_id: "auth", data: { access_token: "t" } }
                : { code: authStatus, timestamp: 0, transaction_id: "auth", message: "Invalid API key" },
            ),
            { status: authStatus },
          );
        }
        return new Response(
          JSON.stringify({ timestamp: 0, transaction_id: "txn-1", ...body }),
          { status },
        );
      }),
    );

    return new SandboxClient({
      apiKey: "key_live_0000000000000000000000000000000f",
      apiSecret: "secret_live_000000000000000000000000000000",
      nodeEnv: "development",
    });
  }

  it.each([
    ["the message, on a 4xx", 403, "Insufficient credits"],
    ["the message, on a 5xx", 503, "Insufficient Credits"],
    ["a 402, whatever it says", 402, "Payment required"],
  ])("an empty wallet is an account error, recognised by %s", async (_, status, message) => {
    const client = gatewayAnswering(status, { code: status, message });

    const error = await client.call("/kyc/pan/verify", {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VendorAccountError);
    expect(error).not.toBeInstanceOf(VendorRequestError);
    expect((error as Error).message).toMatch(/credits/);
    expect((error as Error).message).toContain("txn-1");
  });

  it("a wrong PAN is still the person's input, with the gateway's words", async () => {
    const client = gatewayAnswering(422, { code: 422, message: "Invalid PAN pattern" });

    const error = await client.call("/kyc/pan/verify", {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VendorRequestError);
    expect((error as Error).message).toBe("Invalid PAN pattern");
  });

  it("rejected credentials are an account error too", async () => {
    const client = gatewayAnswering(200, {}, 401);

    const error = await client.call("/kyc/pan/verify", {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VendorAccountError);
    expect((error as Error).message).toMatch(/rejected our credentials/);
  });
});
