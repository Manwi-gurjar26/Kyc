import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { KYC_DOCS_PREFIX } from "./fileStore.js";

/**
 * The development stand-in for the private object store.
 *
 * It exists so the upload flow can be walked end to end — pick a file, PUT it,
 * watch it get scanned, open it again — without a cloud account.
 *
 * A managed bucket replaces this and the URL signing together, because a real bucket does
 * both itself: presigned URLs and storage are one service. Until then the API
 * serves the signed URLs it mints, and this is where the bytes land.
 *
 * It refuses to construct in production, and that is the important line.
 * Files on a container's local disk are gone at the next deploy, and a KYC
 * document that quietly vanishes is worse than one that was never accepted —
 * the record says it was verified and the evidence is missing.
 */

export interface StoredObject {
  bytes: Buffer;
  contentType: string;
}

export interface LocalDiskBucketOptions {
  /** Directory the objects live under. Created on first write. */
  root: string;
  nodeEnv?: string;
}

/** Written beside each object so a GET can answer with the right type. */
const META_SUFFIX = ".contenttype";

export class LocalDiskBucket {
  private readonly root: string;

  constructor(options: LocalDiskBucketOptions) {
    const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV ?? "development";

    if (nodeEnv === "production") {
      throw new Error(
        "LocalDiskBucket is refused in production. Objects on a container's local disk are lost at the next deploy, " +
          "and a KYC document that vanishes while the record still says VERIFIED is worse than one never accepted. " +
          "Configure a real object store instead.",
      );
    }

    this.root = resolve(options.root);
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    await writeFile(`${path}${META_SUFFIX}`, contentType, "utf8");
  }

  async get(key: string): Promise<StoredObject | null> {
    const path = this.pathFor(key);

    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }

    /**
     * A missing type file means an object written before the type was
     * recorded. Falling back is safer than refusing: the bytes exist and a
     * reviewer needs them.
     */
    let contentType = "application/octet-stream";
    try {
      contentType = (await readFile(`${path}${META_SUFFIX}`, "utf8")).trim();
    } catch {
      /* fall through to the default */
    }

    return { bytes, contentType };
  }

  /**
   * Removes an object, and says whether there was one.
   *
   * Deleting something already gone is a success. The caller is a quarantine
   * step that may be retried, and a retry must not fail because the first
   * attempt worked — the return value distinguishes the two for a log without
   * making either an error.
   */
  async delete(key: string): Promise<boolean> {
    const path = this.pathFor(key);

    let existed = true;
    try {
      await rm(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      existed = false;
    }

    /** The type sidecar goes with it; a stray one would outlive the object. */
    await rm(`${path}${META_SUFFIX}`, { force: true });

    return existed;
  }

  /**
   * Resolves a key to a path inside the root, or refuses.
   *
   * The signature on a URL proves the key was not edited in transit. It says
   * nothing about whether the key was safe when it was signed, so this check
   * is not redundant with the one in SignedUrlFileStore — this is the layer
   * that touches a filesystem, and it is the one that must not be talked out
   * of its own validation.
   *
   * The final containment check is on the resolved path rather than on the
   * key's text. Pattern-matching a key is a game of guessing every encoding;
   * asking the path library where the path actually ends up is not.
   */
  private pathFor(key: string): string {
    if (!key.startsWith(KYC_DOCS_PREFIX)) {
      throw new Error(
        `LocalDiskBucket: key must start with ${KYC_DOCS_PREFIX} — got "${key}"`,
      );
    }

    if (
      key.includes("\u0000") ||
      key.includes("\\") ||
      key.includes("..") ||
      /[\r\n]/.test(key)
    ) {
      throw new Error(
        `LocalDiskBucket: key contains a traversal or control character — got ${JSON.stringify(key)}`,
      );
    }

    const path = resolve(join(this.root, normalize(key)));

    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new Error(
        `LocalDiskBucket: key resolves outside the bucket root — got ${JSON.stringify(key)}`,
      );
    }

    return path;
  }
}
