import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { LocalDiskBucket } from "./localBucket.js";

/**
 * The development stand-in for the private object store.
 *
 * It exists so the upload flow can be walked end to end — pick a file, PUT it,
 * watch it get scanned — without a cloud account. A managed bucket replaces it entirely:
 * both this and the URL signing go away together, because a real bucket does
 * both itself.
 *
 * What it must not do is be loose about keys. A key arrives inside a signed
 * URL, and a signature proves the key has not been edited — not that the key
 * was sane to begin with.
 */

let root: string;
let bucket: LocalDiskBucket;

const KEY = "kyc-docs/usr_1/JAMABANDI/deed.pdf";
const BYTES = Buffer.from("%PDF-1.7\nnot really a pdf\n");

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "kwx-bucket-"));
  bucket = new LocalDiskBucket({ root });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */

describe("storing and reading an object", () => {
  test("what was written is what comes back", async () => {
    await bucket.put(KEY, BYTES, "application/pdf");
    const stored = await bucket.get(KEY);

    expect(stored).not.toBeNull();
    expect(stored!.bytes.equals(BYTES)).toBe(true);
    expect(stored!.contentType).toBe("application/pdf");
  });

  test("a key that was never written reads as missing, not as empty", async () => {
    const stored = await bucket.get("kyc-docs/usr_1/JAMABANDI/absent.pdf");
    expect(stored).toBeNull();
  });

  /** Re-uploading replaces, the way a bucket does. */
  test("writing the same key twice keeps the second copy", async () => {
    const second = Buffer.from("a different file");
    await bucket.put(KEY, BYTES, "application/pdf");
    await bucket.put(KEY, second, "application/pdf");

    const stored = await bucket.get(KEY);
    expect(stored!.bytes.equals(second)).toBe(true);
  });

  test("nested prefixes are created as needed", async () => {
    const deep = "kyc-docs/usr_9/SALE_DEED/2026/04/deed.pdf";
    await bucket.put(deep, BYTES, "application/pdf");
    expect((await bucket.get(deep))!.bytes.equals(BYTES)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe("deleting an object", () => {
  /**
   * Quarantine has to mean the bytes are gone, not merely that we decline to
   * hand out a link. A file that failed a virus scan and is still sitting in
   * storage is still malware somebody can reach by another route.
   */
  test("a deleted object reads as missing", async () => {
    const key = "kyc-docs/usr_2/JAMABANDI/infected.pdf";
    await bucket.put(key, BYTES, "application/pdf");

    expect(await bucket.delete(key)).toBe(true);
    expect(await bucket.get(key)).toBeNull();
  });

  /**
   * Deleting something already gone is a success, not an error. The caller is
   * a quarantine step that may be retried, and a retry must not fail because
   * the first attempt worked.
   */
  test("deleting a missing object succeeds and says nothing was there", async () => {
    expect(await bucket.delete("kyc-docs/usr_2/JAMABANDI/never.pdf")).toBe(false);
  });

  test("a traversal key is refused on delete too", async () => {
    await expect(bucket.delete("kyc-docs/../../etc/passwd")).rejects.toThrow(/key/i);
  });
});

/* ------------------------------------------------------------------ */

describe("refusing a key that could escape the directory", () => {
  /**
   * The signature proves the key was not edited in transit. It says nothing
   * about whether the key was safe when it was signed, so the check belongs
   * here as well as at signing time — this is the layer that touches the
   * filesystem.
   */
  test("a traversal segment is refused on write", async () => {
    await expect(
      bucket.put("kyc-docs/../../etc/passwd", BYTES, "application/pdf"),
    ).rejects.toThrow(/key/i);
  });

  test("a traversal segment is refused on read", async () => {
    await expect(bucket.get("kyc-docs/../../etc/passwd")).rejects.toThrow(/key/i);
  });

  test("an absolute key is refused", async () => {
    await expect(
      bucket.put("/etc/passwd", BYTES, "application/pdf"),
    ).rejects.toThrow(/key/i);
  });

  test("a key outside the kyc-docs prefix is refused", async () => {
    await expect(
      bucket.put("agreements/signed/ppa.pdf", BYTES, "application/pdf"),
    ).rejects.toThrow(/kyc-docs/);
  });

  test("a key with a null byte is refused", async () => {
    await expect(
      bucket.put("kyc-docs/usr_1/x\u0000.pdf", BYTES, "application/pdf"),
    ).rejects.toThrow(/key/i);
  });

  /** A Windows separator is a separator too, and this repo runs on Windows. */
  test("a backslash segment is refused", async () => {
    await expect(
      bucket.put("kyc-docs/..\\..\\windows\\system32", BYTES, "application/pdf"),
    ).rejects.toThrow(/key/i);
  });
});

/* ------------------------------------------------------------------ */

describe("refusing to run where it must not", () => {
  /**
   * The sharpest line in this file. Files written to a container's local disk
   * are gone at the next deploy, and a KYC document that quietly vanishes is
   * worse than one that was never accepted.
   */
  test("it refuses to construct in production", () => {
    expect(
      () => new LocalDiskBucket({ root, nodeEnv: "production" }),
    ).toThrow(/production/i);
  });

  test("it constructs anywhere else", () => {
    expect(() => new LocalDiskBucket({ root, nodeEnv: "test" })).not.toThrow();
  });
});
