import { afterEach, describe, expect, it, vi } from "vitest";
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
