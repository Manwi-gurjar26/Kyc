import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * KYC schema.
 *
 * Three rules shape every table here:
 *
 *  1. The Aadhaar number does not exist in this database. There is no column
 *     that could hold one. `aadhaar_last4` and `aadhaar_ref_token` are all we
 *     are permitted to keep, and a schema with nowhere to put the full number
 *     is a stronger guarantee than a code review.
 *
 *  2. Anything sensitive is stored encrypted, with a blind index beside it
 *     when it has to be searchable. Encrypted columns are `text` holding an
 *     envelope-encryption payload, never the plaintext.
 *
 *  3. `kyc_checks` and `audit_log` are append-only. A mistake is corrected by
 *     adding a row, never by editing one. Database triggers enforce this, not
 *     convention — see the migration.
 */

/* ------------------------------------------------------------------ */
/* Enums                                                              */
/* ------------------------------------------------------------------ */

export const kycStatusEnum = pgEnum("kyc_status", [
  "NOT_STARTED",
  "IN_PROGRESS",
  "MANUAL_REVIEW",
  "VERIFIED",
  "REJECTED",
  "BLOCKED",
]);

export const kycLevelEnum = pgEnum("kyc_level", ["PAN_ONLY", "FULL", "KYB"]);

export const subjectTypeEnum = pgEnum("kyc_subject_type", [
  "PERSON",
  "ORGANISATION",
]);

/** One row in kyc_checks per attempt of each of these. */
export const checkTypeEnum = pgEnum("kyc_check_type", [
  "AADHAAR",
  "PAN",
  "LIVENESS",
  "FACE_MATCH",
  "GST",
  "CIN",
  "LLPIN",
  "LAND_DOCUMENTS",
  "NAME_MATCH",
]);

export const checkStatusEnum = pgEnum("kyc_check_status", [
  "PENDING",
  "PASSED",
  "FAILED",
  "ERRORED",
]);

export const documentTypeEnum = pgEnum("document_type", [
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
]);

export const scanStatusEnum = pgEnum("scan_status", [
  "PENDING",
  "CLEAN",
  "INFECTED",
  "ERRORED",
]);

export const gstStatusEnum = pgEnum("gst_status", [
  "ACTIVE",
  "CANCELLED",
  "SUSPENDED",
  "UNKNOWN",
]);

export const consentPurposeEnum = pgEnum("consent_purpose", [
  "KYC_VERIFICATION",
  "KYB_VERIFICATION",
  "LAND_OWNERSHIP_VERIFICATION",
  "AGREEMENT_ESIGN",
]);

export const outboxStatusEnum = pgEnum("outbox_status", [
  "PENDING",
  "PROCESSING",
  "DONE",
  "DEAD",
]);

/* ------------------------------------------------------------------ */
/* Identity (the minimum the KYC module needs)                        */
/* ------------------------------------------------------------------ */

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Phone is the unique identity on this platform, not email. */
    phoneE164: text("phone_e164").notNull(),
    phoneVerifiedAt: timestamp("phone_verified_at", { withTimezone: true }),
    displayName: text("display_name"),
    locale: text("locale").notNull().default("en"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Soft delete: DPDP erasure still has to respect tax retention. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("users_phone_unique").on(t.phoneE164)],
);

/* ------------------------------------------------------------------ */
/* Consent (DPDP)                                                     */
/* ------------------------------------------------------------------ */

/**
 * One row per purpose consented to, carrying the exact notice version the
 * person saw and the language they read it in. Without the version, "they
 * agreed" is unprovable.
 */
export const consentRecords = pgTable(
  "consent_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    purpose: consentPurposeEnum("purpose").notNull(),
    noticeVersion: text("notice_version").notNull(),
    locale: text("locale").notNull().default("en"),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    /** Kept for the audit trail; truncated and never used for analytics. */
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
  },
  (t) => [
    index("consent_user_purpose_idx").on(t.userId, t.purpose),
    index("consent_withdrawn_idx").on(t.withdrawnAt),
  ],
);

/* ------------------------------------------------------------------ */
/* Organisations (Commercial Users)                                   */
/* ------------------------------------------------------------------ */

export const organisations = pgTable(
  "organisations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    legalName: text("legal_name").notNull(),
    tradeName: text("trade_name"),
    gstin: text("gstin").notNull(),
    /** Pvt Ltd, LLP, Partnership, Proprietorship... from the GST lookup. */
    constitution: text("constitution"),
    cinOrLlpin: text("cin_or_llpin"),
    gstStatus: gstStatusEnum("gst_status").notNull().default("UNKNOWN"),
    registeredAddressEncrypted: text("registered_address_encrypted"),
    /** Derived from GSTIN characters 3-12, never asked for separately. */
    businessPanLast4: text("business_pan_last4"),
    kybStatus: kycStatusEnum("kyb_status").notNull().default("NOT_STARTED"),

    /**
     * The MCA register's own result.
     *
     * Stored as data rather than recovered from the CIN check's prose. A
     * hard-fail decision that gates a 25-year agreement should not depend on
     * a sentence written for a human reviewer.
     *
     * Null when the constitution has no company register — a proprietorship
     * has no CIN, and treating that absence as a failure would make every
     * proprietor unverifiable.
     */
    companyStatus: text("company_status"),
    companyNameMatchesGst: boolean("company_name_matches_gst"),
    stateCode: text("state_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** One organisation per GSTIN — two would split the invoice history. */
    uniqueIndex("organisations_gstin_unique").on(t.gstin),
    index("organisations_kyb_status_idx").on(t.kybStatus),
  ],
);

export const orgRoleEnum = pgEnum("org_role", ["SIGNATORY", "ADMIN", "FINANCE"]);

export const orgMembers = pgTable(
  "org_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organisations.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: orgRoleEnum("role").notNull(),
    /**
     * The board resolution or authorisation letter that makes this person a
     * signatory. Legal reads it by hand; nothing automates who may bind a
     * 25-year contract.
     */
    authorityDocumentId: uuid("authority_document_id"),
    authorityApprovedBy: uuid("authority_approved_by").references(() => users.id),
    authorityApprovedAt: timestamp("authority_approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("org_members_unique").on(t.orgId, t.userId, t.role),
    index("org_members_user_idx").on(t.userId),
  ],
);

/* ------------------------------------------------------------------ */
/* KYC records                                                        */
/* ------------------------------------------------------------------ */

/**
 * The current KYC of one person or one business.
 *
 * Notice what is absent: any column capable of holding a 12-digit Aadhaar
 * number. That is deliberate and is the strongest form the rule can take.
 */
export const kycRecords = pgTable(
  "kyc_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectType: subjectTypeEnum("subject_type").notNull(),
    userId: uuid("user_id").references(() => users.id),
    orgId: uuid("org_id").references(() => organisations.id),

    level: kycLevelEnum("level").notNull(),
    status: kycStatusEnum("status").notNull().default("NOT_STARTED"),

    vendor: text("vendor"),
    vendorSessionId: text("vendor_session_id"),
    vendorVersion: text("vendor_version"),

    /** The only Aadhaar data we are allowed to hold. */
    aadhaarLast4: text("aadhaar_last4"),
    aadhaarRefToken: text("aadhaar_ref_token"),

    /**
     * The name and date of birth UIDAI returned, held for one purpose: the
     * Income Tax Department's PAN check needs a name and a date to match
     * against, and both have to come from Aadhaar.
     *
     * Sending the name the person typed instead would make the match
     * meaningless — it is a name they can read off the card in front of them.
     * So these two columns exist because `nameMatch` is only evidence if we
     * did not let the subject choose the input.
     *
     * The date earns its place twice. `decideKyc()` fails a minor outright,
     * and without the date stored that decision cannot be re-derived at
     * review time — which the rest of this table goes to some trouble to make
     * possible.
     *
     * Still no Aadhaar number, here or anywhere.
     */
    aadhaarName: text("aadhaar_name"),
    /** ISO date, YYYY-MM-DD. */
    aadhaarDob: text("aadhaar_dob"),
    /**
     * Object-store key for the UIDAI photograph. Never the image itself.
     *
     * A reviewer compares this against the uploaded selfie by eye, because
     * the gateway offers no face match to do it for them. The bytes live in
     * the bucket with every other raw vendor artefact; a base64 JPEG in a row
     * would ride along in every backup, replica and `SELECT *`, which is no
     * way to treat a biometric.
     */
    aadhaarPhotoKey: text("aadhaar_photo_key"),

    /** Envelope ciphertext. Decrypted only by roles that need it. */
    panEncrypted: text("pan_encrypted"),
    panLast4: text("pan_last4"),
    /**
     * HMAC-SHA256(key, normalised PAN). Unique, which is what makes the
     * duplicate-PAN rule enforceable without ever decrypting a stored PAN.
     */
    panBlindIndex: text("pan_blind_index"),

    livenessPassed: boolean("liveness_passed"),
    faceMatchScore: numeric("face_match_score", { precision: 4, scale: 3 }),
    nameMatchScore: numeric("name_match_score", { precision: 4, scale: 3 }),

    /** The reasons decideKyc() returned, verbatim, with severities. */
    decisionReasons: jsonb("decision_reasons").$type<
      { code: string; detail: string; severity: string }[]
    >(),
    /** The thresholds in force when the decision was made, for reproducibility. */
    thresholdsUsed: jsonb("thresholds_used").$type<Record<string, number>>(),

    consentId: uuid("consent_id").references(() => consentRecords.id),

    reviewedBy: uuid("reviewed_by").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewReasonCode: text("review_reason_code"),

    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * One PAN, one subject. This single index is the whole free-trial-abuse
     * defence and the duplicate-account check.
     */
    uniqueIndex("kyc_records_pan_blind_index_unique").on(t.panBlindIndex),
    uniqueIndex("kyc_records_vendor_session_unique").on(t.vendorSessionId),
    index("kyc_records_user_idx").on(t.userId),
    index("kyc_records_org_idx").on(t.orgId),
    index("kyc_records_status_idx").on(t.status),
    /** The review queue reads this: open cases, oldest first. */
    index("kyc_records_review_queue_idx").on(t.status, t.createdAt),
  ],
);

/**
 * Every attempt of every check, append-only.
 *
 * A failed attempt followed by a successful one leaves both rows. Deleting the
 * failure would hide exactly the pattern a fraud review looks for.
 */
export const kycChecks = pgTable(
  "kyc_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kycRecordId: uuid("kyc_record_id")
      .notNull()
      .references(() => kycRecords.id),
    checkType: checkTypeEnum("check_type").notNull(),
    status: checkStatusEnum("status").notNull(),
    score: numeric("score", { precision: 5, scale: 4 }),
    vendor: text("vendor"),
    vendorVersion: text("vendor_version"),
    /** Object-store key of the raw vendor response, stored encrypted. */
    rawResponseKey: text("raw_response_key"),
    /** Why it landed this way, for the reviewer. */
    detail: text("detail"),
    attemptNumber: integer("attempt_number").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("kyc_checks_record_idx").on(t.kycRecordId, t.createdAt),
    index("kyc_checks_type_idx").on(t.checkType, t.status),
  ],
);

/* ------------------------------------------------------------------ */
/* Documents                                                          */
/* ------------------------------------------------------------------ */

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id").references(() => users.id),
    ownerOrgId: uuid("owner_org_id").references(() => organisations.id),
    kycRecordId: uuid("kyc_record_id").references(() => kycRecords.id),

    docType: documentTypeEnum("doc_type").notNull(),
    /** Private bucket, short-lived signed URLs, every access logged. */
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    /** Lets us prove the stored file is the file that was uploaded. */
    sha256: text("sha256"),

    scanStatus: scanStatusEnum("scan_status").notNull().default("PENDING"),
    scannedAt: timestamp("scanned_at", { withTimezone: true }),

    /** Extraction output, each field with its confidence. */
    extractedFields: jsonb("extracted_fields").$type<
      Record<string, { value: string; confidence: number }>
    >(),
    lowConfidenceFieldCount: integer("low_confidence_field_count"),

    /**
     * The parcel this document is evidence about.
     *
     * On the document rather than a join table: a scan of a Jamabandi concerns
     * one plot. A join table would let one upload support two parcels, which
     * is not a real situation and would make "every document for this parcel
     * is approved" ambiguous.
     */
    landParcelId: uuid("land_parcel_id"),

    reviewedBy: uuid("reviewed_by").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    approved: boolean("approved"),

    /** 7 years, per the retention policy. Legal to confirm. */
    retentionUntil: timestamp("retention_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("documents_storage_key_unique").on(t.storageKey),
    index("documents_owner_user_idx").on(t.ownerUserId),
    index("documents_kyc_record_idx").on(t.kycRecordId),
    index("documents_land_parcel_idx").on(t.landParcelId),
    index("documents_retention_idx").on(t.retentionUntil),
  ],
);

/* ------------------------------------------------------------------ */
/* Land parcels                                                       */
/* ------------------------------------------------------------------ */

/**
 * The link between a khasra number on paper and an actual polygon on the map.
 *
 * Without this, a land record is just a scan of a document — nothing connects
 * what the deed says to the land we are about to put panels on.
 */
export const landParcels = pgTable(
  "land_parcels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id").references(() => users.id),
    khasraNumber: text("khasra_number").notNull(),
    village: text("village"),
    district: text("district"),
    stateCode: text("state_code"),
    areaAcres: numeric("area_acres", { precision: 10, scale: 3 }),

    /**
     * DEFERRED: these are GeoJSON text today, and become
     * `geography(Polygon, 4326)` / `geography(Point, 4326)` when the geo
     * module lands and brings `CREATE EXTENSION postgis` with it.
     *
     * Why not now: PostGIS is genuinely needed for neighbouring-plot queries
     * and the 150 m site-photo check, but nothing on the KYC path reads a
     * geometry — the khasra number is matched as text, and a reviewer compares
     * names by eye. Requiring a PostGIS build to run KYC tests would buy
     * nothing and cost every developer a container.
     *
     * The migration that converts these is a plain
     * `ALTER TABLE ... USING ST_GeomFromGeoJSON(...)`, which is why storing
     * GeoJSON rather than a bespoke format matters.
     */
    boundaryGeojson: text("boundary_geojson"),
    centroidGeojson: text("centroid_geojson"),
    /** The name as written on the registry record, before normalisation. */
    ownerNameOnRecord: text("owner_name_on_record"),
    /** Score against the KYC name. Low scores are a human decision. */
    ownerNameMatchScore: numeric("owner_name_match_score", {
      precision: 4,
      scale: 3,
    }),
    documentsApproved: boolean("documents_approved").notNull().default(false),

    /**
     * Whether this land may be leased — decideLand()'s verdict.
     *
     * Distinct from documentsApproved, which only says Legal read the
     * paperwork. The two come apart the moment a record names two holders:
     * the documents can be perfect and the parcel still unusable on one
     * signature.
     */
    verificationStatus: kycStatusEnum("verification_status")
      .notNull()
      .default("NOT_STARTED"),
    /** What decideLand() returned, verbatim. Codes only, never prose. */
    decisionReasons: jsonb("decision_reasons").$type<
      { code: string; detail: string; severity: string }[]
    >(),

    /**
     * Everybody else the registry record lists as holding a share.
     *
     * A list, not a count: a reviewer confirming consent needs to know who
     * they are confirming it with.
     */
    coOwnerNames: jsonb("co_owner_names").$type<string[]>().notNull().default([]),
    /** Legal's confirmation that the co-owners agreed to the lease. */
    coOwnerConsentConfirmed: boolean("co_owner_consent_confirmed")
      .notNull()
      .default(false),
    coOwnerConsentBy: uuid("co_owner_consent_by").references(() => users.id),
    coOwnerConsentAt: timestamp("co_owner_consent_at", { withTimezone: true }),

    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("land_parcels_khasra_idx").on(t.stateCode, t.district, t.khasraNumber),
    index("land_parcels_owner_idx").on(t.ownerUserId),
    index("land_parcels_status_idx").on(t.verificationStatus, t.createdAt),
  ],
);

/* ------------------------------------------------------------------ */
/* Aadhaar OTP challenges                                             */
/* ------------------------------------------------------------------ */

/**
 * The live challenge between "send me an OTP" and "here is the OTP".
 *
 * It used to be a module-level variable in the web app — one variable shared
 * by every request the process handled, so two people verifying at the same
 * time crossed over. One row per person instead; a new request replaces the
 * old challenge.
 *
 * No Aadhaar number here. The reference id is the gateway's opaque handle and
 * `last4` is the only part of the number we are permitted to keep.
 */
export const aadhaarOtpChallenges = pgTable(
  "aadhaar_otp_challenges",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("reference_id").notNull(),
    last4: text("last4").notNull(),
    /** A six-digit OTP is a million guesses; the gateway limits, and so do we. */
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("aadhaar_otp_challenges_expiry_idx").on(t.expiresAt)],
);

/* ------------------------------------------------------------------ */
/* Platform: outbox, audit, settings, webhook replay                  */
/* ------------------------------------------------------------------ */

/**
 * Transactional outbox. A row is written in the same transaction as the
 * business change, so "data saved but notification missing" cannot happen.
 */
export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventType: text("event_type").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    payload: jsonb("payload").notNull(),
    status: outboxStatusEnum("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** The worker's claim query: pending and due, oldest first. */
    index("outbox_pending_idx").on(t.status, t.availableAt),
    index("outbox_aggregate_idx").on(t.aggregateType, t.aggregateId),
  ],
);

export const notificationChannelEnum = pgEnum("notification_channel", [
  "PUSH",
  "WHATSAPP",
  "SMS",
  "EMAIL",
  "IN_APP",
]);

export const notificationStatusEnum = pgEnum("notification_status", [
  "PENDING",
  "SENT",
  "DELIVERED",
  "READ",
  "FAILED",
]);

/**
 * One row per message actually attempted.
 *
 * This exists so "the customer has been notified" is a fact somebody can
 * check rather than a sentence in a UI. Support gets asked "did you tell me?"
 * constantly, and without a delivery record the only answer is a shrug.
 *
 * It also carries what the provider said, which is the only way to tell a
 * message that failed from one that was never queued — and which channel it
 * fell back to when WhatsApp's 24-hour window had closed.
 */
export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The outbox event that caused it, so a retry can be traced. */
    outboxEventId: uuid("outbox_event_id").references(() => outboxEvents.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    channel: notificationChannelEnum("channel").notNull(),
    /** Template name, not rendered text — the text may quote the person. */
    template: text("template").notNull(),
    locale: text("locale").notNull().default("en"),
    status: notificationStatusEnum("status").notNull().default("PENDING"),
    provider: text("provider"),
    providerMessageId: text("provider_message_id"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * One message per event, per user, per channel. This is what makes the
     * handler safe to retry: a redelivered outbox event cannot send the same
     * WhatsApp message twice.
     */
    uniqueIndex("notification_once_per_event_channel").on(
      t.outboxEventId,
      t.userId,
      t.channel,
    ),
    index("notification_user_idx").on(t.userId, t.createdAt),
    index("notification_status_idx").on(t.status),
  ],
);

/**
 * Append-only audit log. Every sensitive action, including every view of a
 * KYC document.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null for system actions such as a webhook-driven decision. */
    actorUserId: uuid("actor_user_id").references(() => users.id),
    actorType: text("actor_type").notNull(),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id"),
    /** Before/after, with sensitive values already masked. */
    changes: jsonb("changes"),
    reasonCode: text("reason_code"),
    note: text("note"),
    ipAddress: text("ip_address"),
    /** Ties a log line to the request that caused it. */
    traceId: text("trace_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_resource_idx").on(t.resourceType, t.resourceId, t.createdAt),
    index("audit_actor_idx").on(t.actorUserId, t.createdAt),
    index("audit_action_idx").on(t.action, t.createdAt),
  ],
);

/**
 * Proof that a background job is still running.
 *
 * The failure this exists for is an absence: no error, no log line, just a job
 * that stopped happening. You cannot query for a thing that did not occur, so
 * each pass writes down that it finished.
 *
 * One row per job, updated in place. A liveness signal, not a history.
 */
export const jobHeartbeats = pgTable(
  "job_heartbeats",
  {
    job: text("job").primaryKey(),
    /** The last pass of any kind — a failing job is still an alive job. */
    lastRunAt: timestamp("last_run_at", { withTimezone: true }).notNull(),
    /** The last pass that worked. This is the one the alert reads. */
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastError: text("last_error"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    /** Tells "running but doing nothing" apart from "not running". */
    runs: bigint("runs", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("job_heartbeats_success_idx").on(t.lastSuccessAt)],
);

/**
 * Admin-editable thresholds. The face-match bar, the name-match bar and the
 * extraction confidence floor live here so Ops can retune without a release.
 */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  description: text("description"),
  updatedBy: uuid("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Webhook replay protection.
 *
 * The unique index on `key` is the entire mechanism: it is what serialises two
 * API containers racing to process the same retried delivery. An INSERT ...
 * ON CONFLICT DO NOTHING either inserts or it does not, and only the task that
 * inserted may proceed.
 */
export const seenWebhookEvents = pgTable(
  "seen_webhook_events",
  {
    /** `${vendor}:${eventId}` — namespaced, since ids collide across vendors. */
    key: text("key").primaryKey(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("seen_webhook_expires_idx").on(t.expiresAt)],
);

/* ------------------------------------------------------------------ */

export const schema = {
  users,
  consentRecords,
  organisations,
  orgMembers,
  kycRecords,
  kycChecks,
  documents,
  landParcels,
  aadhaarOtpChallenges,
  outboxEvents,
  notificationDeliveries,
  auditLog,
  settings,
  seenWebhookEvents,
};
