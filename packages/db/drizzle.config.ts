import { defineConfig } from "drizzle-kit";

/**
 * Migrations are generated as readable SQL and reviewed in the PR, rather than
 * applied by a tool at runtime. Every migration follows expand -> migrate ->
 * contract so a deploy never needs downtime, and every one runs on staging
 * before production.
 */
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://kilowattx:local_dev_only@localhost:5433/kilowattx",
  },
  verbose: true,
  strict: true,
});
