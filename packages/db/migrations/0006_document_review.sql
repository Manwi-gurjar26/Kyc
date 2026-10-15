-- -------------------------------------------------------------------
-- Staff may update a document they are reviewing.
--
-- Found while writing the Legal approval path: documents had a staff SELECT
-- policy and no staff UPDATE policy, so an approval ran, affected zero rows
-- and reported success. That is the same failure mode as the two queries that
-- were missing withContext — RLS does not raise, it returns nothing — which is
-- why this is a migration and not a line in a controller.
--
-- kyc_records already had the matching pair (kyc_records_staff_select and
-- kyc_records_staff_update); documents was simply missed.
--
-- Scope note: RLS decides which ROWS, never which COLUMNS. This policy lets
-- staff write any column of a document, and nothing at the database level
-- stops a staff session rewriting s3_key or extracted_fields. The review
-- columns are the only ones the application writes under a staff role
-- (approveDocument writes approved, reviewed_by and reviewed_at and nothing
-- else), and every write lands in the append-only audit log. Narrowing this
-- further needs column privileges on a separate reviewer role, which is worth
-- doing when staff sessions stop sharing one database role.
-- -------------------------------------------------------------------

CREATE POLICY documents_staff_update ON documents
  FOR UPDATE USING (app_role() = 'staff') WITH CHECK (app_role() = 'staff');
