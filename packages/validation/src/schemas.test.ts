import { describe, expect, test } from "vitest";
import {
  ConsentInputSchema,
  GstinInputSchema,
  PanCheckInputSchema,
} from "./schemas.js";

/**
 * One Zod schema per request body, used by the browser form, the API pipe and
 * the DB boundary. If a rule only exists in one of those places, it is not a
 * rule.
 */
describe("PanCheckInputSchema", () => {
  test("normalises what the user typed before validating", () => {
    const parsed = PanCheckInputSchema.parse({ pan: " abcps 4412 k " });
    expect(parsed.pan).toBe("ABCPS4412K");
  });

  test("rejects a malformed PAN with a usable message", () => {
    const result = PanCheckInputSchema.safeParse({ pan: "ABCD12345K" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/PAN/i);
    }
  });
});

describe("GstinInputSchema", () => {
  test("accepts a GSTIN with a correct check digit", () => {
    const parsed = GstinInputSchema.parse({ gstin: "27aapfu0939f1zv" });
    expect(parsed.gstin).toBe("27AAPFU0939F1ZV");
  });

  test("rejects a GSTIN whose check digit is wrong", () => {
    const result = GstinInputSchema.safeParse({ gstin: "27AAPFU0939F1ZW" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/check digit/i);
    }
  });
});

describe("ConsentInputSchema", () => {
  test("requires a purpose and the notice version the user actually saw", () => {
    const parsed = ConsentInputSchema.parse({
      purpose: "KYC_VERIFICATION",
      noticeVersion: "2.1",
    });
    expect(parsed.purpose).toBe("KYC_VERIFICATION");
  });

  test("rejects a purpose outside the declared list", () => {
    const result = ConsentInputSchema.safeParse({
      purpose: "WHATEVER_WE_FEEL_LIKE",
      noticeVersion: "2.1",
    });
    expect(result.success).toBe(false);
  });
});
