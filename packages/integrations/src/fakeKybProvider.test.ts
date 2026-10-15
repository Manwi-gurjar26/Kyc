import { businessPanFromGstin, gstinCheckDigit } from "@kilowattx/validation";
import { beforeEach, describe, expect, test } from "vitest";
import { FakeKybProvider } from "./fakeKybProvider.js";
import { VendorRequestError } from "./providers.js";

/**
 * The business-verification adapter.
 *
 * Stateless and derived, like FakeKycProvider: every answer comes out of the
 * identifier itself, so the API and the worker compute the same result and no
 * session has to be remembered.
 *
 * It derives more than it invents, and that is the interesting part. A GSTIN
 * genuinely contains the business PAN at characters 3-12, and that PAN's 4th
 * character genuinely encodes the holder type — C for a company, F for a firm
 * or LLP, P for an individual. So the fake reads the constitution out of the
 * GSTIN exactly as a real lookup would, which means the branch deciding
 * "company needs a CIN, proprietorship needs the owner's personal KYC" is
 * exercised by real data rather than by a hint the fake was handed.
 */

/** Builds a checksum-valid GSTIN around a chosen business PAN. */
function gstinFor(stateCode: string, pan: string, entity = "1"): string {
  const first14 = `${stateCode}${pan}${entity}Z`;
  return first14 + gstinCheckDigit(first14);
}

const COMPANY = gstinFor("08", "AADCS9012F");
const LLP = gstinFor("27", "AAAFS1234D");
const PROPRIETOR = gstinFor("08", "ABCPS4412K");

let provider: FakeKybProvider;

beforeEach(() => {
  provider = new FakeKybProvider();
});

/* ------------------------------------------------------------------ */

describe("GSTIN lookup", () => {
  test("returns a legal name, a status and an address", async () => {
    const result = await provider.lookupGstin(COMPANY);

    expect(result.gstin).toBe(COMPANY);
    expect(result.legalName).toBeTruthy();
    expect(result.status).toBe("ACTIVE");
    expect(result.registeredAddress).toBeTruthy();
  });

  test("the state code comes from the GSTIN, not from thin air", async () => {
    expect((await provider.lookupGstin(COMPANY)).stateCode).toBe("08");
    expect((await provider.lookupGstin(LLP)).stateCode).toBe("27");
  });

  /**
   * The business PAN is inside the GSTIN, and its 4th character is the holder
   * type. So the constitution is read out of the identifier exactly as a real
   * lookup would read it.
   */
  test("a company PAN yields a company", async () => {
    const result = await provider.lookupGstin(COMPANY);
    expect(businessPanFromGstin(COMPANY)[3]).toBe("C");
    expect(result.constitution).toMatch(/company/i);
  });

  test("a firm PAN yields a partnership or LLP", async () => {
    const result = await provider.lookupGstin(LLP);
    expect(result.constitution).toMatch(/partnership|llp/i);
  });

  test("an individual PAN yields a proprietorship", async () => {
    const result = await provider.lookupGstin(PROPRIETOR);
    expect(result.constitution).toMatch(/proprietor/i);
  });

  test("the same GSTIN always returns the same answer", async () => {
    expect(await provider.lookupGstin(COMPANY)).toEqual(
      await provider.lookupGstin(COMPANY),
    );
  });

  test("a second instance returns the same answer", async () => {
    expect(await new FakeKybProvider().lookupGstin(COMPANY)).toEqual(
      await provider.lookupGstin(COMPANY),
    );
  });

  /** A bad checksum is caught before any vendor call would be paid for. */
  test("a GSTIN with a wrong check digit is refused", async () => {
    const broken = COMPANY.slice(0, 14) + (COMPANY[14] === "A" ? "B" : "A");
    await expect(provider.lookupGstin(broken)).rejects.toThrow(VendorRequestError);
  });

  test("a malformed GSTIN is refused", async () => {
    await expect(provider.lookupGstin("not-a-gstin")).rejects.toThrow(
      /valid GSTIN/i,
    );
  });
});

/* ------------------------------------------------------------------ */

/**
 * Cancelled and suspended registrations are hard fails, so they have to be
 * reachable in development.
 *
 * The convention is the GSTIN's entity number — character 13, which in a real
 * GSTIN counts registrations for one PAN within a state. 9 means cancelled
 * and 8 means suspended here. It lives in the identifier rather than in an
 * extra argument so the interface stays the shape the real one has.
 */
describe("registrations that are not in good standing", () => {
  test("entity number 9 reads as cancelled", async () => {
    const cancelled = gstinFor("08", "AADCS9012F", "9");
    expect((await provider.lookupGstin(cancelled)).status).toBe("CANCELLED");
  });

  test("entity number 8 reads as suspended", async () => {
    const suspended = gstinFor("08", "AADCS9012F", "8");
    expect((await provider.lookupGstin(suspended)).status).toBe("SUSPENDED");
  });

  test("anything else is active", async () => {
    for (const entity of ["1", "2", "3", "7"]) {
      const gstin = gstinFor("08", "AADCS9012F", entity);
      expect((await provider.lookupGstin(gstin)).status).toBe("ACTIVE");
    }
  });
});

/* ------------------------------------------------------------------ */

describe("CIN lookup", () => {
  const CIN = "U17299RJ2017PTC058441";

  test("returns the company name, status and directors", async () => {
    const result = await provider.lookupCin(CIN);

    expect(result.cin).toBe(CIN);
    expect(result.companyName).toBeTruthy();
    expect(result.status).toBe("ACTIVE");
    expect(result.directors.length).toBeGreaterThan(0);
  });

  /**
   * The CIN's own state code and incorporation year are real fields, and the
   * fake reads them rather than making them up — so the cross-check against
   * the GSTIN state code is exercised with consistent data.
   */
  test("the incorporation date comes from the CIN's year", async () => {
    expect((await provider.lookupCin(CIN)).incorporatedOn).toMatch(/^2017-/);
  });

  test("a struck-off company is reachable", async () => {
    /** Ownership class NPL stands in for a company no longer in good standing. */
    const struck = "U17299RJ2017NPL058441";
    expect((await provider.lookupCin(struck)).status).toBe("STRUCK_OFF");
  });

  test("a malformed CIN is refused", async () => {
    await expect(provider.lookupCin("nope")).rejects.toThrow(/valid CIN/i);
  });

  test("the same CIN always returns the same answer", async () => {
    expect(await provider.lookupCin(CIN)).toEqual(await provider.lookupCin(CIN));
  });
});

/* ------------------------------------------------------------------ */

/**
 * The PAN check only answers yes or no to a name we send it — it never
 * returns the name. That is why Aadhaar has to come first, and the fake
 * refuses to behave otherwise.
 */
describe("PAN verification", () => {
  test("a matching name and date of birth pass", async () => {
    const result = await provider.verifyPan({
      pan: "ABCPS4412K",
      name: "Ramesh Kumar Sharma",
      dateOfBirth: "1979-03-14",
    });

    expect(result.status).toBe("VALID");
    expect(result.nameMatch).toBe(true);
    expect(result.dobMatch).toBe(true);
  });

  test("it never returns a name of its own", async () => {
    const result = await provider.verifyPan({
      pan: "ABCPS4412K",
      name: "Ramesh Kumar Sharma",
      dateOfBirth: "1979-03-14",
    });

    expect(result).not.toHaveProperty("name");
    expect(JSON.stringify(result)).not.toContain("Ramesh");
  });

  /**
   * The mismatch path has to be reachable, or nobody can exercise the review
   * queue for a signatory. Convention: a PAN whose 5th character is Z.
   *
   * It is a convention rather than a derived name because the name we submit
   * comes from Aadhaar — a different fake — so any name the PAN check invented
   * would disagree by construction, and every signatory would land in review
   * with nothing actually wrong.
   */
  test("a PAN marked for mismatch reports the name as not matching", async () => {
    const result = await provider.verifyPan({
      pan: "ABCDZ4412K",
      name: "Ramesh Kumar Sharma",
      dateOfBirth: "1979-03-14",
    });

    expect(result.status).toBe("VALID");
    expect(result.nameMatch).toBe(false);
  });

  test("an ordinary PAN matches the name it was given", async () => {
    const result = await provider.verifyPan({
      pan: "ABCPS4412K",
      name: "R K Sharma",
      dateOfBirth: "1979-03-14",
    });

    expect(result.nameMatch).toBe(true);
  });

  /** An inoperative PAN is flagged for TDS, never blocked. */
  test("a PAN ending in Q reports as not linked to Aadhaar", async () => {
    const result = await provider.verifyPan({
      pan: "ABCPS4412Q",
      name: "Ramesh Kumar Sharma",
      dateOfBirth: "1979-03-14",
    });

    expect(result.status).toBe("VALID");
    expect(result.linkedToAadhaar).toBe(false);
  });

  test("an empty name is refused rather than accepted", async () => {
    const result = await provider.verifyPan({
      pan: "ABCPS4412K",
      name: "",
      dateOfBirth: "1979-03-14",
    });

    expect(result.nameMatch).toBe(false);
  });

  test("a malformed date of birth does not match", async () => {
    const result = await provider.verifyPan({
      pan: "ABCPS4412K",
      name: "Ramesh Kumar Sharma",
      dateOfBirth: "14-03-1979",
    });

    expect(result.dobMatch).toBe(false);
  });

  test("a malformed PAN is refused", async () => {
    await expect(
      provider.verifyPan({ pan: "nope", name: "X Y", dateOfBirth: "1979-03-14" }),
    ).rejects.toThrow(/valid PAN/i);
  });

  /** The 4th character drives it, so a business PAN is checked on its DOI. */
  test("a company PAN is checked against its date of incorporation", async () => {
    const result = await provider.verifyPan({
      pan: "AADCS9012F",
      name: "Shreeji Textiles Private Limited",
      dateOfBirth: "2017-05-11",
    });

    expect(result.status).toBe("VALID");
    expect(result.nameMatch).toBe(true);
  });
});
