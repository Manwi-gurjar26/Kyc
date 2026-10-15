import { describe, expect, test } from "vitest";
import { isValidPan, normalisePan, panHolderType } from "./pan.js";

describe("isValidPan", () => {
  test("accepts a well-formed individual PAN", () => {
    expect(isValidPan("ABCPS4412K")).toBe(true);
  });

  test("rejects a PAN with the wrong character classes", () => {
    expect(isValidPan("ABCD12345K")).toBe(false);
    expect(isValidPan("ABCPS44127")).toBe(false);
    expect(isValidPan("1BCPS4412K")).toBe(false);
  });

  test("rejects a PAN of the wrong length", () => {
    expect(isValidPan("ABCPS4412")).toBe(false);
    expect(isValidPan("ABCPS4412KK")).toBe(false);
  });

  test("rejects lowercase input rather than silently fixing it", () => {
    expect(isValidPan("abcps4412k")).toBe(false);
  });
});

describe("normalisePan", () => {
  test("uppercases and strips surrounding whitespace", () => {
    expect(normalisePan("  abcps4412k ")).toBe("ABCPS4412K");
  });

  test("strips internal spaces and hyphens that people type", () => {
    expect(normalisePan("ABCPS 4412 K")).toBe("ABCPS4412K");
    expect(normalisePan("ABCPS-4412-K")).toBe("ABCPS4412K");
  });
});

/**
 * The 4th character encodes the holder type. We expect an individual for
 * Investors and Land Owners, and a company or firm for a business PAN.
 */
describe("panHolderType", () => {
  test("reads an individual PAN", () => {
    expect(panHolderType("ABCPS4412K")).toBe("INDIVIDUAL");
  });

  test("reads a company PAN", () => {
    expect(panHolderType("AADCS9012F")).toBe("COMPANY");
  });

  test("reads a firm or LLP PAN", () => {
    expect(panHolderType("AAAFS1234D")).toBe("FIRM_OR_LLP");
  });

  test("reads a HUF PAN", () => {
    expect(panHolderType("AAAHS1234D")).toBe("HUF");
  });

  test("reads a trust PAN", () => {
    expect(panHolderType("AAATS1234D")).toBe("TRUST");
  });

  test("returns UNKNOWN for a holder code we do not map", () => {
    expect(panHolderType("AAAZS1234D")).toBe("UNKNOWN");
  });

  test("throws rather than guess when the PAN is malformed", () => {
    expect(() => panHolderType("nope")).toThrow(/well-formed PAN/);
  });
});
