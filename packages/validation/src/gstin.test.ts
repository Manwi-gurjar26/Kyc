import { describe, expect, test } from "vitest";
import {
  businessPanFromGstin,
  gstinCheckDigit,
  isValidGstin,
  stateCodeFromGstin,
} from "./gstin.js";

/**
 * A GSTIN is 15 characters: a 2-digit state code, the 10-character business
 * PAN, a 1-character entity number, the literal "Z", and a mod-36 check digit.
 *
 * The checksum is verified offline, before we spend a paid vendor lookup.
 */
describe("isValidGstin", () => {
  test("accepts real GSTINs whose check digit is correct", () => {
    expect(isValidGstin("27AAPFU0939F1ZV")).toBe(true);
    expect(isValidGstin("24AAACC1206D1ZM")).toBe(true);
  });

  test("rejects a GSTIN whose check digit is wrong", () => {
    // Same 14 characters, last character bumped by one.
    expect(isValidGstin("27AAPFU0939F1ZW")).toBe(false);
  });

  test("rejects a GSTIN with two characters transposed", () => {
    expect(isValidGstin("27AAPFU0399F1ZV")).toBe(false);
  });

  test("rejects a state code outside 01-38", () => {
    expect(isValidGstin("00AAPFU0939F1ZV")).toBe(false);
    expect(isValidGstin("99AAPFU0939F1ZV")).toBe(false);
  });

  test("rejects a GSTIN whose 14th character is not Z", () => {
    expect(isValidGstin("27AAPFU0939F1AV")).toBe(false);
  });

  test("rejects the wrong length", () => {
    expect(isValidGstin("27AAPFU0939F1Z")).toBe(false);
    expect(isValidGstin("27AAPFU0939F1ZVV")).toBe(false);
  });

  test("rejects lowercase rather than silently fixing it", () => {
    expect(isValidGstin("27aapfu0939f1zv")).toBe(false);
  });
});

describe("gstinCheckDigit", () => {
  test("computes the check digit for the first 14 characters", () => {
    expect(gstinCheckDigit("27AAPFU0939F1Z")).toBe("V");
    expect(gstinCheckDigit("24AAACC1206D1Z")).toBe("M");
  });

  test("throws when given the wrong number of characters", () => {
    expect(() => gstinCheckDigit("27AAPFU0939F1ZV")).toThrow(/14 characters/);
  });
});

/**
 * Characters 3 to 12 of a GSTIN ARE the business PAN, so we derive and verify
 * it for free instead of asking the user for it separately.
 */
describe("businessPanFromGstin", () => {
  test("extracts the business PAN", () => {
    expect(businessPanFromGstin("27AAPFU0939F1ZV")).toBe("AAPFU0939F");
  });

  test("the extracted PAN is itself a well-formed PAN", () => {
    expect(businessPanFromGstin("24AAACC1206D1ZM")).toBe("AAACC1206D");
  });

  test("throws on an invalid GSTIN rather than return a bad PAN", () => {
    expect(() => businessPanFromGstin("27AAPFU0939F1ZW")).toThrow(/valid GSTIN/);
  });
});

describe("stateCodeFromGstin", () => {
  test("reads the state code and its name", () => {
    expect(stateCodeFromGstin("27AAPFU0939F1ZV")).toEqual({
      code: "27",
      state: "Maharashtra",
    });
  });

  test("names Rajasthan, where our first sites are", () => {
    expect(stateCodeFromGstin("08AADCS9012F1ZH").state).toBe("Rajasthan");
  });

  test("returns the code with an unknown name for an unmapped code", () => {
    expect(stateCodeFromGstin("38AAPFU0939F1Z6")).toEqual({
      code: "38",
      state: "Unknown",
    });
  });
});
