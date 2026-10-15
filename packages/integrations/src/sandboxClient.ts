import { VendorError, VendorRequestError, VendorTimeoutError } from "./providers.js";

/**
 * The transport shared by every Sandbox (sandbox.co.in) adapter.
 *
 * Extracted when the KYB adapter was written, for one reason that matters more
 * than tidiness: the access token. Their `/authenticate` returns a JWT good for
 * 24 hours, and two providers each holding their own would authenticate twice
 * per process and keep two tokens alive for no benefit. One client, one token,
 * shared by whoever asks.
 *
 * Everything vendor-shaped lives here — the envelope, the two hosts, the
 * timeout, and the mapping from HTTP failures onto our two vendor errors. The
 * providers above it are then only field mapping, which is the part worth
 * reading when a response does not look right.
 */

const TEST_BASE = "https://test-api.sandbox.co.in";
const LIVE_BASE = "https://api.sandbox.co.in";

/** Their API version header. Pinned, so a vendor-side change cannot surprise us. */
const API_VERSION = "1.0.0";

const REQUEST_TIMEOUT_MS = 15_000;

export interface SandboxClientOptions {
  apiKey: string;
  apiSecret: string;
  /** Anything other than "production" talks to the test host. */
  nodeEnv: string;
  clock?: () => Date;
}

/** The shape every response from this gateway is wrapped in. */
export interface Envelope<T> {
  code: number;
  timestamp: number;
  transaction_id: string;
  data: T;
  message?: string;
}

export class SandboxClient {
  /** Named so a vendor error says which gateway answered. */
  readonly name = "sandbox";

  private readonly base: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly clock: () => Date;

  /**
   * The access token, cached.
   *
   * Fetching a fresh one before every call would double the request count and
   * the latency of every verification. Refreshed a minute early rather than on
   * expiry: a token that expires in flight fails the call it was fetched for.
   */
  private token: { value: string; expiresAt: number } | null = null;

  /**
   * In-flight authentication, so a burst does not start several.
   *
   * Without this, three verifications arriving together each find no cached
   * token and each call `/authenticate`. Two of those tokens are then thrown
   * away, and on a gateway that rate-limits authentication the third is the
   * one that fails.
   */
  private authenticating: Promise<string> | null = null;

  constructor(options: SandboxClientOptions) {
    if (!options.apiKey || !options.apiSecret) {
      throw new Error(
        "SandboxClient: both an API key and an API secret are required. " +
          "They come from the Sandbox dashboard; test keys work against the test host.",
      );
    }

    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.base = options.nodeEnv === "production" ? LIVE_BASE : TEST_BASE;
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * One authenticated request, with the token fetched or reused.
   *
   * Every failure mode is turned into one of our two vendor errors, because
   * the difference matters upstream: a VendorRequestError is the gateway
   * saying the input was wrong and is shown to the person, where a timeout is
   * ours to retry and must never be reported as a failed check.
   */
  async call<T>(
    path: string,
    payload?: unknown,
    method: "GET" | "POST" = "POST",
  ): Promise<Envelope<T>> {
    const token = await this.accessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          authorization: token,
          "x-api-key": this.apiKey,
          "x-api-version": API_VERSION,
        },
        body: method === "GET" ? undefined : JSON.stringify(payload ?? {}),
        signal: controller.signal,
      });
    } catch (error) {
      /**
       * An abort is genuinely a timeout and trips the breaker; anything else
       * is DNS, TLS or a refused connection. Both are retryable, but only one
       * is worth reporting as the vendor being slow.
       */
      if (error instanceof Error && error.name === "AbortError") {
        throw new VendorTimeoutError(this.name, REQUEST_TIMEOUT_MS);
      }
      throw new VendorError(
        `Could not reach the verification gateway: ${
          error instanceof Error ? error.message : String(error)
        }`,
        this.name,
        true,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let body: Envelope<T>;

    try {
      body = JSON.parse(text) as Envelope<T>;
    } catch {
      throw new VendorError(
        `The verification gateway returned something that is not JSON (HTTP ${response.status}).`,
        this.name,
        true,
      );
    }

    /**
     * 5xx is ours to retry; 4xx is the caller's input. The gateway's own
     * message is passed through for 4xx because it is the one that says
     * "OTP expired" or "invalid PAN" — rewording it would lose the only
     * useful detail.
     */
    if (response.status >= 500) {
      throw new VendorError(
        `The verification gateway is unavailable (HTTP ${response.status}).`,
        this.name,
        true,
      );
    }

    if (!response.ok || body.code >= 400) {
      throw new VendorRequestError(
        this.name,
        body.message ??
          `The verification gateway refused the request (HTTP ${response.status}).`,
        response.status,
      );
    }

    return body;
  }

  /** Fetches a token, or reuses the cached one while it has a minute left. */
  private async accessToken(): Promise<string> {
    const now = this.clock().getTime();
    if (this.token && this.token.expiresAt > now) return this.token.value;

    /** Somebody else is already fetching one; wait for theirs. */
    if (this.authenticating) return this.authenticating;

    this.authenticating = this.fetchToken(now).finally(() => {
      this.authenticating = null;
    });

    return this.authenticating;
  }

  private async fetchToken(now: number): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.base}/authenticate`, {
        method: "POST",
        headers: { "x-api-key": this.apiKey, "x-api-secret": this.apiSecret },
        signal: controller.signal,
      });

      const body = (await response.json()) as Envelope<{ access_token: string }>;

      if (!response.ok || !body.data?.access_token) {
        throw new VendorRequestError(
          this.name,
          "The verification gateway rejected our credentials. Check the API key and secret.",
          response.status,
        );
      }

      /**
       * The real expiry, read from the token, and a short fallback if `exp` is
       * ever missing or unreadable — a token reused past its expiry fails the
       * verification it was fetched for, which is the expensive direction to
       * be wrong in.
       */
      this.token = {
        value: body.data.access_token,
        expiresAt: expiryOf(body.data.access_token) ?? now + 9 * 60_000,
      };

      return this.token.value;
    } catch (error) {
      if (error instanceof VendorRequestError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new VendorTimeoutError(this.name, REQUEST_TIMEOUT_MS);
      }
      throw new VendorError(
        `Could not authenticate with the verification gateway: ${
          error instanceof Error ? error.message : String(error)
        }`,
        this.name,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Reads `exp` out of a JWT, as milliseconds, a minute early.
 *
 * Only the payload is parsed, and only for its expiry — the signature is the
 * gateway's business, not ours. Anything unreadable returns undefined so the
 * caller falls back to a short window rather than trusting a parse that
 * failed.
 */
export function expiryOf(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as {
      exp?: number;
    };
    if (typeof claims.exp !== "number") return undefined;

    /** `exp` is in seconds. One minute of headroom for the call in flight. */
    return claims.exp * 1000 - 60_000;
  } catch {
    return undefined;
  }
}

/**
 * Their dates are DD-MM-YYYY; ours are YYYY-MM-DD.
 *
 * Worth its own function and its own test, because the two formats are
 * indistinguishable for the first twelve days of any month. A silent
 * mis-parse would put somebody's birthday in the wrong month and, for a date
 * near a birthday, decide they are seventeen.
 */
export function isoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;

  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value.trim());
  if (!match) return undefined;

  const [, day, month, year] = match;
  return `${year}-${month}-${day}`;
}
