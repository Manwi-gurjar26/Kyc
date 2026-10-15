#!/usr/bin/env node
/**
 * Creates and migrates one test database per package that needs one.
 *
 * WHY ONE EACH: Turborepo runs package tasks in parallel, so `db:test` and
 * `api:test` start at the same moment. Both suites truncate tables between
 * tests, so sharing a database means each one deletes the other's rows
 * mid-test. The failures that produces are the worst kind — foreign key
 * violations and counts off by one, which read as bugs in the code under test
 * rather than as a collision between two test runs.
 *
 * Serialising turbo would also fix it, at the cost of making every unit-test
 * package wait on Postgres. A database each is cheap: same container, separate
 * `CREATE DATABASE`.
 *
 * Run this once after `docker compose up -d`, and again after adding a
 * migration.
 */

import { execFileSync } from "node:child_process";

const CONTAINER = "kilowattx-postgres-test";
const OWNER = "kilowattx";
const APP_ROLE = "kilowattx_app";
/** Local development only. Production injects this from the secret store. */
const APP_PASSWORD = "local_dev_only";

/** One database per package that runs integration tests. */
const DATABASES = [
  { name: "kilowattx_test", package: "@kilowattx/db" },
  { name: "kilowattx_api_test", package: "@kilowattx/api" },
  { name: "kilowattx_worker_test", package: "@kilowattx/worker" },
  { name: "kilowattx_pipeline_test", package: "@kilowattx/kyc-pipeline" },
];

function psql(database, sql) {
  return execFileSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", OWNER, "-d", database, "-v", "ON_ERROR_STOP=1", "-tAc", sql],
    { encoding: "utf8" },
  ).trim();
}

function run(command, args, env) {
  execFileSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
    // On Windows `pnpm` is a .cmd shim, which execFileSync cannot resolve
    // without a shell. Every argument here is a literal defined in this file,
    // so there is nothing user-supplied to escape.
    shell: process.platform === "win32",
  });
}

function main() {
  // The app role is cluster-wide, so it is created once. Its GRANTs are
  // per-database and come from migration 0002.
  const roleExists =
    psql("postgres", `SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}'`) === "1";

  if (!roleExists) {
    psql(
      "postgres",
      `CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    console.log(`Created role ${APP_ROLE}`);
  }
  psql("postgres", `ALTER ROLE ${APP_ROLE} PASSWORD '${APP_PASSWORD}'`);

  for (const { name, package: pkg } of DATABASES) {
    const exists = psql(
      "postgres",
      `SELECT 1 FROM pg_database WHERE datname = '${name}'`,
    );

    if (exists !== "1") {
      psql("postgres", `CREATE DATABASE ${name} OWNER ${OWNER}`);
      console.log(`Created database ${name}`);
    }

    console.log(`Migrating ${name} (for ${pkg})`);
    run("pnpm", ["--filter", "@kilowattx/db", "migrate"], {
      DATABASE_URL: `postgresql://${OWNER}:${APP_PASSWORD}@localhost:5434/${name}`,
    });

    // Belt and braces: assert the thing that silently breaks every RLS test.
    const bypass = psql(
      name,
      `SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = '${APP_ROLE}'`,
    );
    if (bypass !== "f") {
      throw new Error(
        `${APP_ROLE} can bypass RLS in ${name}. Every row level security policy would be inert.`,
      );
    }
  }

  console.log("\nTest databases ready:");
  for (const { name, package: pkg } of DATABASES) {
    console.log(`  ${pkg.padEnd(24)} postgresql://${APP_ROLE}:***@localhost:5434/${name}`);
  }
}

main();
