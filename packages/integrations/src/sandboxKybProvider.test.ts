import { describe, expect, test } from "vitest";
import {
  SandboxKybProvider,
  addressOf,
  companyStatus,
  gstStatus,
  indianDate,
  panStatus,
} from "./sandboxKybProvider.js";
import { SandboxClient } from "./sandboxClient.js";

/**
 * The parts of the KYB adapter that can be tested without a key.
 *
 * Not the HTTP calls: a test that mocked fetch would only prove the mock
 * matches my reading of their documentation, which is the very thing in doubt
 * until a real key exists. What IS tested is everything that is ours — the
 * mapping from their vocabulary onto ours, and the direction each unknown
 * value falls in, which is the part that decides whether an unreadable answer
 * blocks somebody or waves them through.
 */

const CLIENT = new SandboxClient({
  apiKey: "key_test",
  apiSecret: "secret_test",
  nodeEnv: "development",
});

describe("construction", () => {
  test("it names itself, so the audit trail records which gateway answered", () => {
    expect(new SandboxKybProvider(CLIENT).name).toBe("sandbox");
  });

  /**
   * One client, one token. Both adapters taking the same instance is the
   * whole reason the transport was extracted: a token per provider would mean
   * authenticating twice per process for no benefit.
   */
  test("it takes a shared client rather than its own credentials", () => {
    const provider = new SandboxKybProvider(CLIENT);
    expect(provider).toBeInstanceOf(SandboxKybProvider);
  });
});

/* ------------------------------------------------------------------ */

describe("the date their PAN route wants", () => {
  /**
   * Slashes, not dashes — and this is the trap worth a test of its own. Their
   * Aadhaar route RETURNS DD-MM-YYYY with dashes while their PAN route
   * EXPECTS DD/MM/YYYY with slashes. One gateway, both separators, opposite
   * directions.
   */
  test("ISO becomes DD/MM/YYYY", () => {
    expect(indianDate("1986-04-17")).toBe("17/04/1986");
    expect(indianDate("2023-11-02")).toBe("02/11/2023");
  });

  /** The ambiguous days have to convert the same way as the rest. */
  test("a day that could be read as a month is still the day", () => {
    expect(indianDate("1990-07-05")).toBe("05/07/1990");
  });

  /**
   * Refused rather than coerced. A date silently sent in the wrong format
   * comes back as date_of_birth_match=false, which sends a perfectly good PAN
   * to a human reviewer for a reason nobody can see.
   */
  test("anything that is not an ISO date is refused, never guessed", () => {
    expect(() => indianDate("17/04/1986")).toThrow(/ISO date/);
    expect(() => indianDate("17-04-1986")).toThrow(/ISO date/);
    expect(() => indianDate("")).toThrow(/ISO date/);
  });
});

/* ------------------------------------------------------------------ */

describe("their PAN status vocabulary, narrowed to ours", () => {
  test("a valid PAN is recognised", () => {
    expect(panStatus("VALID", null)).toBe("VALID");
    expect(panStatus("valid", "PAN is valid")).toBe("VALID");
    expect(panStatus("EXISTING AND VALID", null)).toBe("VALID");
  });

  test("deactivated and fake are each their own answer", () => {
    expect(panStatus("DEACTIVATED", null)).toBe("DEACTIVATED");
    expect(panStatus("OK", "PAN has been deactivated")).toBe("DEACTIVATED");
    expect(panStatus("FAKE", null)).toBe("FAKE");
  });

  /**
   * The direction that matters. Their specification does not enumerate these
   * values, so an unrecognised one must fail closed — the only thing
   * downstream does with VALID is proceed.
   */
  test("anything unrecognised is INVALID, never VALID", () => {
    expect(panStatus("", null)).toBe("INVALID");
    expect(panStatus("SOMETHING_NEW", null)).toBe("INVALID");
    expect(panStatus("INVALID", null)).toBe("INVALID");
  });

  /** "invalid" contains "valid"; the check must not be fooled by substrings. */
  test("the word invalid is not read as valid", () => {
    expect(panStatus("INVALID PAN", null)).toBe("INVALID");
    expect(panStatus("OK", "The PAN is invalid")).toBe("INVALID");
  });
});

/* ------------------------------------------------------------------ */

describe("GST status", () => {
  test("the three statuses we act on are mapped", () => {
    expect(gstStatus("Active")).toBe("ACTIVE");
    expect(gstStatus("Cancelled")).toBe("CANCELLED");
    expect(gstStatus("Suspended")).toBe("SUSPENDED");
  });

  /**
   * Unknown must not read as ACTIVE. decideKyc() hard-fails on CANCELLED and
   * SUSPENDED, so an unreadable status stops the case for a person instead of
   * letting an unverifiable registration through.
   */
  test("an unreadable status is never reported as active", () => {
    expect(gstStatus(undefined)).not.toBe("ACTIVE");
    expect(gstStatus("")).not.toBe("ACTIVE");
    expect(gstStatus("Provisional")).not.toBe("ACTIVE");
  });
});

/* ------------------------------------------------------------------ */

describe("company status", () => {
  test("the MCA words are recognised", () => {
    expect(companyStatus("ACTIVE")).toBe("ACTIVE");
    expect(companyStatus("Strike Off")).toBe("STRUCK_OFF");
    expect(companyStatus("STRUCK OFF")).toBe("STRUCK_OFF");
    expect(companyStatus("Under Liquidation")).toBe("UNDER_LIQUIDATION");
    expect(companyStatus("Dormant")).toBe("DORMANT");
  });

  /**
   * Unknown lands on DORMANT, which sends the case to a person. A status we
   * could not read is not evidence the company was struck off, so it must not
   * produce the hard fail that STRUCK_OFF does.
   */
  test("an unreadable status goes to review rather than rejection", () => {
    expect(companyStatus(undefined)).toBe("DORMANT");
    expect(companyStatus("Amalgamated")).toBe("DORMANT");
  });
});

/* ------------------------------------------------------------------ */

describe("flattening GSTN's address", () => {
  test("the abbreviated keys come out in reading order", () => {
    expect(
      addressOf({
        bno: "10",
        bnm: "Elphinstone Building",
        st: "Veer Nariman Road",
        loc: "Fort",
        dst: "Mumbai",
        stcd: "Maharashtra",
        pncd: "400001",
      }),
    ).toBe("10, Elphinstone Building, Veer Nariman Road, Fort, Mumbai, Maharashtra, 400001");
  });

  /**
   * Several of their address fields are routinely blank, and a reviewer
   * should not be handed a line of stray commas.
   */
  test("blank parts are dropped rather than punctuated", () => {
    expect(addressOf({ bno: "10", bnm: "", flno: "   ", st: "Main Cross", pncd: "581615" })).toBe(
      "10, Main Cross, 581615",
    );
  });

  test("no address at all is an empty string, not a crash", () => {
    expect(addressOf(undefined)).toBe("");
    expect(addressOf({})).toBe("");
  });
});
