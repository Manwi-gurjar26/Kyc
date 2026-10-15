/**
 * The shapes the documents endpoints return.
 *
 * Hand-written rather than generated, deliberately: these mirror what the API
 * actually sends, and a generated type would mirror what the service happens
 * to return today — including fields the browser has no business seeing.
 */

export interface ExtractedFieldView {
  value: string;
  confidence: number;
}

export interface UploadTargetView {
  url: string;
  key: string;
  contentType: string;
  maxBytes: number;
  expiresAt: string;
}

export interface ConfirmedUploadView {
  documentId: string;
  scanStatus: "PENDING" | "CLEAN" | "INFECTED" | "ERRORED";
  lowConfidenceFieldCount: number;
  needsManualReview: boolean;
  fields: Record<string, ExtractedFieldView>;
}

export interface DownloadUrlView {
  url: string;
  expiresAt: string;
  docType: string;
}

export interface DecisionReasonView {
  code: string;
  detail: string;
  severity: "HARD_FAIL" | "REVIEW" | "FLAG";
}

export interface ParcelView {
  id: string;
  khasraNumber: string;
  village: string | null;
  district: string | null;
  areaAcres: string | null;
  ownerNameOnRecord: string | null;
  ownerNameMatchScore: string | null;
  coOwnerNames: string[];
  coOwnerConsentConfirmed: boolean;
  verificationStatus: "NOT_STARTED" | "IN_PROGRESS" | "MANUAL_REVIEW" | "VERIFIED" | "REJECTED" | "BLOCKED";
  documentsApproved: boolean;
  reasons: DecisionReasonView[];
  decidedAt: string | null;
  createdAt: string;
}

export interface QueuedDocumentView {
  id: string;
  docType: string;
  ownerUserId: string | null;
  ownerOrgId: string | null;
  scanStatus: string;
  lowConfidenceFieldCount: number | null;
  createdAt: string;
}

/** The field order a reviewer reads a land record in. */
export const LAND_FIELD_ORDER = [
  "khasraNumber",
  "ownerName",
  "village",
  "district",
  "areaAcres",
  "sellerName",
  "buyerName",
  "registrationNumber",
  "registrationDate",
] as const;

export const FIELD_LABELS: Record<string, string> = {
  khasraNumber: "Khasra number",
  ownerName: "Owner name",
  village: "Village",
  district: "District",
  areaAcres: "Area (acres)",
  sellerName: "Seller",
  buyerName: "Buyer",
  registrationNumber: "Registration number",
  registrationDate: "Registered on",
  previousOwnerName: "Previous owner",
  mutationNumber: "Mutation number",
  mutationDate: "Mutation date",
  gstin: "GSTIN",
  legalName: "Legal name",
  tradeName: "Trade name",
  principalAddress: "Principal address",
  companyName: "Company",
  signatoryName: "Signatory",
  designation: "Designation",
  resolutionDate: "Resolution date",
  issuedDate: "Issued on",
  firmName: "Firm name",
  partnerNames: "Partners",
  deedDate: "Deed date",
  udyamNumber: "Udyam number",
  enterpriseName: "Enterprise",
};

/** Mirrors EXTRACTION_CONFIDENCE_FLOOR in the pipeline. */
export const CONFIDENCE_FLOOR = 0.85;

export function labelFor(field: string): string {
  return (
    FIELD_LABELS[field] ??
    field.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase())
  );
}

/**
 * Sorts fields into the order a human reads them, with anything unrecognised
 * after the known ones rather than dropped — a field we do not have a label
 * for is still a field the reviewer needs to see.
 */
export function orderedFields(
  fields: Record<string, ExtractedFieldView>,
): [string, ExtractedFieldView][] {
  const known = LAND_FIELD_ORDER as readonly string[];
  return Object.entries(fields).sort(([a], [b]) => {
    const ia = known.indexOf(a);
    const ib = known.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}
