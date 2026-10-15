/**
 * Aadhaar number validation.
 *
 * SECURITY: an Aadhaar number must never be persisted, logged, or sent to
 * Sentry/PostHog. It exists in memory only long enough to hand to the vendor,
 * and only on the OTP eKYC route. On the DigiLocker and OVSE routes we never
 * see it at all. What we keep is the last 4 digits plus the vendor's reference
 * token. See KYC Guide, "Aadhaar rules, whatever the route".
 */

/** Verhoeff dihedral group D5 multiplication table. */
const D5_MULTIPLY: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

/** Verhoeff permutation table, applied by position from the right. */
const PERMUTATION: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** Shape only: 12 digits, first digit 2-9 (UIDAI does not issue 0xx or 1xx). */
export const AADHAAR_REGEX = /^[2-9][0-9]{11}$/;

/**
 * Runs the Verhoeff checksum over a digit string.
 * Returns 0 when the check digit is consistent with the rest of the number.
 */
function verhoeffChecksum(digits: string): number {
  let checksum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    const digit = Number(digits[digits.length - 1 - i]);
    const permuted = PERMUTATION[i % 8]![digit]!;
    checksum = D5_MULTIPLY[checksum]![permuted]!;
  }
  return checksum;
}

/**
 * True when the string is a well-formed Aadhaar number: 12 digits, leading
 * digit 2-9, and a correct Verhoeff check digit.
 *
 * A valid checksum does NOT mean the number is issued to anyone. It only
 * means we will not waste a paid vendor call on an obvious typo.
 */
export function isValidAadhaarNumber(value: string): boolean {
  if (!AADHAAR_REGEX.test(value)) return false;
  return verhoeffChecksum(value) === 0;
}

/** The only part of an Aadhaar number we are allowed to keep. */
export function aadhaarLast4(value: string): string {
  if (!AADHAAR_REGEX.test(value)) {
    throw new Error("aadhaarLast4: not a well-formed Aadhaar number");
  }
  return value.slice(-4);
}
