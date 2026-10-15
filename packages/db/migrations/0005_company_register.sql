-- The company register's own result, stored as data rather than prose.
--
-- The first version of applyKybDecision recovered these by regular expression
-- from the `detail` text of the CIN check row — `status=(\w+)` and
-- `nameMatchesGst=true`. That worked until the wording changed, and it made a
-- hard-fail decision depend on a sentence written for a human reviewer. A
-- decision that gates a 25-year agreement should not be parsed out of a
-- comment.
--
-- The check row keeps its detail for the reviewer. These columns are what the
-- decision reads.

ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS company_status text,
  ADD COLUMN IF NOT EXISTS company_name_matches_gst boolean,
  ADD COLUMN IF NOT EXISTS company_incorporated_on date;

--> statement-breakpoint

COMMENT ON COLUMN organisations.company_status IS
  'MCA register status: ACTIVE, STRUCK_OFF, UNDER_LIQUIDATION, DORMANT. Null when the constitution has no company register.';

--> statement-breakpoint

COMMENT ON COLUMN organisations.company_name_matches_gst IS
  'Whether the MCA name agrees with the GST legal name. A disagreement means the wrong CIN, or two registrations belonging to different entities.';
