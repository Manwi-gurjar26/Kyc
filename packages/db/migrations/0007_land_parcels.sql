-- ===================================================================
-- Land parcels: the verdict, the joint holders, and the link to the
-- documents the verdict was reached on.
-- ===================================================================
--
-- A parcel already had a khasra number, a village and a name on the record.
-- What it had no way to say was whether it had been *accepted* — so
-- `documents_approved` was carrying two unrelated meanings at once: "Legal
-- looked at the paperwork" and "this land may be leased". Those come apart the
-- moment the record names two holders.

ALTER TABLE land_parcels
  ADD COLUMN verification_status kyc_status NOT NULL DEFAULT 'NOT_STARTED';
--> statement-breakpoint

-- The reasons decideLand() returned, verbatim, with severities. Codes only:
-- a reason row is read by support and must not quote a reviewer's prose or
-- repeat a name off the record.
ALTER TABLE land_parcels
  ADD COLUMN decision_reasons jsonb;
--> statement-breakpoint

-- Everybody else the registry record lists as holding a share.
--
-- A list rather than a count, because a reviewer confirming consent needs to
-- know who they are confirming it with. Inherited agricultural land is
-- routinely held by several siblings, and a lease signed by one of them is a
-- lease the others can have set aside — after the panels are on the ground.
ALTER TABLE land_parcels
  ADD COLUMN co_owner_names jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint

-- Legal's confirmation that the co-owners agreed.
--
-- Separate from documents_approved on purpose. They are different questions,
-- and a reviewer who answered one must not be recorded as having answered the
-- other.
ALTER TABLE land_parcels
  ADD COLUMN co_owner_consent_confirmed boolean NOT NULL DEFAULT false;
--> statement-breakpoint

ALTER TABLE land_parcels
  ADD COLUMN co_owner_consent_by uuid REFERENCES users(id);
--> statement-breakpoint

ALTER TABLE land_parcels
  ADD COLUMN co_owner_consent_at timestamptz;
--> statement-breakpoint

ALTER TABLE land_parcels
  ADD COLUMN decided_at timestamptz;
--> statement-breakpoint

-- -------------------------------------------------------------------
-- Which parcel a document belongs to.
-- -------------------------------------------------------------------
--
-- On documents rather than a join table: a scan of a Jamabandi is evidence
-- about one plot. A join table would let a single upload support two parcels,
-- which is not a real situation and would make "every document for this
-- parcel is approved" ambiguous.
ALTER TABLE documents
  ADD COLUMN land_parcel_id uuid REFERENCES land_parcels(id);
--> statement-breakpoint

CREATE INDEX documents_land_parcel_idx ON documents USING btree (land_parcel_id);
--> statement-breakpoint

CREATE INDEX land_parcels_status_idx
  ON land_parcels USING btree (verification_status, created_at);
--> statement-breakpoint

-- -------------------------------------------------------------------
-- Staff may update a parcel they are reviewing.
-- -------------------------------------------------------------------
--
-- The same gap documents had in 0006, for the same reason: land_parcels was
-- given a staff SELECT policy and no staff UPDATE policy, so confirming
-- co-owner consent would have matched zero rows and reported success. RLS does
-- not raise, it returns nothing.
--
-- Scope note, as in 0006: RLS decides which rows, never which columns. The
-- application writes only the review columns under a staff role, and every
-- write lands in the append-only audit log.
CREATE POLICY land_parcels_staff_update ON land_parcels
  FOR UPDATE USING (app_role() = 'staff') WITH CHECK (app_role() = 'staff');
