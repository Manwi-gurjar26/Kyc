import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema } from "./schema.js";

/**
 * Database client.
 *
 * In production this points at managed Postgres in an Indian region, through
 * a connection pooler so connections do not run out as containers scale. The
 * pooling means a connection is reused across requests, which is why every
 * request-scoped setting is SET LOCAL inside a transaction rather than SET on
 * the session.
 */

export type Database = PostgresJsDatabase<typeof schema>;

export interface CreateClientOptions {
  url: string;
  /** Keep this small per container; the external pooler does the real pooling. */
  maxConnections?: number;
  /** postgres-js logs every statement when true. Never in production. */
  debug?: boolean;
}

export interface DatabaseHandle {
  db: Database;
  /** The underlying driver, for migrations and raw SQL. */
  sql: postgres.Sql;
  close(): Promise<void>;
}

export function createClient(options: CreateClientOptions): DatabaseHandle {
  if (!options.url) {
    throw new Error("createClient: DATABASE_URL is required");
  }

  const sql = postgres(options.url, {
    max: options.maxConnections ?? 10,
    /**
     * postgres-js parses timestamptz into Date by default, which is what we
     * want. Dates are compared and stored in UTC everywhere; nothing in this
     * system reasons in local time.
     */
    onnotice: options.debug ? undefined : () => {},
    debug: options.debug ?? false,
  });

  return {
    db: drizzle(sql, { schema }),
    sql,
    close: () => sql.end({ timeout: 5 }),
  };
}

/**
 * The request context RLS reads.
 *
 * `role` decides which policies apply:
 *   customer  sees only their own rows, and cannot write their KYC status
 *   staff     reads every case; which cases they may act on is enforced by
 *             canReviewCase() in packages/core
 *   system    the webhook handler and the worker, which do write decisions
 */
export interface RequestContext {
  role: "customer" | "staff" | "system";
  /** Required for `customer`; ignored otherwise. */
  userId?: string;
}

/**
 * Runs work inside a transaction with the RLS context applied.
 *
 * SET LOCAL, not SET: the values are discarded when the transaction ends, so a
 * pooled connection cannot carry one request's identity into the next one.
 * That bug is silent, intermittent, and hands one customer another customer's
 * KYC record, which is why there is no non-transactional variant of this
 * function to reach for.
 */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export async function withContext<T>(
  db: Database,
  context: RequestContext,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  if (context.role === "customer" && !context.userId) {
    throw new Error("withContext: a customer context requires a userId");
  }

  return db.transaction(async (tx) => {
    /**
     * set_config(name, value, is_local => true) is the parameterisable
     * equivalent of SET LOCAL. Plain `SET LOCAL` does not accept a bind
     * parameter, so using it would mean concatenating the user id into SQL —
     * an injection hole on precisely the value an attacker most wants to
     * control, since it is the value every RLS policy compares against.
     */
    await tx.execute(sql`select set_config('app.role', ${context.role}, true)`);
    await tx.execute(
      sql`select set_config('app.current_user_id', ${context.userId ?? ""}, true)`,
    );

    return work(tx);
  });
}
