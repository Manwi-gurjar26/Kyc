-- Row Level Security, append-only enforcement, and updated_at triggers.
--
-- Hand-written rather than generated, because none of it is expressible in a
-- Drizzle schema.
--
-- Where this sits in the defences: the API's permission guard is the real
-- block, and `can()` in packages/core is where the rules live. RLS is the
-- second net — it is what stops a missing WHERE clause in a new query, or a
-- compromised API process, from reading every KYC record in the database.
-- Neither layer is a substitute for the other.

--> statement-breakpoint

-- ===================================================================
-- Request context
-- ===================================================================
--
-- The API sets these two per transaction, from the authenticated session:
--
--   SET LOCAL app.current_user_id = '<uuid>';
--   SET LOCAL app.role            = 'customer' | 'staff' | 'system';
--
-- SET LOCAL, so the value dies with the transaction and cannot leak onto the
-- next request that happens to reuse the pooled connection. With RDS Proxy in
-- front of Postgres that distinction is not academic.

CREATE OR REPLACE FUNCTION app_role() RETURNS text AS $$
  SELECT COALESCE(NULLIF(current_setting('app.role', true), ''), 'none');
$$ LANGUAGE sql STABLE;

--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

--> statement-breakpoint

-- ===================================================================
-- Append-only tables
-- ===================================================================
--
-- kyc_checks and audit_log record what happened. Correcting a mistake means
-- adding a row, never editing one: a failed check followed by a passing one
-- must leave both, because that pattern is exactly what a fraud review looks
-- for. An audit log that can be edited is not an audit log.
--
-- Enforced by a trigger, not by convention, so it also holds for a migration
-- script, a psql session, and anyone with database access.

CREATE OR REPLACE FUNCTION refuse_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only: % is not permitted. Add a correcting row instead.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

--> statement-breakpoint

CREATE TRIGGER kyc_checks_append_only
  BEFORE UPDATE OR DELETE ON kyc_checks
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

--> statement-breakpoint

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

--> statement-breakpoint

-- Consent is append-only in spirit, but withdrawal has to be recordable.
-- So UPDATE is allowed only to set withdrawn_at, and only once: nothing may
-- rewrite the purpose, the notice version, or when consent was granted.
CREATE OR REPLACE FUNCTION consent_withdrawal_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'consent_records is append-only: DELETE is not permitted.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.user_id         IS DISTINCT FROM OLD.user_id
     OR NEW.purpose        IS DISTINCT FROM OLD.purpose
     OR NEW.notice_version IS DISTINCT FROM OLD.notice_version
     OR NEW.locale         IS DISTINCT FROM OLD.locale
     OR NEW.granted_at     IS DISTINCT FROM OLD.granted_at THEN
    RAISE EXCEPTION
      'consent_records: only withdrawn_at may be updated. What a person consented to, and which notice they saw, is fixed.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at THEN
    RAISE EXCEPTION 'consent_records: withdrawal cannot be rewritten once recorded.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

--> statement-breakpoint

CREATE TRIGGER consent_records_withdrawal_only
  BEFORE UPDATE OR DELETE ON consent_records
  FOR EACH ROW EXECUTE FUNCTION consent_withdrawal_only();

--> statement-breakpoint

-- ===================================================================
-- updated_at
-- ===================================================================

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

--> statement-breakpoint

CREATE TRIGGER kyc_records_touch_updated_at
  BEFORE UPDATE ON kyc_records
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

--> statement-breakpoint

CREATE TRIGGER organisations_touch_updated_at
  BEFORE UPDATE ON organisations
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

--> statement-breakpoint

-- ===================================================================
-- Row Level Security
-- ===================================================================
--
-- FORCE is the important word. ENABLE ROW LEVEL SECURITY alone is silently
-- ineffective for the table's owner, and in most deployments the application
-- connects as the role that owns the tables — so the policies look present,
-- pass review, and do nothing. FORCE applies them to the owner too.
--
-- The migration also creates a dedicated non-owner role, which is how it
-- should connect in production. FORCE means we are protected either way.

ALTER TABLE kyc_records       ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kyc_records       FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kyc_checks        ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE kyc_checks        FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE documents         ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE documents         FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE consent_records   ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE consent_records   FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE bank_accounts     ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE bank_accounts     FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE land_parcels      ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE land_parcels      FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint

-- -------------------------------------------------------------------
-- kyc_records
-- -------------------------------------------------------------------

-- A customer sees their own record and nothing else.
CREATE POLICY kyc_records_customer_select ON kyc_records
  FOR SELECT
  USING (app_role() = 'customer' AND user_id = app_user_id());

--> statement-breakpoint

-- Staff who review cases can read all of them. Which staff, and which case
-- types, is enforced by canReviewCase() in packages/core; this is the net
-- under it.
CREATE POLICY kyc_records_staff_select ON kyc_records
  FOR SELECT USING (app_role() = 'staff');

--> statement-breakpoint

-- Only staff may change a KYC record by hand, and only the system — the
-- webhook handler running decideKyc() — may create one. A customer has no
-- write path to their own KYC status at all, which is the point.
CREATE POLICY kyc_records_staff_update ON kyc_records
  FOR UPDATE USING (app_role() = 'staff') WITH CHECK (app_role() = 'staff');

--> statement-breakpoint

CREATE POLICY kyc_records_system_all ON kyc_records
  FOR ALL USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

--> statement-breakpoint

-- -------------------------------------------------------------------
-- kyc_checks
-- -------------------------------------------------------------------

CREATE POLICY kyc_checks_customer_select ON kyc_checks
  FOR SELECT
  USING (
    app_role() = 'customer'
    AND EXISTS (
      SELECT 1 FROM kyc_records r
      WHERE r.id = kyc_checks.kyc_record_id AND r.user_id = app_user_id()
    )
  );

--> statement-breakpoint

CREATE POLICY kyc_checks_staff_select ON kyc_checks
  FOR SELECT USING (app_role() = 'staff');

--> statement-breakpoint

CREATE POLICY kyc_checks_system_insert ON kyc_checks
  FOR INSERT WITH CHECK (app_role() IN ('system', 'staff'));

--> statement-breakpoint

-- -------------------------------------------------------------------
-- documents
-- -------------------------------------------------------------------

CREATE POLICY documents_customer_own ON documents
  FOR SELECT
  USING (app_role() = 'customer' AND owner_user_id = app_user_id());

--> statement-breakpoint

CREATE POLICY documents_staff_select ON documents
  FOR SELECT USING (app_role() = 'staff');

--> statement-breakpoint

CREATE POLICY documents_system_all ON documents
  FOR ALL USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

--> statement-breakpoint

CREATE POLICY documents_customer_insert ON documents
  FOR INSERT WITH CHECK (app_role() = 'customer' AND owner_user_id = app_user_id());

--> statement-breakpoint

-- -------------------------------------------------------------------
-- consent_records
-- -------------------------------------------------------------------

CREATE POLICY consent_customer_own ON consent_records
  FOR SELECT USING (app_role() = 'customer' AND user_id = app_user_id());

--> statement-breakpoint

CREATE POLICY consent_customer_insert ON consent_records
  FOR INSERT WITH CHECK (app_role() = 'customer' AND user_id = app_user_id());

--> statement-breakpoint

-- Withdrawing consent is the customer's right, so they may perform this
-- UPDATE. The trigger above is what confines it to withdrawn_at.
CREATE POLICY consent_customer_withdraw ON consent_records
  FOR UPDATE
  USING (app_role() = 'customer' AND user_id = app_user_id())
  WITH CHECK (app_role() = 'customer' AND user_id = app_user_id());

--> statement-breakpoint

CREATE POLICY consent_staff_select ON consent_records
  FOR SELECT USING (app_role() IN ('staff', 'system'));

--> statement-breakpoint

CREATE POLICY consent_system_all ON consent_records
  FOR ALL USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

--> statement-breakpoint

-- -------------------------------------------------------------------
-- bank_accounts
-- -------------------------------------------------------------------

CREATE POLICY bank_accounts_customer_own ON bank_accounts
  FOR SELECT USING (app_role() = 'customer' AND user_id = app_user_id());

--> statement-breakpoint

CREATE POLICY bank_accounts_customer_insert ON bank_accounts
  FOR INSERT WITH CHECK (app_role() = 'customer' AND user_id = app_user_id());

--> statement-breakpoint

-- Finance needs to see where a payout is going; nobody but the system may
-- change a validation result.
CREATE POLICY bank_accounts_staff_select ON bank_accounts
  FOR SELECT USING (app_role() = 'staff');

--> statement-breakpoint

CREATE POLICY bank_accounts_system_all ON bank_accounts
  FOR ALL USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

--> statement-breakpoint

-- -------------------------------------------------------------------
-- land_parcels
-- -------------------------------------------------------------------

CREATE POLICY land_parcels_customer_own ON land_parcels
  FOR SELECT USING (app_role() = 'customer' AND owner_user_id = app_user_id());

--> statement-breakpoint

CREATE POLICY land_parcels_staff_select ON land_parcels
  FOR SELECT USING (app_role() = 'staff');

--> statement-breakpoint

CREATE POLICY land_parcels_system_all ON land_parcels
  FOR ALL USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

--> statement-breakpoint

-- ===================================================================
-- Seed thresholds
-- ===================================================================
--
-- These start as the vendor's recommended values and are reviewed after the
-- first 50 cases. They live here, not in the code, so Ops can retune them
-- without a release — and every decision records the values it used, so an
-- old decision stays reproducible after a retune.

INSERT INTO settings (key, value, description) VALUES
  ('kyc.threshold.faceMatch', '0.75',
   'Minimum face match score against the Aadhaar photo to auto-approve. Aadhaar photos are often years old, so expect this to be the commonest reason for manual review.'),
  ('kyc.threshold.nameMatch', '0.75',
   'Minimum name match score, used for bank account names and land record owner names.'),
  ('kyc.threshold.documentConfidence', '0.85',
   'Minimum Textract field confidence to pre-fill a field without review.'),
  ('kyc.threshold.maxLowConfidenceFields', '1',
   'How many low-confidence document fields are tolerated before the case goes to a person.'),
  ('kyc.threshold.minimumAge', '18',
   'Minimum age in whole years. Below this is a hard fail: a contract with a minor is not enforceable.'),
  ('kyc.liveness.maxAttempts', '3',
   'Failed liveness attempts before a cool-off period and a fraud flag.')
ON CONFLICT (key) DO NOTHING;
