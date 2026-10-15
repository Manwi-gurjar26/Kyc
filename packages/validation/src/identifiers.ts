/**
 * The remaining Indian identifiers we validate offline: company CIN and LLP
 * LLPIN.
 *
 * Neither can tell us the entity exists — only the registry lookup can. They
 * exist to catch typos before we pay for a vendor call, and to decide which
 * registry to call at all.
 */

/**
 * Ownership classes used in the 4th field of a CIN. Which one appears tells us
 * what kind of entity we are dealing with, and therefore what proof of
 * authority a signatory needs.
 */
const CIN_OWNERSHIP = {
  PTC: "Private company",
  PLC: "Public company",
  OPC: "One person company",
  FTC: "Subsidiary of a foreign company",
  GOI: "Union government company",
  SGC: "State government company",
  NPL: "Not-for-profit (section 8)",
  ULL: "Unlimited liability, public",
  ULT: "Unlimited liability, private",
} as const;

export type CinOwnership = keyof typeof CIN_OWNERSHIP;

/**
 * CIN layout, 21 characters:
 *   L/U | 5-digit industry | 2-letter state | 4-digit year | 3-letter class | 6-digit reg no.
 */
export const CIN_REGEX = /^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/;

export function isValidCin(value: string): boolean {
  if (!CIN_REGEX.test(value)) return false;
  const ownership = value.slice(12, 15);
  return Object.prototype.hasOwnProperty.call(CIN_OWNERSHIP, ownership);
}

export interface CinParts {
  listing: "LISTED" | "UNLISTED";
  industryCode: string;
  stateCode: string;
  incorporationYear: number;
  ownership: CinOwnership;
  registrationNumber: string;
}

/**
 * Splits a CIN into its fields.
 *
 * The state code is worth keeping: when it disagrees with the GSTIN state
 * code, either the user pasted the wrong identifier or the business is
 * registered somewhere other than where it operates. Both are worth a look.
 */
export function cinParts(value: string): CinParts {
  if (!isValidCin(value)) {
    throw new Error("cinParts: not a valid CIN");
  }
  return {
    listing: value[0] === "L" ? "LISTED" : "UNLISTED",
    industryCode: value.slice(1, 6),
    stateCode: value.slice(6, 8),
    incorporationYear: Number(value.slice(8, 12)),
    ownership: value.slice(12, 15) as CinOwnership,
    registrationNumber: value.slice(15),
  };
}

/** Human-readable label for a CIN's ownership class. */
export function cinOwnershipLabel(ownership: CinOwnership): string {
  return CIN_OWNERSHIP[ownership];
}

/** LLP identification number: three letters, a hyphen, four digits. */
export const LLPIN_REGEX = /^[A-Z]{3}-[0-9]{4}$/;

export function isValidLlpin(value: string): boolean {
  return LLPIN_REGEX.test(value);
}
