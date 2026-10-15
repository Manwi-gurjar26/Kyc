import { describe, expect, test } from "vitest";
import { SignedUrlFileStore } from "./fileStore.js";
import type { FileUrlRejection, FileUrlVerdict } from "./fileStore.js";

/**
 * Signed URLs for the kyc-docs bucket.
 *
 * Land records, sale deeds and board resolutions are the most sensitive
 * documents the platform holds, and the guide is specific: a private bucket,
 * short signed URLs, and every view written to the audit log. The signing is
 * what makes "short" and "ours" true rather than aspirational — a URL that
 * never expires is a permanent, unlogged, unrevokable copy of somebody's
 * property deed.
 */

/**
 * Asserts the URL was rejected and returns the reason.
 *
 * FileUrlVerdict is a discriminated union, so `reason` exists only on the
 * invalid branch and expect() cannot narrow a union. Narrowed once here rather
 * than cast away at each of the nine call sites.
 */
function rejectionOf(verdict: FileUrlVerdict): FileUrlRejection {
  if (verdict.valid) {
    throw new Error("expected the URL to be rejected, but it verified");
  }
  return verdict.reason;
}

const SECRET = "filesign_local_dev_0000000";
const NOW = new Date("2026-10-09T22:00:00.000Z");

function store(overrides: { secret?: string } = {}) {
  return new SignedUrlFileStore({
    secret: overrides.secret ?? SECRET,
    baseUrl: "http://localhost:4000/v1/files",
    clock: () => NOW,
  });
}

/* ------------------------------------------------------------------ */

describe("creating an upload URL", () => {
  test("returns a URL, the key it writes to, and when it expires", async () => {
    const upload = await store().createUploadUrl({
      key: "kyc-docs/usr_1/deed.pdf",
      contentType: "application/pdf",
      maxBytes: 25 * 1024 * 1024,
      expiresInSeconds: 300,
    });

    /**
     * Asserted on the parsed parameter, not the raw string: the key is
     * percent-encoded in a query string, so matching the literal path would
     * be testing the encoding rather than the behaviour.
     */
    expect(new URL(upload.url).searchParams.get("key")).toBe(
      "kyc-docs/usr_1/deed.pdf",
    );
    expect(upload.key).toBe("kyc-docs/usr_1/deed.pdf");
    expect(upload.expiresAt.getTime()).toBe(NOW.getTime() + 300_000);
  });

  test("the URL carries a signature", async () => {
    const upload = await store().createUploadUrl({
      key: "kyc-docs/usr_1/deed.pdf",
      contentType: "application/pdf",
      maxBytes: 1024,
      expiresInSeconds: 60,
    });

    expect(new URL(upload.url).searchParams.get("sig")).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * The content type and size limit are signed, not merely suggested. If they
   * were query parameters the client could edit, "PDFs up to 25 MB" would be
   * advice rather than a rule, and the bucket would accept anything.
   */
  test("the content type and size limit are part of what is signed", async () => {
    const original = await store().createUploadUrl({
      key: "kyc-docs/usr_1/deed.pdf",
      contentType: "application/pdf",
      maxBytes: 1024,
      expiresInSeconds: 60,
    });

    const tampered = new URL(original.url);
    tampered.searchParams.set("max", "999999999");

    const verdict = store().verify(tampered.toString(), { method: "PUT", now: NOW });
    expect(rejectionOf(verdict)).toBe("SIGNATURE_MISMATCH");
  });

  test("an upload URL is not a download URL", async () => {
    const upload = await store().createUploadUrl({
      key: "kyc-docs/usr_1/deed.pdf",
      contentType: "application/pdf",
      maxBytes: 1024,
      expiresInSeconds: 60,
    });

    const verdict = store().verify(upload.url, { method: "GET", now: NOW });
    expect(rejectionOf(verdict)).toBe("SIGNATURE_MISMATCH");
  });
});

/* ------------------------------------------------------------------ */

describe("creating a download URL", () => {
  test("is valid for the key it names", async () => {
    const download = await store().createDownloadUrl({
      key: "kyc-docs/usr_1/deed.pdf",
      expiresInSeconds: 60,
    });

    const verdict = store().verify(download.url, { method: "GET", now: NOW });
    expect(verdict.valid).toBe(true);
    if (verdict.valid) expect(verdict.key).toBe("kyc-docs/usr_1/deed.pdf");
  });

  /**
   * Sixty seconds, not an hour. A reviewer opens a deed, looks at it and
   * moves on; a URL that outlives the sitting is a copy that can be forwarded,
   * and nothing downstream would log the second viewer.
   */
  test("a short expiry is the default", async () => {
    const download = await store().createDownloadUrl({
      key: "kyc-docs/usr_1/deed.pdf",
    });

    expect(download.expiresAt.getTime() - NOW.getTime()).toBeLessThanOrEqual(
      60_000,
    );
  });
});

/* ------------------------------------------------------------------ */

describe("verifying a URL", () => {
  async function signedDownload(key = "kyc-docs/usr_1/deed.pdf") {
    return (await store().createDownloadUrl({ key, expiresInSeconds: 60 })).url;
  }

  test("accepts a URL inside its window", async () => {
    const url = await signedDownload();
    const verdict = store().verify(url, {
      method: "GET",
      now: new Date(NOW.getTime() + 30_000),
    });
    expect(verdict.valid).toBe(true);
  });

  test("refuses a URL past its expiry", async () => {
    const url = await signedDownload();
    const verdict = store().verify(url, {
      method: "GET",
      now: new Date(NOW.getTime() + 61_000),
    });
    expect(rejectionOf(verdict)).toBe("EXPIRED");
  });

  test("accepts a URL exactly at its expiry", async () => {
    const url = await signedDownload();
    const verdict = store().verify(url, {
      method: "GET",
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(verdict.valid).toBe(true);
  });

  /**
   * The key is signed, so a URL for one person's deed cannot be edited into a
   * URL for another's. Without this, holding any valid link would be holding a
   * link to every document in the bucket.
   */
  test("refuses a URL whose key has been swapped", async () => {
    const url = await signedDownload("kyc-docs/usr_1/deed.pdf");
    const swapped = url.replace("usr_1", "usr_2");

    const verdict = store().verify(swapped, { method: "GET", now: NOW });
    expect(rejectionOf(verdict)).toBe("SIGNATURE_MISMATCH");
  });

  test("refuses a URL whose expiry has been pushed out", async () => {
    const url = await signedDownload();
    const stretched = new URL(url);
    stretched.searchParams.set(
      "exp",
      String(Math.floor(NOW.getTime() / 1000) + 86_400),
    );

    const verdict = store().verify(stretched.toString(), {
      method: "GET",
      now: NOW,
    });
    expect(rejectionOf(verdict)).toBe("SIGNATURE_MISMATCH");
  });

  test("refuses a URL signed with a different secret", async () => {
    const url = await signedDownload();
    const verdict = store({ secret: "a-different-secret-entirely" }).verify(url, {
      method: "GET",
      now: NOW,
    });
    expect(rejectionOf(verdict)).toBe("SIGNATURE_MISMATCH");
  });

  test("refuses a URL with no signature at all", () => {
    const verdict = store().verify(
      "http://localhost:4000/v1/files?key=kyc-docs/usr_1/deed.pdf&exp=99999999999",
      { method: "GET", now: NOW },
    );
    expect(rejectionOf(verdict)).toBe("MISSING_SIGNATURE");
  });

  test("refuses a malformed signature without throwing", () => {
    const verdict = store().verify(
      "http://localhost:4000/v1/files?key=k&exp=1&sig=nonsense",
      { method: "GET", now: NOW },
    );
    expect(rejectionOf(verdict)).toBe("MALFORMED_SIGNATURE");
  });

  test("refuses a URL with no key", () => {
    const verdict = store().verify(
      "http://localhost:4000/v1/files?exp=1&sig=" + "a".repeat(64),
      { method: "GET", now: NOW },
    );
    expect(rejectionOf(verdict)).toBe("MALFORMED_SIGNATURE");
  });
});

/* ------------------------------------------------------------------ */

describe("refusing to operate unsafely", () => {
  test("a missing secret is refused at construction", () => {
    expect(
      () =>
        new SignedUrlFileStore({
          secret: "",
          baseUrl: "http://localhost:4000/v1/files",
        }),
    ).toThrow(/secret/i);
  });

  test("a short secret is refused", () => {
    expect(
      () =>
        new SignedUrlFileStore({
          secret: "tooshort",
          baseUrl: "http://localhost:4000/v1/files",
        }),
    ).toThrow(/secret/i);
  });

  /**
   * An unbounded expiry is the same thing as no expiry. The guide asks for
   * short signed URLs, and a caller passing a day would be quietly defeating
   * that.
   */
  test("an expiry beyond the maximum is refused", async () => {
    await expect(
      store().createDownloadUrl({
        key: "kyc-docs/usr_1/deed.pdf",
        expiresInSeconds: 86_400,
      }),
    ).rejects.toThrow(/expiry/i);
  });

  /** A key outside the bucket prefix would be a path-traversal in effect. */
  test("a key outside kyc-docs is refused", async () => {
    await expect(
      store().createDownloadUrl({ key: "agreements/signed/ppa.pdf" }),
    ).rejects.toThrow(/kyc-docs/);
  });

  test("a key containing a traversal segment is refused", async () => {
    await expect(
      store().createDownloadUrl({ key: "kyc-docs/../agreements/ppa.pdf" }),
    ).rejects.toThrow(/key/i);
  });
});
