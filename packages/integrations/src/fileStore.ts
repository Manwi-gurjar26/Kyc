import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed URLs for the kyc-docs bucket.
 *
 * Land records, sale deeds and board resolutions are the most sensitive
 * documents the platform holds. The guide is specific about how they are
 * served: a private bucket, short signed URLs, and every view written to the
 * audit log.
 *
 * The signing is what makes "short" and "ours" true rather than aspirational.
 * A URL that never expires is a permanent, unlogged, unrevokable copy of
 * somebody's property deed — and once it has been forwarded, nothing
 * downstream knows who looked at it.
 *
 * A managed bucket replaces this with its own presigned URLs. The interface is the same
 * shape: the browser talks to the store directly, never streaming a deed
 * through the API process.
 */

export type FileUrlRejection =
  | "MISSING_SIGNATURE"
  | "MALFORMED_SIGNATURE"
  | "SIGNATURE_MISMATCH"
  | "EXPIRED";

export type FileUrlVerdict =
  | { valid: true; key: string; method: "GET" | "PUT"; expiresAt: Date }
  | { valid: false; reason: FileUrlRejection };

export interface UploadUrl {
  url: string;
  key: string;
  expiresAt: Date;
  /** Echoed back so the client sends the type that was actually signed. */
  contentType: string;
  maxBytes: number;
}

export interface DownloadUrl {
  url: string;
  key: string;
  expiresAt: Date;
}

export interface FileStore {
  createUploadUrl(params: {
    key: string;
    contentType: string;
    maxBytes: number;
    expiresInSeconds?: number;
  }): Promise<UploadUrl>;

  createDownloadUrl(params: {
    key: string;
    expiresInSeconds?: number;
  }): Promise<DownloadUrl>;

  verify(
    url: string,
    context: { method: "GET" | "PUT"; now: Date },
  ): FileUrlVerdict;
}

/** The only prefix these URLs may address. */
export const KYC_DOCS_PREFIX = "kyc-docs/";

/**
 * Longest permitted lifetime.
 *
 * An unbounded expiry is the same thing as no expiry, so the cap is enforced
 * here rather than trusted to callers. Ten minutes is generous for an upload
 * and far longer than a reviewer needs to open a PDF.
 */
export const MAX_URL_SECONDS = 600;

/** Default for a download: long enough to open, short enough not to forward. */
export const DEFAULT_DOWNLOAD_SECONDS = 60;

const MIN_SECRET_LENGTH = 24;
const HEX_64 = /^[0-9a-f]{64}$/;

export interface SignedUrlFileStoreOptions {
  secret: string;
  /** Where the signed URLs point. In production, the bucket's own host. */
  baseUrl: string;
  clock?: () => Date;
}

export class SignedUrlFileStore implements FileStore {
  private readonly secret: string;
  private readonly baseUrl: string;
  private readonly clock: () => Date;

  constructor(options: SignedUrlFileStoreOptions) {
    if (!options.secret || options.secret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `SignedUrlFileStore: a signing secret of at least ${MIN_SECRET_LENGTH} characters is required. ` +
          "Without it, every document URL would be forgeable.",
      );
    }
    this.secret = options.secret;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.clock = options.clock ?? (() => new Date());
  }

  /* ---------------------------------------------------------------- */

  async createUploadUrl(params: {
    key: string;
    contentType: string;
    maxBytes: number;
    expiresInSeconds?: number;
  }): Promise<UploadUrl> {
    const key = this.assertKey(params.key);
    const seconds = this.assertSeconds(params.expiresInSeconds ?? MAX_URL_SECONDS);
    const expiresAt = new Date(this.clock().getTime() + seconds * 1000);
    const exp = Math.floor(expiresAt.getTime() / 1000);

    /**
     * The content type and the size limit are signed, not merely suggested.
     * As editable query parameters, "PDFs up to 25 MB" would be advice, and
     * the bucket would accept a 2 GB executable.
     */
    const url = new URL(this.baseUrl);
    url.searchParams.set("key", key);
    url.searchParams.set("exp", String(exp));
    url.searchParams.set("ct", params.contentType);
    url.searchParams.set("max", String(params.maxBytes));
    url.searchParams.set(
      "sig",
      this.sign("PUT", key, exp, params.contentType, params.maxBytes),
    );

    return {
      url: url.toString(),
      key,
      expiresAt,
      contentType: params.contentType,
      maxBytes: params.maxBytes,
    };
  }

  async createDownloadUrl(params: {
    key: string;
    expiresInSeconds?: number;
  }): Promise<DownloadUrl> {
    const key = this.assertKey(params.key);
    const seconds = this.assertSeconds(
      params.expiresInSeconds ?? DEFAULT_DOWNLOAD_SECONDS,
    );
    const expiresAt = new Date(this.clock().getTime() + seconds * 1000);
    const exp = Math.floor(expiresAt.getTime() / 1000);

    const url = new URL(this.baseUrl);
    url.searchParams.set("key", key);
    url.searchParams.set("exp", String(exp));
    url.searchParams.set("sig", this.sign("GET", key, exp));

    return { url: url.toString(), key, expiresAt };
  }

  /* ---------------------------------------------------------------- */

  verify(
    url: string,
    context: { method: "GET" | "PUT"; now: Date },
  ): FileUrlVerdict {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { valid: false, reason: "MALFORMED_SIGNATURE" };
    }

    const provided = parsed.searchParams.get("sig");
    if (!provided) return { valid: false, reason: "MISSING_SIGNATURE" };
    if (!HEX_64.test(provided.toLowerCase())) {
      return { valid: false, reason: "MALFORMED_SIGNATURE" };
    }

    const key = parsed.searchParams.get("key");
    const expRaw = parsed.searchParams.get("exp");
    if (!key || !expRaw || !/^[0-9]+$/.test(expRaw)) {
      return { valid: false, reason: "MALFORMED_SIGNATURE" };
    }

    const exp = Number(expRaw);
    const contentType = parsed.searchParams.get("ct") ?? undefined;
    const maxRaw = parsed.searchParams.get("max");
    const maxBytes = maxRaw === null ? undefined : Number(maxRaw);

    const expected =
      context.method === "PUT"
        ? this.sign("PUT", key, exp, contentType ?? "", maxBytes ?? 0)
        : this.sign("GET", key, exp);

    if (
      !timingSafeEqual(
        Buffer.from(expected, "hex"),
        Buffer.from(provided.toLowerCase(), "hex"),
      )
    ) {
      return { valid: false, reason: "SIGNATURE_MISMATCH" };
    }

    /**
     * Checked after the signature, so an expired-but-genuine URL is
     * distinguishable from a forged one. A caller that cannot tell them apart
     * will treat both as a glitch, and a forgery attempt deserves a different
     * response from a reviewer who left a tab open.
     */
    if (Math.floor(context.now.getTime() / 1000) > exp) {
      return { valid: false, reason: "EXPIRED" };
    }

    return {
      valid: true,
      key,
      method: context.method,
      expiresAt: new Date(exp * 1000),
    };
  }

  /* ---------------------------------------------------------------- */

  private sign(
    method: "GET" | "PUT",
    key: string,
    exp: number,
    contentType?: string,
    maxBytes?: number,
  ): string {
    /**
     * The method is part of the payload, so an upload URL cannot be replayed
     * as a download. Otherwise a client handed a URL to write a deed would
     * also hold a URL to read one.
     */
    const parts = [method, key, String(exp)];
    if (method === "PUT") {
      parts.push(contentType ?? "", String(maxBytes ?? 0));
    }

    return createHmac("sha256", this.secret)
      .update(parts.join("\n"), "utf8")
      .digest("hex");
  }

  /**
   * Keys must sit inside the bucket prefix and contain no traversal.
   *
   * Without this, a signed URL could be minted for anything the store can
   * reach — including the agreements bucket, which holds signed PPAs under
   * object lock.
   */
  private assertKey(key: string): string {
    if (!key.startsWith(KYC_DOCS_PREFIX)) {
      throw new Error(
        `SignedUrlFileStore: key must start with ${KYC_DOCS_PREFIX} — got "${key}"`,
      );
    }
    if (key.includes("..") || key.includes("//") || /[\r\n]/.test(key)) {
      throw new Error(
        `SignedUrlFileStore: key contains a traversal or control character — got "${key}"`,
      );
    }
    return key;
  }

  private assertSeconds(seconds: number): number {
    if (!Number.isInteger(seconds) || seconds <= 0 || seconds > MAX_URL_SECONDS) {
      throw new Error(
        `SignedUrlFileStore: expiry must be between 1 and ${MAX_URL_SECONDS} seconds — got ${seconds}. ` +
          "An unbounded expiry is the same thing as no expiry.",
      );
    }
    return seconds;
  }
}
