/**
 * Installs pg-boss's own schema, as the database owner.
 *
 * Separate from the drizzle migrations on purpose, and separate from the
 * worker on purpose.
 *
 * pg-boss ships ~21KB of generated DDL with its own transaction and advisory
 * lock. Pasting that into a hand-maintained migration would mean reviewing
 * generated SQL by eye on every upgrade and would nest a transaction inside
 * drizzle's. Letting the library install itself is the supported path — the
 * only question is *which role* runs it.
 *
 * Not the worker's role. Migration 0002 exists because the application role is
 * deliberately NOSUPERUSER NOBYPASSRLS with no DDL rights on `public`; a worker
 * that could run CREATE TABLE at boot would undo that. So the install runs here
 * as the owner, and the worker connects with `migrate: false`.
 *
 *   node scripts/setup-pgboss.mjs            # dev database
 *   node scripts/setup-pgboss.mjs --test     # the four test databases
 *
 * Idempotent: pg-boss skips what is already installed, and the grants are
 * re-issued each time.
 */

import { PgBoss } from "pg-boss";
import postgres from "postgres";

const SCHEMA = "pgboss";
const APP_ROLE = "kilowattx_app";

const OWNER_DEV =
  process.env.OWNER_DATABASE_URL ??
  "postgresql://kilowattx:local_dev_only@localhost:5433/kilowattx";

const TEST_DATABASES = [
  "kilowattx_test",
  "kilowattx_api_test",
  "kilowattx_worker_test",
  "kilowattx_pipeline_test",
];

/* ------------------------------------------------------------------ */

async function install(connectionString) {
  const shown = connectionString.replace(/:[^:@/]*@/, ":***@");
  console.log(`\npg-boss -> ${shown}`);

  /**
   * `supervise` and `schedule` off: this process installs and leaves. Starting
   * the maintenance and cron loops here would have them running for the few
   * seconds the script lives, which is pointless and muddies the logs.
   */
  const boss = new PgBoss({
    connectionString,
    schema: SCHEMA,
    supervise: false,
    schedule: false,
    max: 2,
  });

  boss.on("error", (error) => console.error("  pg-boss:", error.message));

  await boss.start();
  const version = await boss.schemaVersion();
  console.log(`  schema installed, version ${version}`);

  /**
   * Queues are created here, by the owner, rather than by the worker.
   *
   * createQueue() creates a partition — DDL. Doing it here means the worker
   * needs no CREATE right at all: it only ever reads and writes rows in
   * queues that already exist. A queue added later is a change to this file,
   * which is the right place to notice one.
   */
  for (const queue of QUEUES) {
    await boss.createQueue(queue.name, queue.options);
    console.log(`  queue ${queue.name}`);
  }

  await boss.stop({ graceful: true, close: true });

  await grant(connectionString);
}

/**
 * The worker's role gets exactly what it needs inside this schema, and
 * nothing in `public` changes.
 *
 * No CREATE: every queue and partition already exists, made above by the
 * owner. The default privileges clause covers tables pg-boss adds in a later
 * version, so an upgrade does not silently leave the worker unable to read its
 * own queue.
 */
async function grant(connectionString) {
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });

  try {
    await sql.unsafe(`
      GRANT USAGE ON SCHEMA ${SCHEMA} TO ${APP_ROLE};
      GRANT SELECT, INSERT, UPDATE, DELETE
        ON ALL TABLES IN SCHEMA ${SCHEMA} TO ${APP_ROLE};
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${SCHEMA} TO ${APP_ROLE};
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${SCHEMA} TO ${APP_ROLE};

      ALTER DEFAULT PRIVILEGES IN SCHEMA ${SCHEMA}
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE};
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${SCHEMA}
        GRANT USAGE, SELECT ON SEQUENCES TO ${APP_ROLE};
    `);
    console.log(`  granted DML on ${SCHEMA} to ${APP_ROLE} (no CREATE)`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/* ------------------------------------------------------------------ */

/**
 * The three jobs the worker runs, and what each one tolerates.
 *
 * `retryLimit` is low everywhere: these are periodic jobs, so a failed pass is
 * followed by the next scheduled one. Retrying hard would stack passes on top
 * of a database that is already unhappy.
 */
export const QUEUES = [
  {
    name: "outbox.drain",
    options: {
      /** One pass at a time. Two dispatchers in one process is pointless. */
      policy: "singleton",
      retryLimit: 2,
      retryDelay: 5,
      expireInSeconds: 120,
    },
  },
  {
    name: "kyc.reconcile",
    options: {
      policy: "singleton",
      retryLimit: 1,
      retryDelay: 60,
      expireInSeconds: 300,
    },
  },
  {
    name: "webhooks.purge",
    options: {
      policy: "singleton",
      retryLimit: 1,
      retryDelay: 300,
      expireInSeconds: 300,
    },
  },
];

/* ------------------------------------------------------------------ */

async function main() {
  const testMode = process.argv.includes("--test");

  if (!testMode) {
    await install(OWNER_DEV);
    console.log("\nDone. The worker connects with migrate:false.");
    return;
  }

  const base =
    process.env.OWNER_TEST_DATABASE_URL ??
    "postgresql://kilowattx:local_dev_only@localhost:5434/postgres";

  for (const database of TEST_DATABASES) {
    await install(base.replace(/\/[^/]*$/, `/${database}`));
  }
  console.log("\nTest databases ready for pg-boss.");
}

main().catch((error) => {
  console.error("\npg-boss setup failed:", error);
  process.exit(1);
});
