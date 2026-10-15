import { jobHeartbeats, withContext, type Database } from "@kilowattx/db";
import { sql } from "drizzle-orm";

/**
 * Proof that a background job is still running.
 *
 * pg-boss answers "nothing runs" — the schedule is in the database and
 * survives a restart. This answers "nothing tells you", which is the harder
 * half, because the failure is an *absence*: no error, no log line, no alert,
 * just a job that quietly stopped happening. You cannot query for a thing that
 * did not occur, so each pass writes down that it finished and the question
 * becomes answerable.
 */

/**
 * How late a job may be before somebody should be told.
 *
 * Each is comfortably looser than the schedule it covers. An alert that fires
 * on the first slightly-late pass is an alert people learn to close without
 * reading, which is worse than no alert — the next time it fires for a real
 * reason, nobody looks.
 */
export const JOB_STALENESS_SECONDS: Record<string, number> = {
  /** Scheduled every minute; five missed passes is a real problem. */
  "outbox.drain": 300,
  /** Every five minutes; allow three missed passes. */
  "kyc.reconcile": 1_200,
  /** Hourly; a missed purge is harmless, two is a sign the worker is gone. */
  "webhooks.purge": 7_200,
};

export interface HeartbeatRow {
  job: string;
  lastRunAt: Date;
  lastSuccessAt: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
  runs: number;
}

export interface StaleJob {
  job: string;
  lastSuccessAt: Date | null;
  /** Null when the job has never succeeded at all. */
  secondsSinceSuccess: number | null;
  consecutiveFailures: number;
  lastError: string | null;
}

/* ------------------------------------------------------------------ */

/**
 * Records that a pass happened, and whether it worked.
 *
 * `last_run_at` moves on every pass; `last_success_at` only on a good one.
 * Keeping them apart is the point: a job failing every minute is alive but
 * achieving nothing, and a job that has stopped is a different incident with a
 * different cause. One timestamp could not tell them apart.
 */
export async function recordHeartbeat(
  db: Database,
  params: { job: string; now: Date; ok: boolean; error?: string },
): Promise<void> {
  await withContext(db, { role: "system" }, (tx) =>
    tx
      .insert(jobHeartbeats)
      .values({
        job: params.job,
        lastRunAt: params.now,
        lastSuccessAt: params.ok ? params.now : null,
        lastError: params.ok ? null : (params.error ?? "unknown error"),
        consecutiveFailures: params.ok ? 0 : 1,
        runs: 1,
        updatedAt: params.now,
      })
      .onConflictDoUpdate({
        target: jobHeartbeats.job,
        /**
         * `lastSuccessAt` is simply absent from the failure branch rather than
         * set to its own value. Leaving a column out of the update is how you
         * say "do not touch this" — and not touching it is the point, because
         * when the job last actually worked is precisely the number the alert
         * reads. Overwriting it on a failure would erase the only evidence.
         */
        set: params.ok
          ? {
              lastRunAt: params.now,
              lastSuccessAt: params.now,
              lastError: null,
              consecutiveFailures: 0,
              runs: sql`${jobHeartbeats.runs} + 1`,
              updatedAt: params.now,
            }
          : {
              lastRunAt: params.now,
              lastError: params.error ?? "unknown error",
              consecutiveFailures: sql`${jobHeartbeats.consecutiveFailures} + 1`,
              runs: sql`${jobHeartbeats.runs} + 1`,
              updatedAt: params.now,
            },
      }),
  );
}

/* ------------------------------------------------------------------ */

export async function readHeartbeats(db: Database): Promise<HeartbeatRow[]> {
  const rows = await withContext(db, { role: "system" }, (tx) =>
    tx.select().from(jobHeartbeats).orderBy(jobHeartbeats.job),
  );

  return rows.map((row) => ({
    job: row.job,
    lastRunAt: row.lastRunAt,
    lastSuccessAt: row.lastSuccessAt,
    lastError: row.lastError,
    consecutiveFailures: row.consecutiveFailures,
    runs: row.runs,
  }));
}

/* ------------------------------------------------------------------ */

/**
 * Which jobs have not succeeded recently enough.
 *
 * Driven by the list of jobs we expect, not by the rows that happen to exist.
 * That difference is the whole value of this function: a job that has never
 * run once leaves no row, and a check that only examined rows it found would
 * read that silence as health. The most complete failure would be the one it
 * reported as fine.
 */
export async function staleJobs(db: Database, now: Date): Promise<StaleJob[]> {
  const rows = await readHeartbeats(db);
  const byJob = new Map(rows.map((row) => [row.job, row]));

  const stale: StaleJob[] = [];

  for (const [job, tolerance] of Object.entries(JOB_STALENESS_SECONDS)) {
    const row = byJob.get(job);

    if (!row || row.lastSuccessAt === null) {
      stale.push({
        job,
        lastSuccessAt: null,
        secondsSinceSuccess: null,
        consecutiveFailures: row?.consecutiveFailures ?? 0,
        lastError: row?.lastError ?? null,
      });
      continue;
    }

    const seconds = Math.floor(
      (now.getTime() - row.lastSuccessAt.getTime()) / 1000,
    );

    if (seconds > tolerance) {
      stale.push({
        job,
        lastSuccessAt: row.lastSuccessAt,
        secondsSinceSuccess: seconds,
        consecutiveFailures: row.consecutiveFailures,
        lastError: row.lastError,
      });
    }
  }

  return stale;
}
