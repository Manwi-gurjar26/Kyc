-- ===================================================================
-- Removing bank account validation from the schema.
-- ===================================================================
--
-- This service does KYC. It does not move money, and it no longer holds an
-- account number, so the table that held them goes with the feature.
--
-- A forward migration rather than an edit to 0000, for the ordinary reason:
-- every database that has already run 0000 still has the table, and editing
-- the file it came from would change nothing on any of them while quietly
-- making the schema file disagree with the database. The create-then-drop in
-- the history is the honest record of what happened.
--
-- Four things come out besides the table:
--
--   * `kyc_check_type` loses BANK_ACCOUNT. Postgres cannot remove a value
--     from an enum in place, so the type is rebuilt.
--
--   * `consent_purpose` loses BANK_ACCOUNT_VALIDATION, for a stronger reason
--     than tidiness. DPDP consent is per purpose, and a purpose nothing can
--     act on is a consent record that claims we may do something we cannot.
--     Leaving it expressible means somebody eventually records one.
--
--   * `kyc_checks.raw_response_s3_key` and `documents.s3_key` are renamed.
--     No object store has been chosen; naming one in a column name was a
--     guess that reads as a decision.
--
-- About the append-only triggers
-- ------------------------------
-- `kyc_checks` and `consent_records` both refuse DELETE by trigger, and the
-- rows being removed here are rows those triggers exist to protect. They are
-- disabled for two statements and switched back on, deliberately and in the
-- open, because the alternative is worse in both directions: leaving the rows
-- means keeping an enum value for a check nobody can run, and weakening the
-- trigger to allow this case means weakening it for the application too.
--
-- What makes it safe rather than a loophole: it is DDL in a migration, run as
-- the owner, inside one transaction. The application role cannot do this --
-- it cannot disable a trigger at all. If any statement below fails the whole
-- file rolls back, triggers included, so there is no state in which this has
-- half-happened and the protection is off.

/* ---- the table, its policies and its indexes ---------------------- */
--
-- DROP TABLE takes the RLS policies and the indexes with it, which is why
-- none of them are named here.

DROP TABLE IF EXISTS bank_accounts;
--> statement-breakpoint

DROP TYPE IF EXISTS bank_validation_status;
--> statement-breakpoint

/* ---- kyc_check_type: rebuilt without BANK_ACCOUNT ----------------- */
--
-- The rows go first. The cast below would fail on any row still holding
-- 'BANK_ACCOUNT' and take the migration with it.

ALTER TABLE kyc_checks DISABLE TRIGGER kyc_checks_append_only;
--> statement-breakpoint

DELETE FROM kyc_checks WHERE check_type = 'BANK_ACCOUNT';
--> statement-breakpoint

ALTER TABLE kyc_checks ENABLE TRIGGER kyc_checks_append_only;
--> statement-breakpoint

ALTER TABLE kyc_checks ALTER COLUMN check_type TYPE text;
--> statement-breakpoint

DROP TYPE kyc_check_type;
--> statement-breakpoint

CREATE TYPE kyc_check_type AS ENUM (
  'AADHAAR', 'PAN', 'LIVENESS', 'FACE_MATCH',
  'GST', 'CIN', 'LLPIN', 'LAND_DOCUMENTS', 'NAME_MATCH'
);
--> statement-breakpoint

ALTER TABLE kyc_checks
  ALTER COLUMN check_type TYPE kyc_check_type USING check_type::kyc_check_type;
--> statement-breakpoint

/* ---- consent_purpose: rebuilt without BANK_ACCOUNT_VALIDATION ----- */

ALTER TABLE consent_records DISABLE TRIGGER consent_records_withdrawal_only;
--> statement-breakpoint

DELETE FROM consent_records WHERE purpose = 'BANK_ACCOUNT_VALIDATION';
--> statement-breakpoint

ALTER TABLE consent_records ENABLE TRIGGER consent_records_withdrawal_only;
--> statement-breakpoint

ALTER TABLE consent_records ALTER COLUMN purpose TYPE text;
--> statement-breakpoint

DROP TYPE consent_purpose;
--> statement-breakpoint

CREATE TYPE consent_purpose AS ENUM (
  'KYC_VERIFICATION', 'KYB_VERIFICATION',
  'LAND_OWNERSHIP_VERIFICATION', 'AGREEMENT_ESIGN'
);
--> statement-breakpoint

ALTER TABLE consent_records
  ALTER COLUMN purpose TYPE consent_purpose USING purpose::consent_purpose;
--> statement-breakpoint

/* ---- column names that named a vendor ----------------------------- */

ALTER TABLE kyc_checks RENAME COLUMN raw_response_s3_key TO raw_response_key;
--> statement-breakpoint

ALTER TABLE documents RENAME COLUMN s3_key TO storage_key;
--> statement-breakpoint

ALTER INDEX documents_s3_key_unique RENAME TO documents_storage_key_unique;
--> statement-breakpoint

/* ---- the threshold descriptions Ops reads ------------------------- */
--
-- `nameMatch` still exists and is still tunable. It now governs exactly one
-- decision -- the owner name on a land record -- and a description that still
-- mentions bank account names would send somebody looking for a check that is
-- not there.

UPDATE settings
   SET description = 'Minimum name match score, used for land record owner names.'
 WHERE key = 'kyc.threshold.nameMatch';
--> statement-breakpoint

UPDATE settings
   SET description = 'Minimum extracted-field confidence to pre-fill a field without review.'
 WHERE key = 'kyc.threshold.documentConfidence';
