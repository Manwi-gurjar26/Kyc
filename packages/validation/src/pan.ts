/**
 * PAN validation.
 *
 * STORAGE: a PAN is stored as `pan_encrypted` (envelope encryption) plus
 * `pan_blind_index` (HMAC-SHA256 of the normalised PAN) and `pan_last4`.
 * The blind index is what lets us answer "has this PAN been used before?"
 * without decrypting anything. See packages/core/src/blindIndex.ts.
 */

export const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/**
 * The 4th character of a PAN is the holder-type code assigned by the
 * Income Tax Department.
 */
const HOLDER_TYPE_BY_CODE = {
  P: "INDIVIDUAL",
  C: "COMPANY",
  F: "FIRM_OR_LLP",
  H: "HUF",
  T: "TRUST",
  A: "ASSOCIATION_OF_PERSONS",
  B: "BODY_OF_INDIVIDUALS",
  G: "GOVERNMENT",
  J: "ARTIFICIAL_JURIDICAL_PERSON",
  L: "LOCAL_AUTHORITY",
} as const;

export type PanHolderType =
  | (typeof HOLDER_TYPE_BY_CODE)[keyof typeof HOLDER_TYPE_BY_CODE]
  | "UNKNOWN";

/**
 * Cleans up what a human typed: trims, uppercases, and removes the spaces and
 * hyphens people add. Use this before validating, storing or hashing — the
 * blind index must be computed over the normalised form or the same PAN would
 * produce two different hashes.
 */
export function normalisePan(value: string): string {
  return value.replace(/[\s-]/g, "").trim().toUpperCase();
}

/**
 * True when the value is a well-formed PAN. Deliberately strict about case:
 * callers normalise first, so a lowercase value reaching here means a bug
 * rather than a user typo.
 */
export function isValidPan(value: string): boolean {
  return PAN_REGEX.test(value);
}

/**
 * Reads the holder type out of the 4th character.
 *
 * Expect INDIVIDUAL for Investors and Land Owners, and COMPANY or FIRM_OR_LLP
 * for a business PAN derived from a GSTIN. A mismatch between the holder type
 * and the subject type is a reason to send a case to review — a "business"
 * whose PAN says INDIVIDUAL is either a proprietorship or a mistake.
 */
export function panHolderType(value: string): PanHolderType {
  if (!isValidPan(value)) {
    throw new Error("panHolderType: not a well-formed PAN");
  }
  const code = value[3] as keyof typeof HOLDER_TYPE_BY_CODE;
  return HOLDER_TYPE_BY_CODE[code] ?? "UNKNOWN";
}

/** The only part of a PAN shown in any UI. */
export function panLast4(value: string): string {
  if (!isValidPan(value)) {
    throw new Error("panLast4: not a well-formed PAN");
  }
  return value.slice(-4);
}
