import { describe, expect, test } from "vitest";
import { cinParts, isValidCin, isValidLlpin } from "./identifiers.js";

describe("isValidCin", () => {
  test("accepts a well-formed CIN for an unlisted private company", () => {
    expect(isValidCin("U17299RJ2017PTC058441")).toBe(true);
  });

  test("accepts a listed company CIN", () => {
    expect(isValidCin("L24223MH1999PLC121071")).toBe(true);
  });

  test("rejects a leading character other than L or U", () => {
    expect(isValidCin("X17299RJ2017PTC058441")).toBe(false);
  });

  test("rejects an unknown ownership class", () => {
    expect(isValidCin("U17299RJ2017XYZ058441")).toBe(false);
  });

  test("rejects the wrong length", () => {
    expect(isValidCin("U17299RJ2017PTC05844")).toBe(false);
  });
});

describe("cinParts", () => {
  test("breaks a CIN into its six fields", () => {
    expect(cinParts("U17299RJ2017PTC058441")).toEqual({
      listing: "UNLISTED",
      industryCode: "17299",
      stateCode: "RJ",
      incorporationYear: 2017,
      ownership: "PTC",
      registrationNumber: "058441",
    });
  });

  test("the state code can be cross-checked against the GSTIN state", () => {
    // GSTIN 08... is Rajasthan; the CIN agreeing is a free consistency check.
    expect(cinParts("U17299RJ2017PTC058441").stateCode).toBe("RJ");
  });

  test("throws rather than return partial data for an invalid CIN", () => {
    expect(() => cinParts("nope")).toThrow(/valid CIN/);
  });
});

describe("isValidLlpin", () => {
  test("accepts a well-formed LLPIN", () => {
    expect(isValidLlpin("AAB-1234")).toBe(true);
  });

  test("rejects a missing hyphen", () => {
    expect(isValidLlpin("AAB1234")).toBe(false);
  });

  test("rejects the wrong digit count", () => {
    expect(isValidLlpin("AAB-123")).toBe(false);
    expect(isValidLlpin("AAB-12345")).toBe(false);
  });
});
