import { z } from "zod";
import { isValidAadhaarNumber } from "./aadhaar.js";
import { isValidCin, isValidLlpin } from "./identifiers.js";
import { gstinCheckDigit, GSTIN_REGEX, normaliseGstin } from "./gstin.js";
import { isValidPan, normalisePan } from "./pan.js";

/**
 * Request schemas, shared by the browser form (React Hook Form), the API's
 * validation pipe, and the DB boundary. One definition, three places — a rule
 * that exists in only one of them is not a rule.
 */

/* ------------------------------------------------------------------ */
/* Consent                                                            */
/* ------------------------------------------------------------------ */

/**
 * Every purpose we may collect personal data for is named here. DPDP requires
 * consent per purpose, so this list is the contract: nothing can be collected
 * for a purpose that is not on it.
 */
export const CONSENT_PURPOSES = [
  "KYC_VERIFICATION",
  "KYB_VERIFICATION",
  "LAND_OWNERSHIP_VERIFICATION",
  "AGREEMENT_ESIGN",
] as const;

export const ConsentInputSchema = z.object({
  purpose: z.enum(CONSENT_PURPOSES),
  /** The version of the notice text actually rendered to the user. */
  noticeVersion: z.string().min(1).max(16),
  /** Optional free-text locale so we can prove which language they read. */
  locale: z.enum(["en", "hi"]).default("en"),
});

export type ConsentInput = z.infer<typeof ConsentInputSchema>;

/* ------------------------------------------------------------------ */
/* PAN                                                                */
/* ------------------------------------------------------------------ */

export const PanSchema = z
  .string()
  .transform(normalisePan)
  .refine(isValidPan, { message: "Enter a valid 10-character PAN, e.g. ABCPS4412K" });

export const PanCheckInputSchema = z.object({
  pan: PanSchema,
});

export type PanCheckInput = z.infer<typeof PanCheckInputSchema>;

/* ------------------------------------------------------------------ */
/* GSTIN                                                              */
/* ------------------------------------------------------------------ */

export const GstinSchema = z
  .string()
  .transform(normaliseGstin)
  .refine((value) => GSTIN_REGEX.test(value), {
    message: "Enter a valid 15-character GSTIN, e.g. 27AAPFU0939F1ZV",
  })
  .refine((value) => gstinCheckDigit(value.slice(0, 14)) === value[14], {
    message: "That GSTIN's check digit is wrong — please re-check the last character",
  });

export const GstinInputSchema = z.object({
  gstin: GstinSchema,
});

export type GstinInput = z.infer<typeof GstinInputSchema>;

/* ------------------------------------------------------------------ */
/* Company identifiers                                                */
/* ------------------------------------------------------------------ */

export const CinSchema = z
  .string()
  .transform((v) => v.replace(/\s/g, "").toUpperCase())
  .refine(isValidCin, { message: "Enter a valid 21-character CIN" });

export const LlpinSchema = z
  .string()
  .transform((v) => v.replace(/\s/g, "").toUpperCase())
  .refine(isValidLlpin, { message: "Enter a valid LLPIN, e.g. AAB-1234" });

/* ------------------------------------------------------------------ */
/* KYB                                                                */
/* ------------------------------------------------------------------ */

/**
 * Starting a business check needs only the GSTIN.
 *
 * Everything else — the legal name, the constitution, the state, the business
 * PAN — is derived from it or returned by the lookup. Asking for any of them
 * would be asking the customer to retype what we are about to be told
 * authoritatively, and giving them the chance to type it wrong.
 */
export const CreateOrganisationInputSchema = z.object({
  gstin: GstinSchema,
});

export type CreateOrganisationInput = z.infer<typeof CreateOrganisationInputSchema>;

/**
 * The company register identifier.
 *
 * Exactly one of the two, because which one applies follows from the
 * constitution the GST lookup returned — a company has a CIN, an LLP an
 * LLPIN, and a proprietorship neither.
 */
export const CompanyRegisterInputSchema = z
  .object({
    cin: CinSchema.optional(),
    llpin: LlpinSchema.optional(),
  })
  .refine((value) => Boolean(value.cin) !== Boolean(value.llpin), {
    message: "Provide exactly one of cin or llpin",
  });

export type CompanyRegisterInput = z.infer<typeof CompanyRegisterInputSchema>;

/**
 * Declaring who will sign.
 *
 * The signatory is the authenticated caller — somebody nominating a third
 * party would be asserting authority over a person who has not consented, and
 * the whole point of this check is that the signatory proves their own
 * identity.
 */
export const SignatoryInputSchema = z.object({
  /**
   * The board resolution, authorisation letter or partnership deed. Optional
   * at this point: it can be uploaded before or after declaring intent, and
   * Legal approves it either way.
   */
  authorityDocumentId: z.string().uuid().optional(),
});

export type SignatoryInput = z.infer<typeof SignatoryInputSchema>;

/* ------------------------------------------------------------------ */
/* Aadhaar — OTP route only                                           */
/* ------------------------------------------------------------------ */

/**
 * The twelve digits, checked offline before they cost a gateway call.
 *
 * `isValidAadhaarNumber` runs the Verhoeff checksum, which catches a single
 * mistyped digit and most transpositions — the two commonest ways somebody
 * gets their own number wrong.
 */
export const AadhaarOtpRequestSchema = z.object({
  aadhaarNumber: z
    .string()
    .transform((v) => v.replace(/\s|-/g, ""))
    .refine(isValidAadhaarNumber, {
      message: "That does not look like a valid Aadhaar number. Please check the twelve digits.",
    }),
});

export type AadhaarOtpRequest = z.infer<typeof AadhaarOtpRequestSchema>;

/**
 * Only the six digits.
 *
 * The reference id used to be sent up with them, which meant the client chose
 * which challenge to verify against. The server now holds it against the
 * signed-in person, so there is nothing here for a caller to point at but
 * their own live attempt.
 */
export const AadhaarOtpVerifySchema = z.object({
  otp: z.string().regex(/^[0-9]{6}$/, "The OTP is six digits."),
});

export type AadhaarOtpVerify = z.infer<typeof AadhaarOtpVerifySchema>;


/**
 * Only used on the OTP eKYC route, where the user types the number.
 *
 * SECURITY: a value parsed by this schema must never be persisted, logged, or
 * put in an error message. It is handed to the vendor and dropped. The
 * DigiLocker and OVSE routes never produce one of these at all.
 */
export const AadhaarNumberSchema = z
  .string()
  .transform((v) => v.replace(/[\s-]/g, ""))
  .refine(isValidAadhaarNumber, { message: "That Aadhaar number is not valid" });

/* ------------------------------------------------------------------ */
/* KYC session                                                        */
/* ------------------------------------------------------------------ */

export const KYC_LEVELS = ["PAN_ONLY", "FULL", "KYB"] as const;
export const KYC_SUBJECT_TYPES = ["PERSON", "ORGANISATION"] as const;

/**
 * Outcomes the fake provider can be asked for.
 *
 * Development and staging only — the API drops this field in production, so a
 * client sending it cannot choose its own verification result. Kept in the
 * schema rather than bolted on at the controller so the field is typed and
 * visible wherever the request shape is read.
 */
export const FAKE_SCENARIO_IDS = [
  "pass",
  "low_face_score",
  "liveness_fail",
  "pan_name_mismatch",
  "pan_inoperative",
  "pan_deactivated",
  "minor",
  "aadhaar_failed",
  "vendor_timeout",
  "late_webhook",
] as const;

export const CreateKycSessionInputSchema = z.object({
  level: z.enum(KYC_LEVELS),
  subjectType: z.enum(KYC_SUBJECT_TYPES).default("PERSON"),
  /** Which role the user is doing this for, so we know the extra steps. */
  role: z.enum(["INVESTOR", "LAND_OWNER", "COMMERCIAL", "SIGNATORY"]),
  consentId: z.string().uuid(),
  locale: z.enum(["en", "hi"]).default("en"),
  /** Ignored in production. See FAKE_SCENARIO_IDS. */
  testScenario: z.enum(FAKE_SCENARIO_IDS).optional(),
});

export type CreateKycSessionInput = z.infer<typeof CreateKycSessionInputSchema>;

/* ------------------------------------------------------------------ */
/* Admin review                                                       */
/* ------------------------------------------------------------------ */

export const REVIEW_ACTIONS = ["APPROVE", "REJECT", "REQUEST_RESUBMISSION"] as const;

export const ReviewActionInputSchema = z.object({
  action: z.enum(REVIEW_ACTIONS),
  /** A reason code is mandatory — no silent approvals. */
  reasonCode: z.string().min(2).max(64),
  note: z.string().max(2000).optional(),
});

export type ReviewActionInput = z.infer<typeof ReviewActionInputSchema>;

/* ------------------------------------------------------------------ */
/* Documents                                                          */
/* ------------------------------------------------------------------ */

export const DOCUMENT_TYPES = [
  "SELFIE",
  "GST_CERTIFICATE",
  "SALE_DEED",
  "JAMABANDI",
  "KHASRA_KHATAUNI",
  "MUTATION_RECORD",
  "BOARD_RESOLUTION",
  "AUTHORISATION_LETTER",
  "PARTNERSHIP_DEED",
  "UDYAM_CERTIFICATE",
  "OTHER",
] as const;

/**
 * What may be uploaded.
 *
 * An allowlist, not a denylist. A signed URL for an executable is a signed URL
 * to host malware on our own domain, and the browser's reported type is not
 * evidence of anything — which is why the type is signed into the upload URL
 * so the bucket enforces it too.
 *
 * HEIC is here because iPhones produce it by default and a customer
 * photographing a Jamabandi on a phone is the normal case, not the exception.
 */
export const ALLOWED_UPLOAD_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
] as const;

/**
 * 25 MB.
 *
 * Generous for a multi-page certified copy scanned at 300 dpi, and small
 * enough that a stalled upload is not a ten-minute wait on a rural
 * connection. Enforced before a URL is issued and signed into the URL, so the
 * bucket refuses an oversized PUT rather than accepting it and leaving us to
 * delete it afterwards.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * The scan and extraction outcomes a developer can ask for.
 *
 * An allowlist, not free text. The chosen value is written into the object
 * key, so anything accepted here reaches a storage path — and a key is exactly
 * the kind of string that must never be assembled from user input.
 *
 * Dropped in production, like the KYC session's testScenario, for the same
 * reason: a client that could request "clean" would be requesting a document
 * nobody scanned.
 */
export const DOCUMENT_TEST_MARKERS = [
  "partial",
  "lowconf",
  "unreadable",
  "infected",
  "scanfail",
  "owner-anita-desai",
] as const;

export type DocumentTestMarker = (typeof DOCUMENT_TEST_MARKERS)[number];

export const UploadUrlInputSchema = z.object({
  docType: z.enum(DOCUMENT_TYPES),
  /**
   * Used only for its extension and to show the customer what they picked.
   * The stored key is chosen by the server: a client-named key lets one
   * customer write over another's deed, and both keys would pass a prefix
   * check.
   */
  fileName: z.string().min(1).max(200),
  contentType: z.enum(ALLOWED_UPLOAD_TYPES),
  sizeBytes: z.coerce.number().int().positive().max(MAX_UPLOAD_BYTES),
  /**
   * Development only. The API drops these outside development, so a client
   * cannot choose the scan result of its own upload.
   *
   * A list rather than one value: the interesting cases are combinations. "A
   * different plot, registered in somebody else's name" is two markers, and
   * with a single field it was unreachable — which the first walkthrough of
   * the land flow ran into immediately.
   */
  testMarkers: z.array(z.enum(DOCUMENT_TEST_MARKERS)).max(4).optional(),

  /**
   * Development only: which khasra number the extractor should report.
   *
   * Its own field rather than a marker because it is parameterised, and an
   * allowlist cannot enumerate every plot in Haryana. The regex is what keeps
   * it safe — digits and at most one slash, so nothing that reaches a storage
   * key can contain a path segment, a dot or a dash sequence.
   */
  testKhasra: z
    .string()
    .regex(/^[0-9]{1,4}(\/[0-9]{1,4})?$/, "must look like 127 or 127/3")
    .optional(),
});

export type UploadUrlInput = z.infer<typeof UploadUrlInputSchema>;

export const ConfirmUploadInputSchema = z.object({
  storageKey: z.string().min(1).max(512),
  /** Lets us prove the stored file is the file the browser sent. */
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "must be a 64-character lowercase hex digest"),
});

export type ConfirmUploadInput = z.infer<typeof ConfirmUploadInputSchema>;

/**
 * The other people a registry record names as holding a share.
 *
 * Declared by the customer rather than read off the document, deliberately.
 * OCR on a faded Jamabandi cannot be trusted to find every name in a margin,
 * and a co-owner it missed is the one failure mode that matters here — a lease
 * the other holders can have set aside after the panels are installed.
 *
 * So the customer is asked, and Legal confirms. Two independent sources beat
 * one unreliable one.
 */
export const CoOwnersInputSchema = z.object({
  coOwnerNames: z
    .array(z.string().trim().min(2).max(120))
    .max(20, "If the land has more than 20 holders, please talk to us directly."),
});

export type CoOwnersInput = z.infer<typeof CoOwnersInputSchema>;

export const CoOwnerConsentInputSchema = z.object({
  note: z.string().max(2000).optional(),
});

export type CoOwnerConsentInput = z.infer<typeof CoOwnerConsentInputSchema>;

export const DocumentReviewInputSchema = z
  .object({
    approved: z.boolean(),
    reasonCode: z.string().min(2).max(64).optional(),
    note: z.string().max(2000).optional(),
  })
  /**
   * A rejection must say why. The customer is going to be asked for another
   * document, and "rejected" with no reason means support cannot tell them
   * what to send instead.
   */
  .refine((value) => value.approved || Boolean(value.reasonCode), {
    message: "A reasonCode is required when rejecting a document.",
    path: ["reasonCode"],
  });

export type DocumentReviewInput = z.infer<typeof DocumentReviewInputSchema>;
