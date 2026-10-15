/** Response shapes for the admin endpoints. */

export interface Thresholds {
  faceMatch: number;
  nameMatch: number;
  documentConfidence: number;
  maxLowConfidenceFields: number;
  minimumAge: number;
}

export type CaseType = "PERSONAL" | "KYB" | "LAND_DOCUMENTS";

export interface QueueRow {
  id: string;
  subjectName: string | null;
  subjectType: string;
  level: string;
  caseType: CaseType;
  reasonCodes: string[];
  faceMatchScore: number | null;
  createdAt: string;
  waitingHours: number;
  actionable: boolean;
}

export interface QueueResponse {
  rows: QueueRow[];
  thresholds: Thresholds;
  health: { open: number; oldestHours: number | null };
}

export interface CaseDetailResponse extends QueueRow {
  status: string;
  aadhaarLast4: string | null;
  panLast4: string | null;
  vendor: string | null;
  vendorVersion: string | null;
  reasons: { code: string; detail: string; severity: string }[];
  thresholdsUsed: Thresholds | null;
  thresholds: Thresholds;
  checks: {
    checkType: string;
    status: string;
    score: number | null;
    detail: string | null;
    attemptNumber: number;
    createdAt: string;
  }[];
  documents: {
    id: string;
    docType: string;
    scanStatus: string;
    lowConfidenceFieldCount: number | null;
    createdAt: string;
  }[];
  timeline: {
    action: string;
    actorType: string;
    reasonCode: string | null;
    note: string | null;
    createdAt: string;
  }[];
}

/**
 * Reason codes a reviewer can pick, grouped by the action they go with.
 *
 * A free-text box would be worse: the audit log has to be searchable, and
 * "looks fine" typed forty different ways is not. The note field is where the
 * prose goes.
 */
export const REASON_CODES: Record<string, { code: string; label: string }[]> = {
  APPROVE: [
    {
      code: "FACE_MATCH_ACCEPTED_ON_REVIEW",
      label: "Same person — the Aadhaar photo is just old",
    },
    {
      code: "NAME_VARIANT_ACCEPTED",
      label: "Name difference explained (marriage, initials, spelling)",
    },
    { code: "DOCUMENT_VERIFIED", label: "Documents checked and genuine" },
    { code: "DUPLICATE_RESOLVED", label: "Duplicate account resolved" },
  ],
  REJECT: [
    { code: "DOCUMENT_NOT_GENUINE", label: "Documents are not genuine" },
    { code: "FACE_MATCH_DIFFERENT_PERSON", label: "Not the same person" },
    { code: "DETAILS_DO_NOT_MATCH", label: "Details do not match the records" },
    { code: "FRAUD_SUSPECTED", label: "Fraud suspected — escalating" },
  ],
  REQUEST_RESUBMISSION: [
    { code: "SELFIE_TOO_DARK", label: "Selfie too dark or blurred" },
    { code: "DOCUMENT_UNREADABLE", label: "Document scan is unreadable" },
    { code: "DOCUMENT_INCOMPLETE", label: "A page or document is missing" },
    { code: "WRONG_DOCUMENT", label: "Wrong document uploaded" },
  ],
};
