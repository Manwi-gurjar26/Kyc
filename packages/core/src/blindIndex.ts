import { createHmac, timingSafeEqual } from "node:crypto";
import { isValidPan, normalisePan } from "@kilowattx/validation";

/**
 * Blind index for encrypted PANs.
 *
 * The problem: a PAN is stored under envelope encryption, so the same PAN
 * encrypts to different ciphertext every time. That makes "has this PAN been
 * used before?" unanswerable with a WHERE clause — and that question is what
 * enforces one free trial per PAN.
 *
 * The fix: store HMAC-SHA256(key, normalised PAN) in its own column with a
 * unique index. Equality lookups work; the value reveals nothing without the
 * key.
 *
 * Why not a plain hash: a PAN is five letters, four digits, one letter. That
 * is about 2^37 candidates with structure — enumerable on a laptop. A plain
 * SHA-256 column would be a lookup table for every PAN we hold. The HMAC key
 * is what makes it infeasible, so the key is a secret of the same importance
 * as the encryption key itself.
 *
 * Key handling: 32 bytes from the secret store, separate from the data
 * encryption key, and never rotated casually — rotating it means recomputing
 * every index, so plan it as a migration.
 */

/** HMAC-SHA256 wants at least its block-equivalent of entropy. */
export const BLIND_INDEX_MIN_KEY_BYTES = 32;

/**
 * Rejects keys that are missing, too short, or obviously uninitialised.
 *
 * The all-zero check is not paranoia: an unset environment variable decoded
 * into a buffer, or a `Buffer.alloc(32)` placeholder left in a config, both
 * produce a zero key. Without this guard the system would keep working and
 * every index in the table would be computed under a publicly known key.
 */
function assertUsableKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length < BLIND_INDEX_MIN_KEY_BYTES) {
    throw new Error(
      `blindIndex: key must be a Buffer of at least ${BLIND_INDEX_MIN_KEY_BYTES} bytes`,
    );
  }
  const zeroes = Buffer.alloc(key.length, 0);
  if (timingSafeEqual(key, zeroes)) {
    throw new Error("blindIndex: key is all zeroes — the secret was never loaded");
  }
}

/**
 * The value stored in `kyc_records.pan_blind_index`, which carries a unique
 * index. Always computed over the normalised PAN, so "abcps 4412 k" and
 * "ABCPS4412K" collide the way they must.
 */
export function panBlindIndex(pan: string, key: Buffer): string {
  assertUsableKey(key);

  const normalised = normalisePan(pan);
  if (!isValidPan(normalised)) {
    throw new Error("panBlindIndex: not a well-formed PAN");
  }

  return createHmac("sha256", key)
    .update(`pan:v1:${normalised}`, "utf8")
    .digest("hex");
}

/**
 * Reads the blind index key from the environment.
 *
 * Deliberately throws on a missing value rather than falling back to a
 * default: a system that silently indexes under a known key is worse than one
 * that will not start.
 */
export function blindIndexKeyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Buffer {
  const raw = env.KYC_BLIND_INDEX_KEY;
  if (!raw) {
    throw new Error(
      "KYC_BLIND_INDEX_KEY is not set. It must be 32+ bytes, base64-encoded, from the secret store.",
    );
  }
  const key = Buffer.from(raw, "base64");
  assertUsableKey(key);
  return key;
}
