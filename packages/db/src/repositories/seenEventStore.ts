import type { SeenEventStore } from "@kilowattx/integrations";
import type { Sql } from "postgres";

/**
 * The Postgres implementation of replay protection.
 *
 * The entire mechanism is one statement. `ON CONFLICT DO NOTHING` with a
 * `RETURNING` clause either inserts a row and returns it, or inserts nothing
 * and returns nothing — and the database decides which, under its own
 * serialisation on the primary key.
 *
 * That is what makes this safe across processes. Two API containers handling
 * the same retried delivery both issue this statement; Postgres lets exactly
 * one of them insert. No application-level lock, no read-then-write window,
 * nothing to get wrong under load.
 *
 * The version this replaces in anyone's first draft is:
 *
 *   const seen = await db.select().from(table).where(eq(key, k));
 *   if (seen.length) return false;
 *   await db.insert(table).values({ key: k });
 *   return true;
 *
 * which works in every test, works in development, works in staging, and
 * double-processes webhooks in production the first time two tasks are up at
 * once.
 *
 * On the `::timestamptz` casts: a bare `${date}` here fails. Postgres replies
 * to the prepare with ParameterDescription saying the parameter is type 1184,
 * postgres-js then takes a path that writes the value as a string, and a Date
 * is not a string — `TypeError: The "string" argument must be of type
 * string`. Passing an ISO string with an explicit cast lets the driver settle
 * the type itself and removes the dependency on inference entirely.
 *
 * Drizzle's query builder is unaffected, because it declares each column's
 * type. Only hand-written SQL is exposed to this.
 */
export class PostgresSeenEventStore implements SeenEventStore {
  constructor(private readonly sql: Sql) {}

  async rememberIfNew(key: string, expiresAt: Date): Promise<boolean> {
    const rows = await this.sql<{ key: string }[]>`
      INSERT INTO seen_webhook_events (key, expires_at)
      VALUES (${key}, ${expiresAt.toISOString()}::timestamptz)
      ON CONFLICT (key) DO NOTHING
      RETURNING key
    `;
    /** A row came back only if this statement was the one that inserted it. */
    return rows.length === 1;
  }

  /**
   * Drops expired entries. Runs as a pg-boss job, not on the request path.
   *
   * Without this the table grows forever. With a 7-day retention it stays
   * small, and nothing needs the rows once no vendor would still retry.
   */
  async purgeExpired(now: Date): Promise<number> {
    const rows = await this.sql<{ key: string }[]>`
      DELETE FROM seen_webhook_events
      WHERE expires_at <= ${now.toISOString()}::timestamptz
      RETURNING key
    `;
    return rows.length;
  }
}
