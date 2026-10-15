import { PgBoss } from "pg-boss";

/**
 * The worker's schedules.
 *
 * What this replaces: three `setInterval` loops in one process. Their comment
 * said it outright — if the process dies, nothing runs, and nothing tells you.
 * Both halves of that sentence are problems, and they need different answers.
 *
 *   nothing runs    pg-boss keeps the schedule in the database, so a restarted
 *                   process picks it up, several processes share it without
 *                   running the same pass twice, and a missed run is visible
 *                   in `pgboss.schedule` rather than lost with the heap.
 *
 *   nothing tells    a heartbeat. Every completed pass stamps a row; anything
 *   you              watching can ask "when did reconciliation last finish?"
 *                    and get an answer that is a fact rather than an absence.
 *
 * What this deliberately does NOT replace: the transactional outbox. Outbox
 * rows are written in the same transaction as the business change, which is
 * the entire reason "data saved but notification missing" cannot happen here.
 * Moving that to a job queue would reintroduce exactly the gap it closes.
 * pg-boss schedules the pass; the outbox still decides what the pass does.
 */

export const QUEUE = {
  outbox: "outbox.drain",
  reconcile: "kyc.reconcile",
  purge: "webhooks.purge",
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

/**
 * Cron, in UTC.
 *
 * The outbox runs every minute because that is the finest cron allows; the
 * dispatcher itself then drains in a loop until the batch comes back empty, so
 * a burst does not wait a minute per batch.
 */
export const SCHEDULES: { queue: QueueName; cron: string; what: string }[] = [
  { queue: QUEUE.outbox, cron: "* * * * *", what: "drain the outbox" },
  { queue: QUEUE.reconcile, cron: "*/5 * * * *", what: "find stuck sessions" },
  { queue: QUEUE.purge, cron: "17 * * * *", what: "drop expired replay keys" },
];

export interface SchedulerOptions {
  connectionString: string;
  schema?: string;
  log: (line: string) => void;
}

/**
 * Connects to pg-boss as the application role.
 *
 * `migrate` and `createSchema` are off because the application role has no DDL
 * rights and should not: `scripts/setup-pgboss.mjs` installs the schema and
 * creates the queues as the owner. A worker that could create tables at boot
 * would undo migration 0002, which exists to stop exactly that.
 *
 * It follows that an un-set-up database fails loudly at start rather than
 * quietly installing itself, which is the behaviour worth having.
 */
export async function connectScheduler(
  options: SchedulerOptions,
): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString: options.connectionString,
    schema: options.schema ?? "pgboss",
    migrate: false,
    createSchema: false,
    /** Joins pg_stat_activity, so a stuck query is attributable. */
    application_name: "kilowattx-worker",
    max: 4,
  });

  /**
   * pg-boss emits errors rather than throwing them — an unhandled 'error' on
   * an EventEmitter takes the process down, and a transient database blip
   * should not.
   */
  boss.on("error", (error) => {
    options.log(`[pgboss] ${error.message}`);
  });

  await boss.start();
  return boss;
}

/**
 * Registers the cron schedules, replacing whatever was there.
 *
 * Idempotent: pg-boss upserts on (queue, key), so a deploy that changes a cron
 * expression moves the existing schedule rather than accumulating a second
 * one. A schedule removed from SCHEDULES is removed from the database too —
 * otherwise a job nobody can find in the source keeps firing.
 */
export async function applySchedules(
  boss: PgBoss,
  log: (line: string) => void,
): Promise<void> {
  const wanted = new Set<string>(SCHEDULES.map((s) => s.queue));

  for (const existing of await boss.getSchedules()) {
    if (!wanted.has(existing.name)) {
      await boss.unschedule(existing.name);
      log(`[schedule] removed ${existing.name} — no longer in SCHEDULES`);
    }
  }

  for (const schedule of SCHEDULES) {
    await boss.schedule(schedule.queue, schedule.cron, null, { tz: "UTC" });
    log(`[schedule] ${schedule.queue} · ${schedule.cron} UTC · ${schedule.what}`);
  }
}

/* ------------------------------------------------------------------ */

/**
 * Stops pg-boss, waiting for the pass in flight to finish.
 *
 * `stop({ graceful: true })` asks the workers to finish what they are holding
 * and stop taking more. The promise it returns is not the whole story — the
 * instance announces completion with a `stopped` event — so this waits for
 * that, and gives up after a bounded time rather than hanging a deploy.
 *
 * Why it matters: a worker killed mid-pass leaves outbox events in PROCESSING
 * for the stuck-event sweep to find and retry, which is recoverable but means
 * a customer's notification arrives minutes late for no reason.
 */
export async function stopScheduler(
  boss: PgBoss,
  options: { timeoutMs?: number; log: (line: string) => void },
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;

  const stopped = new Promise<void>((resolve) => {
    boss.once("stopped", () => resolve());
  });

  const timedOut = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), timeoutMs).unref(),
  );

  await boss.stop({ graceful: true, timeout: timeoutMs, close: true });

  if ((await Promise.race([stopped.then(() => "stopped" as const), timedOut])) === "timeout") {
    options.log(
      `[pgboss] did not stop within ${timeoutMs}ms — exiting anyway. ` +
        "Any pass still in flight will be retried once its lock expires.",
    );
  }
}
