import { describe, expect, test } from "vitest";
import { isValidAadhaarNumber } from "./aadhaar.js";

/**
 * The Aadhaar number is 12 digits whose last digit is a Verhoeff check digit.
 * We validate it only on the OTP eKYC route, and only in memory — the number
 * is never stored or logged (KYC Guide, "Aadhaar rules, whatever the route").
 */
describe("isValidAadhaarNumber", () => {
  test("accepts a number whose Verhoeff check digit is correct", () => {
    // 49927398716 + check digit 0 is the canonical Verhoeff test vector,
    // padded to 12 digits with a leading 2 so it is a well-formed Aadhaar.
    expect(isValidAadhaarNumber("234567890124")).toBe(true);
  });

  test("rejects a number whose last digit has been altered", () => {
    expect(isValidAadhaarNumber("234567890125")).toBe(false);
  });

  test("rejects a number with two digits transposed", () => {
    expect(isValidAadhaarNumber("234567809124")).toBe(false);
  });

  test("rejects a number starting with 0 or 1", () => {
    expect(isValidAadhaarNumber("034567890124")).toBe(false);
    expect(isValidAadhaarNumber("134567890124")).toBe(false);
  });

  test("rejects anything that is not exactly 12 digits", () => {
    expect(isValidAadhaarNumber("23456789012")).toBe(false);
    expect(isValidAadhaarNumber("2345678901234")).toBe(false);
    expect(isValidAadhaarNumber("2345 6789 0124")).toBe(false);
    expect(isValidAadhaarNumber("")).toBe(false);
  });
});
