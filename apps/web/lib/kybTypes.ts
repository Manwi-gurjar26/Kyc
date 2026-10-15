/** What the KYB endpoints return. Mirrors apps/api OrganisationView. */

export type KycStatus =
  | "NOT_STARTED"
  | "IN_PROGRESS"
  | "MANUAL_REVIEW"
  | "VERIFIED"
  | "REJECTED"
  | "BLOCKED";

export interface OrganisationView {
  id: string;
  gstin: string;
  legalName: string;
  tradeName: string | null;
  constitution: string | null;
  gstStatus: string;
  stateCode: string | null;
  /** Masked. The full business PAN is only ever inside the GSTIN. */
  businessPanLast4: string | null;
  cinOrLlpin: string | null;
  companyStatus: string | null;
  kybStatus: KycStatus;
  requiresCompanyRegister: boolean;
  /**
   * What the API says is still outstanding.
   *
   * This is the state machine, and the UI only renders it. The steps are not
   * fixed — a proprietorship has no company register — so inferring them in
   * the browser would mean two definitions of the flow, one of which would be
   * wrong.
   */
  remainingSteps: string[];
  signatory: {
    userId: string;
    isCaller: boolean;
    personalKycStatus: KycStatus;
    hasAuthorityDocument: boolean;
    authorityApproved: boolean;
  } | null;
}

export interface KybExample {
  label: string;
  gstin: string;
  cin: string | null;
  outcome: string;
}

/** Written for the person reading them, not for the developer. */
export const KYB_STEP_COPY: Record<string, { title: string; help: string }> = {
  COMPANY_REGISTER: {
    title: "Your company registration",
    help: "Because you are a registered company, we also check you against the Ministry of Corporate Affairs register.",
  },
  SIGNATORY: {
    title: "Who will sign",
    help: "A 25-year agreement is only safe if the right person signs it.",
  },
  SIGNATORY_PERSONAL_KYC: {
    title: "The signatory's own verification",
    help: "The person signing verifies their own identity — Aadhaar, PAN and a selfie — exactly as an individual would.",
  },
};
