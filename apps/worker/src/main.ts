import { resolve } from "node:path";
import { PostgresSeenEventStore, createClient, outboxStats, withContext } from "@kilowattx/db";
import {
  FakeKycProvider,
  SandboxKycProvider,
  type KycProvider,
} from "@kilowattx/integrations";
import { ConfigSchema, type Config } from "./config.js";
import { OutboxDispatcher } from "./dispatcher.js";
import { healerFactory } from "./healer.js";
import { staleJobs } from "./heartbeat.js";
import { drainOutbox, tracked } from "./jobs.js";
import { RecordingNotificationSender } from "./notifications.js";
import { reconcileStuckSessions } from "./reconciliation.js";
import {
  QUEUE,
  applySchedules,
  connectScheduler,
  stopScheduler,
} from "./scheduler.js";

/**
 * Loads .env from the repository root, if there is one.
 *
 * Deliberately not a dependency: Node reads these itself. And deliberately
 * not fatal when the file is missing — production injects real environment
 * variables and has no .env to find, so an error here would mean the file
 * every deploy does NOT have becomes the thing that stops it booting.
 *
 * Precedence, which was measured rather than assumed: a variable already set
 * in the environment WINS over the same name in the file. That is the
 * ordering you want — a stray .env left in an image cannot override what the
 * platform injected.
 */
function loadDotEnv(): void {
  try {
    process.loadEnvFile(resolve(import.meta.dirname, "../../..", ".env"));
  } catch {
    /* no .env, or unreadable: the real environment is the source of truth */
  }
}

loadDotEnv();

/**
 * The worker.
 *
 * Three jobs on pg-boss schedules:
 *
 *   outbox.drain      every minute      drains notifications
 *   kyc.reconcile     every 5 minutes   finds sessions a webhook never returned for
 *   webhooks.purge    hourly            drops expired replay-protection rows
 *
 * These were three `setInterval` loops, whose own comment named the problem:
 * if the process dies, nothing runs, and nothing tells you. Those are two
 * separate faults and they get two separate answers — pg-boss keeps the
 * schedule in the database so a restart resumes it and several processes share
 * it without doubling up, and the heartbeat makes "has this job stopped?"
 * answerable, because otherwise the only evidence is an absence.
 *
 * The transactional outbox is untouched. Its rows are written in the same
 * transaction as the business change, which is the whole reason "data saved
 * but notification missing" cannot happen. pg-boss schedules the pass; the
 * outbox still decides what the pass does.
 */



function buildProvider(config: Config): KycProvider {
  if (config.KYC_PROVIDER === "fake") {
    if (config.NODE_ENV === "production") {
      throw new Error(
        "KYC_PROVIDER=fake is refused in production. The fake adapter verifies nobody.",
      );
    }
    return new FakeKycProvider({ webhookSecret: config.KYC_WEBHOOK_SECRET });
  }

  if (config.KYC_PROVIDER === "sandbox") {
    if (!config.KYC_VENDOR_CLIENT_ID || !config.KYC_VENDOR_CLIENT_SECRET) {
      throw new Error(
        "KYC_PROVIDER=sandbox needs KYC_VENDOR_CLIENT_ID and KYC_VENDOR_CLIENT_SECRET. " +
          "The worker reconciles against the same gateway as the API, so it needs the same key.",
      );
    }

    return new SandboxKycProvider({
      apiKey: config.KYC_VENDOR_CLIENT_ID,
      apiSecret: config.KYC_VENDOR_CLIENT_SECRET,
      nodeEnv: config.NODE_ENV,
      webhookSecret: config.KYC_WEBHOOK_SECRET,
    });
  }

  throw new Error(
    `KYC_PROVIDER=${config.KYC_PROVIDER}: that adapter is not implemented yet.`,
  );
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error(
      "Invalid environment configuration:\n" +
        parsed.error.issues
          .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("\n"),
    );
    process.exit(1);
  }
  const config = parsed.data;

  const handle = createClient({ url: config.DATABASE_URL, maxConnections: 10 });
  const provider = buildProvider(config);
  const log = (line: string) => console.log(line);

  const dispatcher = new OutboxDispatcher({
    db: handle.db,
    sender: new RecordingNotificationSender(log),
    batchSize: config.OUTBOX_BATCH_SIZE,
    log,
  });

  const seenEvents = new PostgresSeenEventStore(handle.sql);

  /**
   * Reconciliation heals as well as reports, because it shares the API's
   * pipeline — including the same threshold loader, so a healed case is
   * decided against the same numbers as one decided on a webhook.
   */
  const healerFor = healerFactory({
    db: handle.db,
    blindIndexKeyBase64: config.KYC_BLIND_INDEX_KEY,
    nodeEnv: config.NODE_ENV,
    log: (line) => console.error(line),
  });

  const boss = await connectScheduler({
    connectionString: config.DATABASE_URL,
    schema: config.PGBOSS_SCHEMA,
    log,
  });

  /* ---------------- outbox ---------------- */

  await boss.work(
    QUEUE.outbox,
    tracked(handle.db, QUEUE.outbox, async () => {
      const pass = await drainOutbox(dispatcher, {
        maxBatches: config.OUTBOX_MAX_BATCHES_PER_PASS,
      });

      if (pass.events > 0) {
        log(`[outbox] ${pass.events} event(s) in ${pass.batches} batch(es)`);
      }

      /**
       * The backlog is growing faster than one pass drains it. Said out loud
       * because the alternative is a queue that is always a minute behind and
       * nobody noticing until a customer asks why they were not told.
       */
      if (pass.hitLimit) {
        console.error(
          `[outbox] stopped at ${pass.batches} batches with work still queued. ` +
            "Raise OUTBOX_MAX_BATCHES_PER_PASS or run a second worker.",
        );
      }
    }),
  );

  /* ---------------- reconcile ---------------- */

  await boss.work(
    QUEUE.reconcile,
    tracked(handle.db, QUEUE.reconcile, async () => {
      await reconcileStuckSessions({
        db: handle.db,
        provider,
        now: new Date(),
        stuckAfterMinutes: config.RECONCILE_STUCK_AFTER_MINUTES,
        healer: await healerFor(),
        log,
      });

      /** The numbers worth alerting on. */
      const stats = await withContext(handle.db, { role: "system" }, (tx) =>
        outboxStats(tx, new Date()),
      );
      if (stats.dead > 0) {
        console.error(
          `[outbox] ${stats.dead} DEAD event(s) — customers who were never told something. ` +
            "Nothing will retry these.",
        );
      }
      if (stats.oldestPendingAgeSeconds !== null && stats.oldestPendingAgeSeconds > 600) {
        console.error(
          `[outbox] oldest pending event is ${stats.oldestPendingAgeSeconds}s old`,
        );
      }

      /**
       * The worker checks its own liveness here.
       *
       * Not a substitute for an external check — a dead process reports
       * nothing, which is exactly the case this is for — but it catches the
       * commoner failure, where the process is up and one job has stopped
       * while the others carry on.
       */
      for (const stale of await staleJobs(handle.db, new Date())) {
        console.error(
          `[heartbeat] ${stale.job} has not succeeded ` +
            (stale.secondsSinceSuccess === null
              ? "at all since this database was set up"
              : `for ${stale.secondsSinceSuccess}s`) +
            (stale.lastError ? ` — last error: ${stale.lastError}` : ""),
        );
      }
    }),
  );

  /* ---------------- purge ---------------- */

  await boss.work(
    QUEUE.purge,
    tracked(handle.db, QUEUE.purge, async () => {
      const removed = await seenEvents.purgeExpired(new Date());
      if (removed > 0) log(`[purge] removed ${removed} expired webhook event key(s)`);
    }),
  );

  await applySchedules(boss, log);

  log(`[worker] started · provider=${config.KYC_PROVIDER} · schema=${config.PGBOSS_SCHEMA}`);
  if (config.KYC_PROVIDER === "fake") {
    log(
      "[worker] notifications are RECORDED, not sent. WhatsApp needs a BSP and " +
        "approved templates; SMS needs MSG91 with DLT templates; push needs FCM " +
        "and APNs keys. The delivery rows are real.",
    );
  }

  /**
   * Finish the job in flight before exiting, so a deploy does not leave events
   * stranded in PROCESSING for the stuck-event sweep to find.
   */
  const shutdown = async (signal: string) => {
    log(`[worker] ${signal} received, finishing the current pass`);
    try {
      await stopScheduler(boss, { log });
    } catch (error) {
      console.error("[worker] shutdown:", error);
    }
    await handle.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  console.error("Worker failed to start:", error);
  process.exit(1);
});
