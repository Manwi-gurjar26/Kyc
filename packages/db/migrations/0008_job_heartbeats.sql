-- ===================================================================
-- Proof that a background job is still running.
-- ===================================================================
--
-- The worker's three loops carried a comment that stated the problem exactly:
-- "if the process dies, nothing runs, and nothing tells you." pg-boss answers
-- the first half — the schedule lives in the database and survives a restart.
--
-- Nothing answers the second half by itself, because the failure is an
-- ABSENCE. There is no error, no log line and no alert when a job simply stops
-- happening; the only evidence is a thing that did not occur, and you cannot
-- query for that. So each pass writes down that it finished, and the question
-- "when did reconciliation last complete?" gets an answer that is a fact.
--
-- One row per job, updated in place rather than appended. This is a liveness
-- signal, not a history: an append-only log would grow by 1,440 rows a day for
-- the outbox alone and still need the same aggregate to answer the only
-- question anybody asks of it.

CREATE TABLE job_heartbeats (
  job text PRIMARY KEY,

  -- The last pass of any kind. A job failing every minute is alive, which is
  -- a different problem from a job that has stopped, and they need different
  -- people woken up.
  last_run_at timestamptz NOT NULL,

  -- The last pass that actually worked. This is the one the alert reads:
  -- a job that runs and fails is getting nothing done.
  last_success_at timestamptz,

  last_error text,
  consecutive_failures integer NOT NULL DEFAULT 0,

  -- Lets "running but doing nothing" be told apart from "not running".
  runs bigint NOT NULL DEFAULT 0,

  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX job_heartbeats_success_idx
  ON job_heartbeats USING btree (last_success_at);
--> statement-breakpoint

ALTER TABLE job_heartbeats ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE job_heartbeats FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- The worker writes these as 'system'. Staff may read them — this is what an
-- operations dashboard shows — and no customer has any business here.
CREATE POLICY job_heartbeats_system_all ON job_heartbeats
  FOR ALL USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
--> statement-breakpoint

CREATE POLICY job_heartbeats_staff_select ON job_heartbeats
  FOR SELECT USING (app_role() = 'staff');
