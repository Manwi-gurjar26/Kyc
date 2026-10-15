import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createClient } from "./client.js";

/**
 * Applies pending migrations.
 *
 * Run against a fresh database in CI on every pull request, and against
 * staging before production. A migration that has never been applied to a
 * copy of production is not a migration, it is a guess.
 */

const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "DATABASE_URL is not set.\n" +
        "  local dev:  postgresql://kilowattx:local_dev_only@localhost:5433/kilowattx\n" +
        "  local test: postgresql://kilowattx:local_dev_only@localhost:5434/kilowattx_test",
    );
    process.exit(1);
  }

  /** One connection: migrations must not run concurrently with themselves. */
  const handle = createClient({ url, maxConnections: 1 });

  try {
    const redacted = url.replace(/:\/\/([^:]+):[^@]*@/, "://$1:***@");
    console.log(`Migrating ${redacted}`);
    await migrate(handle.db, { migrationsFolder });
    console.log("Migrations applied.");
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
