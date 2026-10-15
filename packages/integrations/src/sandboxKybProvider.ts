import type { GstResult, PanResult } from "@kilowattx/core";
import {
  VendorRequestError,
  type CinLookupResult,
  type GstLookupResult,
  type KybProvider,
  type PanVerifyRequest,
} from "./providers.js";
import { SandboxClient, isoDate } from "./sandboxClient.js";

/**
 * Sandbox (sandbox.co.in) — PAN, GSTIN and company master data.
 *
 * The same gateway and the same key as the Aadhaar adapter, which is why both
 * take a `SandboxClient` rather than credentials: one access token serves the
 * whole process.
 *
 * Written against their published OpenAPI specification, which is embedded in
 * their documentation pages. Each route below names the spec it came from.
 *
 * NOT YET EXERCISED AGAINST THE LIVE GATEWAY. Three places are flagged inline
 * as the ones to check on the first real call — the legal-name field, the PAN
 * status vocabulary, and the registration-date field whose own documentation
 * contradicts itself.
 */

/**
 * The routes, in one place.
 *
 * Collected here rather than inline so that when a path changes there is a
 * single table to correct, and so a reader can see the whole surface this
 * adapter depends on without reading the methods.
 */
const ROUTES = {
  /** POST, spec: in-co-sandbox-kyc */
  pan: "/kyc/pan/verify",
  /** POST, spec: GST compliance public */
  gstin: "/gst/compliance/public/gstin/search",
  /** POST, spec: in-co-sandbox-kyc */
  company: "/kyc/mca/company/master-data",
} as const;

export class SandboxKybProvider implements KybProvider {
  readonly name = "sandbox";

  constructor(private readonly client: SandboxClient) {}

  /* ---------------------------------------------------------------- */
  /* PAN                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Verifies a PAN against the Income Tax Department's records.
   *
   * Their response answers the name and date-of-birth questions directly
   * (`name_as_per_pan_match`, `date_of_birth_match`), so no comparison is done
   * here — the department's own answer is the authoritative one, and
   * re-deriving it locally would be a second, weaker opinion.
   */
  async verifyPan(request: PanVerifyRequest): Promise<PanResult> {
    const body = await this.client.call<{
      pan: string;
      category: string;
      status: string;
      remarks: string | null;
      name_as_per_pan_match: boolean;
      date_of_birth_match: boolean;
      aadhaar_seeding_status: "y" | "n" | "na";
    }>(ROUTES.pan, {
      "@entity": "in.co.sandbox.kyc.pan_verification.request",
      pan: request.pan.toUpperCase(),
      name_as_per_pan: request.name,
      date_of_birth: indianDate(request.dateOfBirth),
      /**
       * Sent only because a consent row was written before this method was
       * reached. The API service refuses to call it otherwise; defaulting to
       * "Y" here would make the field a formality.
       */
      consent: "Y",
      reason: "KYB verification for a solar lease or power purchase agreement",
    });

    const record = body.data;

    return {
      status: panStatus(record.status, record.remarks),
      nameMatch: record.name_as_per_pan_match === true,
      dobMatch: record.date_of_birth_match === true,
      /**
       * Only "y" counts as linked.
       *
       * "na" means the department did not say, which is not the same as yes.
       * Treating it as not-linked costs a FLAG on the record — it changes a
       * TDS rate rather than blocking anybody — so the cautious reading is
       * nearly free here and a wrong "linked" is not.
       *
       * Read off THIS response rather than from their /kyc/pan-aadhaar/status
       * route, which is the important part: that route requires the full
       * twelve-digit Aadhaar number as a parameter, and this system has
       * nowhere to hold one. The seeding status arriving on the PAN response
       * is the only source we can use without storing what we refuse to store.
       */
      linkedToAadhaar: record.aadhaar_seeding_status === "y",
    };
  }

  /* ---------------------------------------------------------------- */
  /* GSTIN                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Looks a GSTIN up on the public GST register.
   *
   * The response is GSTN's own schema passed straight through, so the field
   * names are theirs: `lgnm`, `sts`, `ctb`, `rgdt`. They are cryptic rather
   * than wrong, and mapping them in one place is the whole job of this method.
   */
  async lookupGstin(gstin: string): Promise<GstLookupResult> {
    const body = await this.client.call<{
      data: {
        gstin?: string;
        lgnm?: string;
        tradeNam?: string;
        sts?: string;
        ctb?: string;
        rgdt?: string;
        stj?: string;
        pradr?: { addr?: Record<string, string | undefined> };
      };
    }>(ROUTES.gstin, { gstin: gstin.toUpperCase() });

    /** Their envelope carries a second `data` inside the first. */
    const record = body.data?.data;

    if (!record?.gstin) {
      throw new VendorRequestError(
        this.name,
        "The GST register has no record for that GSTIN. Please check the fifteen characters.",
      );
    }

    return {
      gstin: record.gstin,
      /**
       * `lgnm` is GSTN's long-standing field for the legal name, and
       * `tradeNam` beside it in the same response corroborates the schema.
       * It is nevertheless the one field in this file that their published
       * spec did not describe explicitly — check it first on the first live
       * call, because an empty legal name here would fail the name match
       * against the MCA register for a reason that is not the company's.
       */
      legalName: record.lgnm ?? "",
      tradeName: record.tradeNam,
      status: gstStatus(record.sts),
      constitution: record.ctb ?? "",
      /**
       * `rgdt` is the registration date. Their documentation labels it "Lst
       * Updated Date", which contradicts GSTN's own definition and every
       * other implementation of this response — almost certainly a
       * copy-and-paste slip in their docs rather than a different field.
       * Flagged because if it IS the updated date, every company would look
       * freshly registered.
       */
      registeredOn: isoDate(record.rgdt) ?? record.rgdt ?? "",
      registeredAddress: addressOf(record.pradr?.addr),
      /** The first two characters of a GSTIN are the state code, by definition. */
      stateCode: record.gstin.slice(0, 2),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Company master data                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Fetches a company or LLP from the MCA register.
   *
   * Their "not found" is `code: 521` inside a 200 response, which the shared
   * client already turns into a VendorRequestError carrying their message —
   * so a struck-off or mistyped CIN reaches the caller as a refusal with a
   * readable reason rather than as an empty success.
   */
  async lookupCin(cin: string): Promise<CinLookupResult> {
    const body = await this.client.call<
      {
        cin?: string;
        company_name?: string;
        company_status?: string;
        company_registration_date?: string;
      }[]
    >(ROUTES.company, { cin: cin.toUpperCase() });

    /** Their `data` is an array even for a lookup by exact CIN. */
    const record = Array.isArray(body.data) ? body.data[0] : undefined;

    if (!record?.cin) {
      throw new VendorRequestError(
        this.name,
        "The MCA register has no record for that CIN.",
      );
    }

    return {
      cin: record.cin,
      companyName: record.company_name ?? "",
      status: companyStatus(record.company_status),
      incorporatedOn:
        isoDate(record.company_registration_date) ??
        record.company_registration_date ??
        "",
      /**
       * Empty, and deliberately so.
       *
       * Company master data carries no director list — their director route is
       * keyed by DIN, which is a number you already have to know, so it cannot
       * be used to discover who the directors are. Returning an empty array is
       * the honest answer; inventing one would make the signatory check look
       * as though it had been performed.
       *
       * The consequence is that "is this person a director?" cannot be
       * answered automatically yet. Legal reads the board resolution instead,
       * which is what `org_members.authority_approved_at` already records.
       */
      directors: [],
    };
  }
}

/* ------------------------------------------------------------------ */
/* Field mapping                                                      */
/* ------------------------------------------------------------------ */

/**
 * Their PAN status vocabulary, narrowed to ours.
 *
 * Their specification does not enumerate the values, so this matches on the
 * words the Income Tax Department uses and falls through to INVALID. That
 * direction is the point: an unrecognised status must never read as VALID,
 * because the only thing downstream does with VALID is proceed.
 *
 * The second place to check on a first live call — if their vocabulary turns
 * out to be something this does not recognise, every PAN fails closed, which
 * is visible and safe rather than silent and wrong.
 */
export function panStatus(status: string, remarks?: string | null): PanResult["status"] {
  const text = `${status} ${remarks ?? ""}`.toLowerCase();

  if (text.includes("deactivat")) return "DEACTIVATED";
  if (text.includes("fake")) return "FAKE";
  if (/\bvalid\b/.test(text) && !text.includes("invalid")) return "VALID";
  if (text.includes("existing") || text.includes("active")) return "VALID";

  return "INVALID";
}

/** GSTN writes the status as a word; ours is a narrow enum. */
export function gstStatus(value: string | undefined): GstResult["status"] {
  switch (value?.trim().toLowerCase()) {
    case "active":
      return "ACTIVE";
    case "cancelled":
    case "canceled":
      return "CANCELLED";
    case "suspended":
      return "SUSPENDED";
    default:
      /**
       * Anything else is reported as suspended rather than active. A GSTIN we
       * cannot read the status of must not be treated as a live registration:
       * decideKyc() hard-fails on CANCELLED and SUSPENDED, so an unknown value
       * stops the case for a human instead of waving it through.
       */
      return "SUSPENDED";
  }
}

/** The MCA register's status words, narrowed to the four we act on. */
export function companyStatus(value: string | undefined): CinLookupResult["status"] {
  const text = (value ?? "").toLowerCase();

  if (text.includes("strike") || text.includes("struck")) return "STRUCK_OFF";
  if (text.includes("liquidat")) return "UNDER_LIQUIDATION";
  if (text.includes("dormant")) return "DORMANT";
  if (text.includes("active")) return "ACTIVE";

  /**
   * Unknown is treated as dormant, which sends the case to a person rather
   * than rejecting it outright. A company whose status we could not read is
   * not evidence that it was struck off.
   */
  return "DORMANT";
}

/**
 * ISO date to the DD/MM/YYYY their PAN route wants.
 *
 * Slashes, not dashes — and that is the trap. Their Aadhaar route RETURNS
 * DD-MM-YYYY with dashes while their PAN route EXPECTS DD/MM/YYYY with
 * slashes, so one gateway uses both separators in opposite directions. Worth
 * its own function and its own test for the same reason `isoDate` is: a
 * silently wrong date of birth makes `date_of_birth_match` false and sends a
 * perfectly good PAN to a human reviewer.
 */
export function indianDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!match) {
    throw new VendorRequestError(
      "sandbox",
      `A date of birth must be an ISO date (YYYY-MM-DD); received "${iso}".`,
    );
  }

  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
}

/**
 * GSTN's address object, flattened to one line.
 *
 * Their keys are abbreviations — `bno` building number, `bnm` building name,
 * `st` street, `loc` locality, `pncd` pincode — and several are routinely
 * blank, so the empties are dropped rather than producing a line of stray
 * commas in a reviewer's queue.
 */
export function addressOf(addr: Record<string, string | undefined> | undefined): string {
  if (!addr) return "";

  return ["bno", "bnm", "flno", "st", "loc", "dst", "stcd", "pncd"]
    .map((key) => addr[key]?.trim())
    .filter((part): part is string => Boolean(part))
    .join(", ");
}
