import { KYC_DOCS_PREFIX } from "./fileStore.js";
import type {
  DocumentExtractor,
  DocumentScanner,
  DocumentType,
  ExtractedField,
  ExtractionResult,
  ScanResult,
} from "./providers.js";

/**
 * The fake virus scanner and the fake OCR extractor.
 *
 * Neither can do the real job. There is no virus scanner in a test run, and no
 * fake can read a 1974 Jamabandi. What they can do is be faithful: return the
 * same shape of answer a real one returns, including the answers nobody wants,
 * so the code consuming them is written against reality rather than against
 * the happy path.
 *
 * The outcome is encoded in the object key, by convention. A fake that derives
 * its answer from a hash of the key is a fake nobody can steer, and a
 * developer who needs to see what the system does with an infected sale deed
 * has to be able to produce one on purpose.
 *
 * Markers live in the final path segment only, separated by `--`:
 *
 *   kyc-docs/usr_1/JAMABANDI/jb--khasra-512-7--partial.pdf
 *
 *   infected    the scanner reports a signature match
 *   scanfail    the scanner is unreachable (ERRORED, not CLEAN)
 *   lowconf     every extracted field falls below the confidence floor
 *   partial     exactly two fields fall below it
 *   unreadable  nothing is extracted at all
 *   khasra-A-B  the khasra number reads "A/B"
 *   owner-x-y   the owner name reads "X Y"
 *
 * Replaced by a real virus scanner (a hook on the upload event) and a real OCR
 * AnalyzeDocument. Neither changes this interface.
 */

/** The usual default for an OCR service. Below this, a human fills the field in. */
export const EXTRACTION_HIGH_CONFIDENCE = 0.9;

export interface DocumentKeyMarkers {
  infected?: boolean;
  scanfail?: boolean;
  lowconf?: boolean;
  partial?: boolean;
  unreadable?: boolean;
  khasraNumber?: string;
  ownerName?: string;
}

/**
 * Reads the markers out of a key's final segment.
 *
 * Only the final segment, deliberately. Directory segments can contain a user
 * id or an uploaded filename, and a marker honoured there would let somebody
 * who uploads `report--infected.pdf` into a folder of their own naming steer
 * the scanner. A dev convention that doubles as an injection point is not a
 * dev convention.
 */
export function documentKeyMarkers(key: string): DocumentKeyMarkers {
  const segment = key.slice(key.lastIndexOf("/") + 1);
  const withoutExtension = segment.replace(/\.[^.]+$/, "");
  const [, ...tokens] = withoutExtension.split("--");

  const markers: DocumentKeyMarkers = {};

  for (const token of tokens) {
    const lower = token.toLowerCase();

    if (lower === "infected") markers.infected = true;
    else if (lower === "scanfail") markers.scanfail = true;
    else if (lower === "lowconf") markers.lowconf = true;
    else if (lower === "partial") markers.partial = true;
    else if (lower === "unreadable") markers.unreadable = true;
    else if (lower.startsWith("khasra-")) {
      markers.khasraNumber = token.slice("khasra-".length).replace(/-/g, "/");
    } else if (lower.startsWith("owner-")) {
      markers.ownerName = token
        .slice("owner-".length)
        .replace(/-/g, " ")
        .toUpperCase();
    }
  }

  return markers;
}

function assertKycDocsKey(key: string): void {
  if (!key.startsWith(KYC_DOCS_PREFIX)) {
    throw new Error(
      `Document key must start with ${KYC_DOCS_PREFIX} — got "${key}". ` +
        "Nothing outside the KYC bucket is scanned or extracted here.",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Scanner                                                            */
/* ------------------------------------------------------------------ */

/**
 * The signature name a real scanner returns for the EICAR test file. Used
 * verbatim so a log line from the fake reads the way a real one will.
 */
const EICAR_SIGNATURE = "Eicar-Test-Signature";

export class FakeDocumentScanner implements DocumentScanner {
  private readonly clock: () => Date;

  constructor(options: { clock?: () => Date } = {}) {
    this.clock = options.clock ?? (() => new Date());
  }

  async scan(params: { key: string }): Promise<ScanResult> {
    assertKycDocsKey(params.key);
    const markers = documentKeyMarkers(params.key);
    const scannedAt = this.clock();

    if (markers.infected) {
      return { status: "INFECTED", signature: EICAR_SIGNATURE, scannedAt };
    }

    /**
     * A scanner that is down is not a scanner that found nothing. ERRORED has
     * to stay distinguishable from CLEAN, or an outage silently approves every
     * document uploaded during it.
     */
    if (markers.scanfail) {
      return {
        status: "ERRORED",
        error: "clamd: connection refused",
        scannedAt,
      };
    }

    return { status: "CLEAN", scannedAt };
  }
}

/* ------------------------------------------------------------------ */
/* Extractor                                                          */
/* ------------------------------------------------------------------ */

/**
 * What each document type yields, and the plausible value for each field.
 *
 * The defaults line up with the dev land owner (Ramesh Kumar Sharma, Rohtak)
 * so a walkthrough matches on names without anybody typing anything, and the
 * markers exist for when it should not match.
 */
const FIELD_TEMPLATES: Partial<Record<DocumentType, Record<string, string>>> = {
  JAMABANDI: {
    khasraNumber: "127/3",
    ownerName: "RAMESH KUMAR SHARMA",
    village: "Kharawar",
    district: "Rohtak",
    areaAcres: "4.250",
  },
  KHASRA_KHATAUNI: {
    khasraNumber: "127/3",
    ownerName: "RAMESH KUMAR SHARMA",
    village: "Kharawar",
    district: "Rohtak",
    areaAcres: "4.250",
  },
  MUTATION_RECORD: {
    khasraNumber: "127/3",
    ownerName: "RAMESH KUMAR SHARMA",
    previousOwnerName: "SHIV CHARAN SHARMA",
    mutationNumber: "M-2219",
    mutationDate: "2019-07-14",
  },
  SALE_DEED: {
    /**
     * Both parties, not one. Which of them is our customer is the whole
     * question a reviewer answers, and a single "ownerName" field would let
     * the pipeline skip asking it.
     */
    sellerName: "SHIV CHARAN SHARMA",
    buyerName: "RAMESH KUMAR SHARMA",
    khasraNumber: "127/3",
    registrationNumber: "1456/2019",
    registrationDate: "2019-06-28",
  },
  GST_CERTIFICATE: {
    gstin: "06AABCU9603R1ZH",
    legalName: "SURYA AGRI SOLAR PRIVATE LIMITED",
    tradeName: "SURYA AGRI SOLAR",
    principalAddress: "Plot 14, Sector 34, Gurugram, Haryana",
  },
  BOARD_RESOLUTION: {
    companyName: "SURYA AGRI SOLAR PRIVATE LIMITED",
    signatoryName: "ANITA DESAI",
    designation: "Director",
    resolutionDate: "2026-04-02",
  },
  AUTHORISATION_LETTER: {
    signatoryName: "ANITA DESAI",
    designation: "Authorised Signatory",
    issuedDate: "2026-04-02",
  },
  PARTNERSHIP_DEED: {
    firmName: "DESAI AND SONS",
    partnerNames: "ANITA DESAI, VIKRAM DESAI",
    deedDate: "2021-11-09",
  },
  UDYAM_CERTIFICATE: {
    udyamNumber: "UDYAM-HR-05-0012345",
    enterpriseName: "SURYA AGRI SOLAR PRIVATE LIMITED",
  },
};

/**
 * The fields that come out worst in practice.
 *
 * On a land record these are the handwritten and stamped entries — the margin
 * figures and the khasra number written in by hand — not the printed header.
 * `partial` degrades these rather than a random pair, so the common real
 * failure is the one development sees.
 */
const HARD_TO_READ: Partial<Record<DocumentType, string[]>> = {
  JAMABANDI: ["khasraNumber", "areaAcres"],
  KHASRA_KHATAUNI: ["khasraNumber", "areaAcres"],
  MUTATION_RECORD: ["mutationNumber", "mutationDate"],
  SALE_DEED: ["registrationNumber", "registrationDate"],
  GST_CERTIFICATE: ["principalAddress", "tradeName"],
  BOARD_RESOLUTION: ["resolutionDate", "designation"],
  AUTHORISATION_LETTER: ["issuedDate", "designation"],
  PARTNERSHIP_DEED: ["deedDate", "partnerNames"],
  UDYAM_CERTIFICATE: ["udyamNumber", "enterpriseName"],
};

/**
 * Confidences vary per field rather than being one constant, because code
 * written against a single value tends to compare with `===` somewhere.
 * Derived from the field name, so a given field always reads the same.
 */
function confidenceFor(fieldName: string, low: boolean): number {
  let sum = 0;
  for (const char of fieldName) sum += char.charCodeAt(0);

  return low
    ? Number((0.6 + (sum % 20) / 100).toFixed(2))
    : Number((0.9 + (sum % 9) / 100).toFixed(2));
}

export class FakeDocumentExtractor implements DocumentExtractor {
  async extract(params: {
    key: string;
    docType: DocumentType;
  }): Promise<ExtractionResult> {
    assertKycDocsKey(params.key);
    const markers = documentKeyMarkers(params.key);

    /**
     * A selfie has no text, and an unreadable scan yields nothing. An empty
     * field set is the honest answer in both cases, and the pipeline has to
     * cope with it rather than assuming every document produces data.
     */
    const template = FIELD_TEMPLATES[params.docType];
    if (!template || markers.unreadable) {
      return { fields: {}, extractedAt: new Date() };
    }

    const hardToRead = markers.partial ? (HARD_TO_READ[params.docType] ?? []) : [];

    const fields: Record<string, ExtractedField> = {};
    for (const [name, defaultValue] of Object.entries(template)) {
      const value =
        name === "khasraNumber" && markers.khasraNumber
          ? markers.khasraNumber
          : (name === "ownerName" || name === "buyerName") && markers.ownerName
            ? markers.ownerName
            : defaultValue;

      fields[name] = {
        value,
        confidence: confidenceFor(
          name,
          Boolean(markers.lowconf) || hardToRead.includes(name),
        ),
      };
    }

    return { fields, extractedAt: new Date() };
  }
}

/* ------------------------------------------------------------------ */
/* What a developer can reach from the browser                        */
/* ------------------------------------------------------------------ */

/**
 * Offered in the UI for the same reason the KYC scenario list is: an outcome
 * nobody can reach is an outcome nobody tests, and "infected document" is the
 * one outcome here with a security consequence.
 */
export const DEV_DOCUMENT_EXAMPLES = [
  {
    label: "Clean, fully legible",
    keySuffix: "",
    outcome: "Scan CLEAN, every field pre-filled, no review needed",
  },
  {
    label: "Faded photocopy, two fields illegible",
    keySuffix: "--partial",
    outcome: "Scan CLEAN, 2 low-confidence fields → manual review",
  },
  {
    label: "Barely legible throughout",
    keySuffix: "--lowconf",
    outcome: "Scan CLEAN, nothing pre-filled → manual review",
  },
  {
    label: "Blank or corrupt page",
    keySuffix: "--unreadable",
    outcome: "Scan CLEAN, no fields extracted → manual review",
  },
  {
    label: "Infected file",
    keySuffix: "--infected",
    outcome: "Scan INFECTED → quarantined, unusable for anything",
  },
  {
    label: "Scanner unreachable",
    keySuffix: "--scanfail",
    outcome: "Scan ERRORED → retried, never treated as clean",
  },
  {
    label: "Land record in somebody else's name",
    keySuffix: "--owner-anita-desai",
    outcome: "Scan CLEAN, owner name does not match the KYC name → review",
  },
] as const satisfies readonly {
  label: string;
  keySuffix: string;
  outcome: string;
}[];
