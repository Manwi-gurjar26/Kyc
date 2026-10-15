import { createClient, type DatabaseHandle } from "../client.js";

/**
 * Integration test harness.
 *
 * These tests run against a real Postgres, not a mock. Everything being
 * tested here — a unique index, an RLS policy, a BEFORE UPDATE trigger,
 * transaction rollback, two sessions racing for the same row — exists only in
 * the database. A fake would assert that the fake works.
 *
 * Two connections, deliberately:
 *
 *   APP   `kilowattx_app`, unprivileged, NOBYPASSRLS. This is the connection
 *         under test, and it is the one the API uses in production.
 *   OWNER the table owner, used only to TRUNCATE and seed. TRUNCATE bypasses
 *         row triggers and seeding has to cross RLS, so neither belongs on
 *         the connection whose behaviour is the subject of the test.
 *
 * Connecting as a superuser would make every RLS assertion here pass
 * vacuously: a superuser bypasses RLS unconditionally, so the policies would
 * be reported as working while protecting nothing.
 */

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://kilowattx_app:local_dev_only@localhost:5434/kilowattx_test";

export const OWNER_DATABASE_URL =
  process.env.OWNER_DATABASE_URL ??
  "postgresql://kilowattx:local_dev_only@localhost:5434/kilowattx_test";

/**
 * Refuses to run against anything that is not obviously a test database.
 *
 * A test suite truncates every table it touches. Pointed at the development
 * database that is an annoyance; pointed at a copy of production it is a
 * disaster, and the only thing between those outcomes is an environment
 * variable someone set in a hurry.
 */
/** Hostnames that can only mean this machine or the local compose network. */
const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
  "host.docker.internal",
  "postgres",
  "db",
]);

export function assertTestDatabase(url: string): void {
  const database = url.split("/").pop()?.split("?")[0] ?? "";
  if (!/test/i.test(database)) {
    throw new Error(
      `Refusing to run integration tests against "${database}": the database name must contain "test". ` +
        "These tests truncate tables.",
    );
  }
  /**
   * And the host must be this machine.
   *
   * A database called `kyc_test` on a managed host is still somebody's
   * database, and a hostname is the only clue available before the first
   * TRUNCATE. An allowlist rather than a blocklist: a blocklist has to name
   * every provider, and the one it does not name is the one that gets
   * emptied.
   */
  const authority = (url.replace(/^[a-z]+:\/\//i, "").split("/")[0] ?? "")
    .split("@")
    .pop()!;
  /**
   * A bracketed IPv6 literal is taken whole. Splitting it on ":" the way a
   * host:port pair is split would leave the empty string, which matches
   * nothing in the allowlist and would refuse a perfectly local database.
   */
  const bracketed = /^\[([^\]]*)\]/.exec(authority);
  const host = (bracketed ? bracketed[1]! : authority.split(":")[0]!).toLowerCase();
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `Refusing to run integration tests against host "${host}": these tests truncate tables, ` +
        "and only a database on this machine is safe to empty.",
    );
  }
}

/** The connection under test: unprivileged, subject to RLS. */
export function openTestDatabase(): DatabaseHandle {
  assertTestDatabase(TEST_DATABASE_URL);
  return createClient({ url: TEST_DATABASE_URL, maxConnections: 15 });
}

/** Setup and teardown only. */
export function openOwnerDatabase(): DatabaseHandle {
  assertTestDatabase(OWNER_DATABASE_URL);
  return createClient({ url: OWNER_DATABASE_URL, maxConnections: 5 });
}

/**
 * Asserts the application role genuinely cannot bypass RLS.
 *
 * Calls the guard function installed by migration 0002. If someone ever
 * grants the app role superuser or BYPASSRLS, this fails loudly instead of
 * every RLS test quietly becoming a no-op.
 */
export async function assertRlsIsEnforceable(owner: DatabaseHandle): Promise<void> {
  await owner.sql`SELECT assert_app_role_cannot_bypass_rls()`;
}

/**
 * Empties every table the KYC module writes to. Runs as the owner.
 *
 * TRUNCATE rather than DELETE, because DELETE on an append-only table is
 * blocked by its own trigger — which is correct, and is exactly what makes a
 * naive cleanup fail. TRUNCATE is DDL and does not fire row triggers.
 */
export async function resetTables(owner: DatabaseHandle): Promise<void> {
  await owner.sql.unsafe(`
    TRUNCATE TABLE
      audit_log,
      outbox_events,
      kyc_checks,
      documents,
      land_parcels,
      org_members,
      kyc_records,
      organisations,
      consent_records,
      seen_webhook_events,
      users
    RESTART IDENTITY CASCADE
  `);
}

/** Creates a user. Runs as the owner, since users has no customer policy. */
export async function createTestUser(
  owner: DatabaseHandle,
  phone: string,
  name = "Test User",
): Promise<string> {
  const rows = await owner.sql<{ id: string }[]>`
    INSERT INTO users (phone_e164, display_name, phone_verified_at)
    VALUES (${phone}, ${name}, now())
    RETURNING id
  `;
  return rows[0]!.id;
}

type Reserved = Awaited<ReturnType<DatabaseHandle["sql"]["reserve"]>>;

/**
 * Runs a callback on the app connection with the RLS context set.
 *
 * The connection is reserved for the duration. That matters: the settings are
 * session-scoped here, and a pooled driver could otherwise run set_config and
 * the query on two different connections, leaving the query with no context
 * at all.
 */
export async function asRole<T>(
  app: DatabaseHandle,
  role: "customer" | "staff" | "system",
  userId: string | null,
  work: (tx: Reserved) => Promise<T>,
): Promise<T> {
  const reserved = await app.sql.reserve();
  try {
    await reserved`select set_config('app.role', ${role}, false)`;
    await reserved`select set_config('app.current_user_id', ${userId ?? ""}, false)`;
    return await work(reserved);
  } finally {
    await reserved`select set_config('app.role', '', false)`;
    await reserved`select set_config('app.current_user_id', '', false)`;
    reserved.release();
  }
}

/** Convenience for the common `select count(*)` assertion. */
export async function countOf(
  handle: DatabaseHandle,
  table: string,
): Promise<number> {
  const rows = await handle.sql.unsafe<{ count: string }[]>(
    `SELECT count(*)::text AS count FROM ${table}`,
  );
  return Number(rows[0]!.count);
}
