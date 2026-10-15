CREATE TYPE "public"."bank_validation_status" AS ENUM('PENDING', 'VALID', 'INVALID');--> statement-breakpoint
CREATE TYPE "public"."kyc_check_status" AS ENUM('PENDING', 'PASSED', 'FAILED', 'ERRORED');--> statement-breakpoint
CREATE TYPE "public"."kyc_check_type" AS ENUM('AADHAAR', 'PAN', 'LIVENESS', 'FACE_MATCH', 'GST', 'CIN', 'LLPIN', 'BANK_ACCOUNT', 'LAND_DOCUMENTS', 'NAME_MATCH');--> statement-breakpoint
CREATE TYPE "public"."consent_purpose" AS ENUM('KYC_VERIFICATION', 'KYB_VERIFICATION', 'BANK_ACCOUNT_VALIDATION', 'LAND_OWNERSHIP_VERIFICATION', 'AGREEMENT_ESIGN');--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('SELFIE', 'GST_CERTIFICATE', 'SALE_DEED', 'JAMABANDI', 'KHASRA_KHATAUNI', 'MUTATION_RECORD', 'BOARD_RESOLUTION', 'AUTHORISATION_LETTER', 'PARTNERSHIP_DEED', 'UDYAM_CERTIFICATE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."gst_status" AS ENUM('ACTIVE', 'CANCELLED', 'SUSPENDED', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."kyc_level" AS ENUM('PAN_ONLY', 'FULL', 'KYB');--> statement-breakpoint
CREATE TYPE "public"."kyc_status" AS ENUM('NOT_STARTED', 'IN_PROGRESS', 'MANUAL_REVIEW', 'VERIFIED', 'REJECTED', 'BLOCKED');--> statement-breakpoint
CREATE TYPE "public"."org_role" AS ENUM('SIGNATORY', 'ADMIN', 'FINANCE');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('PENDING', 'PROCESSING', 'DONE', 'DEAD');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('PENDING', 'CLEAN', 'INFECTED', 'ERRORED');--> statement-breakpoint
CREATE TYPE "public"."kyc_subject_type" AS ENUM('PERSON', 'ORGANISATION');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"actor_type" text NOT NULL,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid,
	"changes" jsonb,
	"reason_code" text,
	"note" text,
	"ip_address" text,
	"trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"ifsc" text NOT NULL,
	"account_number_encrypted" text NOT NULL,
	"account_last4" text NOT NULL,
	"account_blind_index" text NOT NULL,
	"name_at_bank" text,
	"name_match_score" numeric(4, 3),
	"provider_fund_account_id" text,
	"provider_validation_id" text,
	"validation_status" "bank_validation_status" DEFAULT 'PENDING' NOT NULL,
	"validated_at" timestamp with time zone,
	"payout_hold_until" timestamp with time zone,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consent_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" "consent_purpose" NOT NULL,
	"notice_version" text NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"ip_address" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"owner_org_id" uuid,
	"kyc_record_id" uuid,
	"doc_type" "document_type" NOT NULL,
	"s3_key" text NOT NULL,
	"content_type" text,
	"size_bytes" bigint,
	"sha256" text,
	"scan_status" "scan_status" DEFAULT 'PENDING' NOT NULL,
	"scanned_at" timestamp with time zone,
	"extracted_fields" jsonb,
	"low_confidence_field_count" integer,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"approved" boolean,
	"retention_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kyc_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kyc_record_id" uuid NOT NULL,
	"check_type" "kyc_check_type" NOT NULL,
	"status" "kyc_check_status" NOT NULL,
	"score" numeric(5, 4),
	"vendor" text,
	"vendor_version" text,
	"raw_response_s3_key" text,
	"detail" text,
	"attempt_number" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kyc_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" "kyc_subject_type" NOT NULL,
	"user_id" uuid,
	"org_id" uuid,
	"level" "kyc_level" NOT NULL,
	"status" "kyc_status" DEFAULT 'NOT_STARTED' NOT NULL,
	"vendor" text,
	"vendor_session_id" text,
	"vendor_version" text,
	"aadhaar_last4" text,
	"aadhaar_ref_token" text,
	"pan_encrypted" text,
	"pan_last4" text,
	"pan_blind_index" text,
	"liveness_passed" boolean,
	"face_match_score" numeric(4, 3),
	"name_match_score" numeric(4, 3),
	"decision_reasons" jsonb,
	"thresholds_used" jsonb,
	"consent_id" uuid,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_reason_code" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "land_parcels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"khasra_number" text NOT NULL,
	"village" text,
	"district" text,
	"state_code" text,
	"area_acres" numeric(10, 3),
	"boundary_geojson" text,
	"centroid_geojson" text,
	"owner_name_on_record" text,
	"owner_name_match_score" numeric(4, 3),
	"documents_approved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "org_role" NOT NULL,
	"authority_document_id" uuid,
	"authority_approved_by" uuid,
	"authority_approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organisations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legal_name" text NOT NULL,
	"trade_name" text,
	"gstin" text NOT NULL,
	"constitution" text,
	"cin_or_llpin" text,
	"gst_status" "gst_status" DEFAULT 'UNKNOWN' NOT NULL,
	"registered_address_encrypted" text,
	"business_pan_last4" text,
	"kyb_status" "kyc_status" DEFAULT 'NOT_STARTED' NOT NULL,
	"state_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seen_webhook_events" (
	"key" text PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"description" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_e164" text NOT NULL,
	"phone_verified_at" timestamp with time zone,
	"display_name" text,
	"locale" text DEFAULT 'en' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_org_id_organisations_id_fk" FOREIGN KEY ("owner_org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_kyc_record_id_kyc_records_id_fk" FOREIGN KEY ("kyc_record_id") REFERENCES "public"."kyc_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_checks" ADD CONSTRAINT "kyc_checks_kyc_record_id_kyc_records_id_fk" FOREIGN KEY ("kyc_record_id") REFERENCES "public"."kyc_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_records" ADD CONSTRAINT "kyc_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_records" ADD CONSTRAINT "kyc_records_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_records" ADD CONSTRAINT "kyc_records_consent_id_consent_records_id_fk" FOREIGN KEY ("consent_id") REFERENCES "public"."consent_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_records" ADD CONSTRAINT "kyc_records_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "land_parcels" ADD CONSTRAINT "land_parcels_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_authority_approved_by_users_id_fk" FOREIGN KEY ("authority_approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_resource_idx" ON "audit_log" USING btree ("resource_type","resource_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_log" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "audit_log" USING btree ("action","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_user_account_unique" ON "bank_accounts" USING btree ("user_id","account_blind_index");--> statement-breakpoint
CREATE INDEX "bank_accounts_user_idx" ON "bank_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "bank_accounts_validation_idx" ON "bank_accounts" USING btree ("validation_status");--> statement-breakpoint
CREATE INDEX "consent_user_purpose_idx" ON "consent_records" USING btree ("user_id","purpose");--> statement-breakpoint
CREATE INDEX "consent_withdrawn_idx" ON "consent_records" USING btree ("withdrawn_at");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_s3_key_unique" ON "documents" USING btree ("s3_key");--> statement-breakpoint
CREATE INDEX "documents_owner_user_idx" ON "documents" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "documents_kyc_record_idx" ON "documents" USING btree ("kyc_record_id");--> statement-breakpoint
CREATE INDEX "documents_retention_idx" ON "documents" USING btree ("retention_until");--> statement-breakpoint
CREATE INDEX "kyc_checks_record_idx" ON "kyc_checks" USING btree ("kyc_record_id","created_at");--> statement-breakpoint
CREATE INDEX "kyc_checks_type_idx" ON "kyc_checks" USING btree ("check_type","status");--> statement-breakpoint
CREATE UNIQUE INDEX "kyc_records_pan_blind_index_unique" ON "kyc_records" USING btree ("pan_blind_index");--> statement-breakpoint
CREATE UNIQUE INDEX "kyc_records_vendor_session_unique" ON "kyc_records" USING btree ("vendor_session_id");--> statement-breakpoint
CREATE INDEX "kyc_records_user_idx" ON "kyc_records" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "kyc_records_org_idx" ON "kyc_records" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "kyc_records_status_idx" ON "kyc_records" USING btree ("status");--> statement-breakpoint
CREATE INDEX "kyc_records_review_queue_idx" ON "kyc_records" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "land_parcels_khasra_idx" ON "land_parcels" USING btree ("state_code","district","khasra_number");--> statement-breakpoint
CREATE INDEX "land_parcels_owner_idx" ON "land_parcels" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_members_unique" ON "org_members" USING btree ("org_id","user_id","role");--> statement-breakpoint
CREATE INDEX "org_members_user_idx" ON "org_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organisations_gstin_unique" ON "organisations" USING btree ("gstin");--> statement-breakpoint
CREATE INDEX "organisations_kyb_status_idx" ON "organisations" USING btree ("kyb_status");--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox_events" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "outbox_aggregate_idx" ON "outbox_events" USING btree ("aggregate_type","aggregate_id");--> statement-breakpoint
CREATE INDEX "seen_webhook_expires_idx" ON "seen_webhook_events" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_phone_unique" ON "users" USING btree ("phone_e164");