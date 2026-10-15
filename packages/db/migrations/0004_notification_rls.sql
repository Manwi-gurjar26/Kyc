-- Row Level Security for notification_deliveries.
--
-- It holds who was messaged, about what, and when, which is personal data
-- even though it stores no message text. A customer may see their own
-- delivery history — "did you tell me?" is a fair question and the whole
-- reason the table exists — and support needs to see it to answer that
-- question. Nobody but the worker writes to it.
--
-- FORCE for the same reason as everywhere else: ENABLE alone is silently
-- inert for the table owner, and the application connects as a role that may
-- one day be the owner.

ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_deliveries FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY notifications_customer_own ON notification_deliveries
  FOR SELECT USING (app_role() = 'customer' AND user_id = app_user_id());

--> statement-breakpoint

CREATE POLICY notifications_staff_select ON notification_deliveries
  FOR SELECT USING (app_role() = 'staff');

--> statement-breakpoint

-- Only the worker writes here, under the system role.
CREATE POLICY notifications_system_all ON notification_deliveries
  FOR ALL USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

--> statement-breakpoint

-- Make sure the app role can reach the new table even if the default
-- privileges from 0002 did not apply (they only cover tables created by the
-- role that ran ALTER DEFAULT PRIVILEGES).
GRANT SELECT, INSERT, UPDATE, DELETE ON notification_deliveries TO kilowattx_app;
