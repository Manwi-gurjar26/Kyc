/**
 * GSTIN validation.
 *
 * Shape: SS PPPPPPPPPP E Z C
 *   SS          2-digit state code (01-38)
 *   PPPPPPPPPP  the business PAN
 *   E           entity number for that PAN within the state
 *   Z           a fixed literal
 *   C           mod-36 check digit
 *
 * We verify the checksum ourselves before paying for a vendor lookup, and we
 * take the business PAN out of characters 3-12 instead of asking for it.
 */

/** Character set for the mod-36 checksum: value is the index. */
const CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** GST state codes. Codes are assigned by the GST Council. */
const STATE_BY_CODE: Record<string, string> = {
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "25": "Daman and Diu",
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman and Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
};

/**
 * Computes the mod-36 check digit for the first 14 characters of a GSTIN.
 *
 * Each character's value is weighted 1, 2, 1, 2, ... from the left. The digit
 * sum of each product is accumulated, and the check digit is whatever brings
 * the total to a multiple of 36.
 */
export function gstinCheckDigit(first14: string): string {
  if (first14.length !== 14) {
    throw new Error("gstinCheckDigit: expects exactly 14 characters");
  }
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const value = CHARSET.indexOf(first14[i]!);
    if (value < 0) {
      throw new Error("gstinCheckDigit: character outside the GSTIN charset");
    }
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARSET[(36 - (sum % 36)) % 36]!;
}

/** Whether the 2-digit prefix is a state code the GST Council has assigned. */
function isAssignedStateCode(code: string): boolean {
  const n = Number(code);
  return Number.isInteger(n) && n >= 1 && n <= 38;
}

/**
 * True when the GSTIN is well-formed, carries an assigned state code, and has
 * a correct check digit.
 *
 * A valid checksum does NOT mean the registration exists or is active — only
 * the GST lookup can say that, and Cancelled or Suspended is a hard fail.
 */
export function isValidGstin(value: string): boolean {
  if (!GSTIN_REGEX.test(value)) return false;
  if (!isAssignedStateCode(value.slice(0, 2))) return false;
  return gstinCheckDigit(value.slice(0, 14)) === value[14];
}

/** Trims and uppercases what a human typed. */
export function normaliseGstin(value: string): string {
  return value.replace(/\s/g, "").trim().toUpperCase();
}

/**
 * The business PAN, taken out of characters 3-12.
 *
 * Requires a fully valid GSTIN: a PAN derived from a mistyped GSTIN would be
 * wrong in a way nothing downstream could detect.
 */
export function businessPanFromGstin(value: string): string {
  if (!isValidGstin(value)) {
    throw new Error("businessPanFromGstin: not a valid GSTIN");
  }
  return value.slice(2, 12);
}

/**
 * The state code and its name.
 *
 * Deliberately lenient about the checksum: this is used to label a GSTIN while
 * the user is still typing, and to cross-check the state against the factory
 * site's PostGIS location.
 */
export function stateCodeFromGstin(value: string): { code: string; state: string } {
  const code = value.slice(0, 2);
  if (!/^[0-9]{2}$/.test(code)) {
    throw new Error("stateCodeFromGstin: GSTIN must start with two digits");
  }
  return { code, state: STATE_BY_CODE[code] ?? "Unknown" };
}
