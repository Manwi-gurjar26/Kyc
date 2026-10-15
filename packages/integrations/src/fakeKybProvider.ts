import { createHash } from "node:crypto";
import {
  businessPanFromGstin,
  cinParts,
  isValidCin,
  isValidGstin,
  isValidPan,
  nameMatchScore,
  normalisePan,
  panHolderType,
  stateCodeFromGstin,
} from "@kilowattx/validation";
import type { PanResult } from "@kilowattx/core";
import {
  VendorRequestError,
  type CinLookupResult,
  type GstLookupResult,
  type KybProvider,
  type PanVerifyRequest,
} from "./providers.js";

/**
 * Business verification without a vendor contract.
 *
 * Stateless and derived, like FakeKycProvider: every answer comes out of the
 * identifier, so any process computes the same result and nothing has to be
 * remembered between calls.
 *
 * It derives far more than it invents, which is what makes it useful. A GSTIN
 * really does contain the business PAN at characters 3 to 12, and that PAN's
 * 4th character really does encode the holder type. So the constitution is
 * read out of the GSTIN exactly as a real lookup reads it — and the branch
 * that decides "a company needs a CIN, a proprietorship's KYB is the owner's
 * own personal KYC" is driven by real structure rather than by a hint the
 * fake was handed.
 *
 * Signzy or IDfy will replace this. Their adapters answer the same three
 * questions over HTTP; nothing above this interface changes.
 */

/**
 * Status by the GSTIN's entity number — character 13.
 *
 * In a real GSTIN that counts registrations for one PAN within a state. Here
 * 9 means cancelled and 8 means suspended, so the hard-fail paths are
 * reachable in development without adding a test-only argument that the real
 * adapter would not have.
 */
const STATUS_BY_ENTITY_NUMBER: Record<string, GstLookupResult["status"]> = {
  "9": "CANCELLED",
  "8": "SUSPENDED",
};

/** Holder type to the constitution a GST registration would report. */
const CONSTITUTION_BY_HOLDER_TYPE: Record<string, string> = {
  COMPANY: "Private Limited Company",
  FIRM_OR_LLP: "Partnership Firm / LLP",
  INDIVIDUAL: "Proprietorship",
  HUF: "Hindu Undivided Family",
  TRUST: "Trust",
  ASSOCIATION_OF_PERSONS: "Association of Persons",
  BODY_OF_INDIVIDUALS: "Body of Individuals",
  GOVERNMENT: "Government Department",
  LOCAL_AUTHORITY: "Local Authority",
  ARTIFICIAL_JURIDICAL_PERSON: "Artificial Juridical Person",
};

/**
 * PANs that force a name mismatch, so the review path is reachable.
 *
 * Convention: a PAN whose 5th character is Z. It lives in the identifier for
 * the same reason the GST status does — the interface keeps the shape the real
 * adapter has, with no test-only argument.
 */
const MISMATCH_PAN_MARKER = /^[A-Z]{4}Z/;

/** CIN ownership classes that are not a company in good standing. */
const NOT_IN_GOOD_STANDING: Record<string, CinLookupResult["status"]> = {
  NPL: "STRUCK_OFF",
  ULT: "UNDER_LIQUIDATION",
};

const TRADE_WORDS = [
  "Shreeji",
  "Navrang",
  "Suryodaya",
  "Bagru",
  "Marudhara",
  "Chitra",
  "Vasundhara",
  "Saraswati",
];

const TRADE_KINDS = ["Textiles", "Industries", "Fabrics", "Agro", "Polymers", "Mills"];

const DIRECTOR_NAMES = [
  "Nikhil Desai",
  "Meera Desai",
  "Ramesh Kumar Sharma",
  "Priya Nair",
  "Arjun Mehta",
  "Lakshmi Devi Yadav",
];

function hash(value: string): number {
  return parseInt(createHash("sha256").update(value).digest("hex").slice(0, 8), 16);
}

function pick<T>(list: readonly T[], seed: string, offset = 0): T {
  return list[(hash(seed) + offset) % list.length]!;
}

export class FakeKybProvider implements KybProvider {
  readonly name = "fake-kyb";

  /* ---------------------------------------------------------------- */

  async lookupGstin(gstin: string): Promise<GstLookupResult> {
    if (!isValidGstin(gstin)) {
      /**
       * Checked before anything else, so a mistyped GSTIN never costs a paid
       * vendor call. Zod catches it at the API boundary too; this is the
       * adapter refusing to be the place the check was forgotten.
       */
      throw new VendorRequestError(
        this.name,
        `Not a valid GSTIN: ${gstin}. The format or the check digit is wrong.`,
      );
    }

    const pan = businessPanFromGstin(gstin);
    const { code, state } = stateCodeFromGstin(gstin);
    const holderType = panHolderType(pan);
    const entityNumber = gstin[12]!;

    const word = pick(TRADE_WORDS, pan);
    const kind = pick(TRADE_KINDS, pan, 3);
    const constitution =
      CONSTITUTION_BY_HOLDER_TYPE[holderType] ?? "Unregistered / Other";

    /** A company's legal name carries its suffix; a proprietorship does not. */
    const legalName =
      holderType === "COMPANY"
        ? `${word} ${kind} Private Limited`
        : holderType === "FIRM_OR_LLP"
          ? `${word} ${kind} LLP`
          : `${word} ${kind}`;

    return {
      gstin,
      legalName,
      tradeName: `${word} ${kind}`,
      status: STATUS_BY_ENTITY_NUMBER[entityNumber] ?? "ACTIVE",
      constitution,
      registeredOn: `20${10 + (hash(pan) % 14)}-07-19`,
      registeredAddress:
        `Plot ${11 + (hash(gstin) % 80)}, RIICO Industrial Area, ` +
        `Bagru, ${state} ${303000 + (hash(gstin) % 900)}`,
      stateCode: code,
    };
  }

  /* ---------------------------------------------------------------- */

  async lookupCin(cin: string): Promise<CinLookupResult> {
    if (!isValidCin(cin)) {
      throw new VendorRequestError(
        this.name,
        `Not a valid CIN: ${cin}. Expected 21 characters, e.g. U17299RJ2017PTC058441.`,
      );
    }

    const parts = cinParts(cin);

    /**
     * The trade name comes from the first two digits of the registration
     * number, not from a hash of the whole CIN.
     *
     * A hash looked more realistic and made the system untestable: the GST
     * legal name is derived from the business PAN inside the GSTIN, so the two
     * names came from unrelated seeds and could never agree. Every company
     * KYB then failed its MCA-versus-GST name check, which is a review
     * reason — so every company landed in review with nothing wrong.
     *
     * Reading the name out of digits the caller controls means
     * `cinForGstin()` can produce a consistent pair for development, while a
     * mismatch stays reachable by supplying any other CIN.
     */
    const digits = parts.registrationNumber;
    const word = TRADE_WORDS[Number(digits[0]) % TRADE_WORDS.length]!;
    const kind = TRADE_KINDS[Number(digits[1]) % TRADE_KINDS.length]!;

    /**
     * The incorporation year is a real field of the CIN, so it is read rather
     * than invented — which keeps it consistent with whatever a PAN check is
     * later asked to match against.
     */
    const month = 1 + (hash(cin) % 12);
    const day = 1 + (hash(cin + "d") % 28);

    return {
      cin,
      companyName: `${word} ${kind} ${
        parts.ownership === "PLC" ? "Limited" : "Private Limited"
      }`,
      status: NOT_IN_GOOD_STANDING[parts.ownership] ?? "ACTIVE",
      incorporatedOn: `${parts.incorporationYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      directors: [
        pick(DIRECTOR_NAMES, cin),
        pick(DIRECTOR_NAMES, cin, 1),
      ].filter((name, index, all) => all.indexOf(name) === index),
    };
  }

  /**
   * A CIN whose company name agrees with that GSTIN's legal name.
   *
   * Development only, and not part of KybProvider — a real CIN comes from the
   * customer. It exists so a development environment can hold a *consistent*
   * business: without it the MCA name and the GST name are two unrelated
   * derivations, every company fails the name check, and the review queue
   * fills with cases a reviewer can find nothing wrong with.
   *
   * Pass an ownership class to reach the other statuses: NPL for struck off,
   * ULT for under liquidation.
   */
  cinForGstin(gstin: string, ownership = "PTC"): string {
    const pan = businessPanFromGstin(gstin);

    /** The same picks lookupGstin makes, encoded as digits. */
    const wordIndex = hash(pan) % TRADE_WORDS.length;
    const kindIndex = (hash(pan) + 3) % TRADE_KINDS.length;

    const registrationNumber =
      String(wordIndex % 10) + String(kindIndex % 10) + "8441";

    return `U17299${gstin.slice(0, 2) === "08" ? "RJ" : "MH"}2017${ownership}${registrationNumber}`;
  }

  /* ---------------------------------------------------------------- */

  /**
   * Verifies a PAN against a name and date we supply.
   *
   * Deliberately returns no name. The real service on the Income Tax
   * Department's authorised channel only answers yes or no to what you send
   * it, which is exactly why Aadhaar has to be verified first — otherwise the
   * name being checked is whatever the user typed.
   *
   * A fake that returned a name would let a caller skip Aadhaar and still
   * appear to work, and the gap would only show up against the real service.
   */
  async verifyPan(request: PanVerifyRequest): Promise<PanResult> {
    const pan = normalisePan(request.pan);

    if (!isValidPan(pan)) {
      throw new VendorRequestError(
        this.name,
        `Not a valid PAN: ${request.pan}. Expected ten characters, e.g. ABCPS4412K.`,
      );
    }

    /**
     * WHY THIS DOES NOT INVENT A NAME TO COMPARE AGAINST.
     *
     * The first version derived a name from the PAN and scored the submitted
     * name against it. That looked more realistic and was worse. The name we
     * submit comes from Aadhaar — which is a different fake with a different
     * seed — so the two disagreed by construction, and every signatory landed
     * in manual review carrying PAN_NAME_MISMATCH. A development environment
     * in which nobody can ever pass is not a useful one, and the reviewer
     * looking at those cases would find nothing wrong with any of them.
     *
     * Making the two fakes share a seed would be worse still: it would mean a
     * passing name match proved only that two of our own functions agree.
     *
     * So the default is a match, which is the common real case — the name came
     * from Aadhaar and the Department holds the same one — and the mismatch is
     * reachable by convention, like the GST status above.
     */
    const forcedMismatch = MISMATCH_PAN_MARKER.test(pan);

    /**
     * A blank or single-character name is rejected on its own merits. Callers
     * are supposed to pass the Aadhaar name; passing nothing is a bug worth
     * surfacing rather than accepting.
     */
    const plausible = nameMatchScore(request.name, request.name) === 1;

    return {
      status: "VALID",
      nameMatch: plausible && !forcedMismatch,
      /** The fake holds no date, so a well-formed date is accepted. */
      dobMatch: /^\d{4}-\d{2}-\d{2}$/.test(request.dateOfBirth),
      /**
       * An unlinked PAN is flagged for TDS rather than blocking, so it needs
       * to be reachable too. Convention: a PAN ending in Q.
       */
      linkedToAadhaar: !pan.endsWith("Q"),
    };
  }
}
