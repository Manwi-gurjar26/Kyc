import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { Transaction } from "../client.js";
import { outboxEvents } from "../schema.js";

/**
 * Draining the transactional outbox.
 *
 * Writing the event row inside the business transaction is what makes "data
 * saved but notification never sent" impossible. That guarantee is worth
 * nothing unless something drains the table, and draining it safely across
 * several workers is where it gets interesting.
 */

/**
 * How long to wait before each retry, indexed by attempts so far.
 *
 * Retrying a failing vendor immediately, in a tight loop, turns one vendor
 * outage into a self-inflicted denial of service against them plus a bill for
 * us. Index 0 is unused; attempts start at 1.
 */
export const BACKOFF_SECONDS = [0, 10, 60, 300, 1_800, 7_200] as const;

/**
 * Attempts before an event is left alone.
 *
 * An event retrying forever is worse than a dead one: it is invisible, it
 * costs money, and nobody is told. A DEAD event stops costing anything and
 * starts showing up in the count that pages somebody.
 */
export const MAX_ATTEMPTS = 5;

export interface ClaimedEvent {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  attempts: number;
}

/**
 * Takes a batch of due events and marks them PROCESSING.
 *
 * `FOR UPDATE SKIP LOCKED` is the whole mechanism. Without SKIP LOCKED, a
 * second worker's claim query BLOCKS on the rows the first worker has locked,
 * and then — once the first transaction commits — returns those same rows,
 * because the query re-evaluates. Every notification would go out twice. With
 * it, the second worker steps over what is already claimed and picks up
 * different work, which is also what lets the pool of workers scale.
 *
 * The sub-select is required: Postgres does not accept FOR UPDATE on an
 * UPDATE statement, so the rows are selected and locked first, then updated
 * by id within the same transaction.
 */
export async function claimOutboxBatch(
  tx: Transaction,
  options: { limit: number; now: Date },
): Promise<ClaimedEvent[]> {
  const due = await tx
    .select({ id: outboxEvents.id })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.status, "PENDING"),
        lte(outboxEvents.availableAt, options.now),
      ),
    )
    /** Oldest first, so an awkward event cannot starve behind newer ones. */
    .orderBy(outboxEvents.createdAt)
    .limit(options.limit)
    .for("update", { skipLocked: true });

  if (due.length === 0) return [];

  const ids = due.map((row) => row.id);

  const claimed = await tx
    .update(outboxEvents)
    .set({
      status: "PROCESSING",
      /** Counted here, so a worker that dies mid-handler still burns one. */
      attempts: sql`${outboxEvents.attempts} + 1`,
    })
    .where(inArray(outboxEvents.id, ids))
    .returning({
      id: outboxEvents.id,
      eventType: outboxEvents.eventType,
      aggregateType: outboxEvents.aggregateType,
      aggregateId: outboxEvents.aggregateId,
      payload: outboxEvents.payload,
      attempts: outboxEvents.attempts,
    });

  return claimed;
}

/** Marks an event handled. */
export async function completeOutboxEvent(
  tx: Transaction,
  id: string,
  now: Date,
): Promise<void> {
  await tx
    .update(outboxEvents)
    .set({ status: "DONE", processedAt: now, lastError: null })
    .where(eq(outboxEvents.id, id));
}

/**
 * Records a failure and schedules the retry, or gives up.
 *
 * Giving up is deliberate and visible: the status becomes DEAD, which is what
 * the alert counts. Nothing retries it again without somebody deciding to.
 */
export async function failOutboxEvent(
  tx: Transaction,
  params: { id: string; attempts: number; error: string; now: Date },
): Promise<{ status: "PENDING" | "DEAD"; retryAt: Date | null }> {
  if (params.attempts >= MAX_ATTEMPTS) {
    await tx
      .update(outboxEvents)
      .set({ status: "DEAD", lastError: params.error })
      .where(eq(outboxEvents.id, params.id));
    return { status: "DEAD", retryAt: null };
  }

  const waitSeconds =
    BACKOFF_SECONDS[params.attempts] ?? BACKOFF_SECONDS[BACKOFF_SECONDS.length - 1]!;
  const retryAt = new Date(params.now.getTime() + waitSeconds * 1000);

  await tx
    .update(outboxEvents)
    .set({ status: "PENDING", availableAt: retryAt, lastError: params.error })
    .where(eq(outboxEvents.id, params.id));

  return { status: "PENDING", retryAt };
}

/**
 * Releases events stuck in PROCESSING.
 *
 * A worker can be killed between claiming and finishing — a deploy, an OOM,
 * a container replaced. Its events would otherwise sit in PROCESSING
 * forever, claimed by nobody and retried by nobody. This is the sweep that
 * notices, and it is why `attempts` is incremented at claim time rather than
 * on completion: a task that dies in a loop still runs out of attempts.
 */
export async function releaseStuckEvents(
  tx: Transaction,
  params: { now: Date; stuckAfterSeconds: number },
): Promise<number> {
  const cutoff = new Date(params.now.getTime() - params.stuckAfterSeconds * 1000);

  const released = await tx
    .update(outboxEvents)
    .set({
      status: "PENDING",
      availableAt: params.now,
      lastError: "Released after a worker stopped mid-processing",
    })
    .where(
      and(
        eq(outboxEvents.status, "PROCESSING"),
        lte(outboxEvents.createdAt, cutoff),
      ),
    )
    .returning({ id: outboxEvents.id });

  return released.length;
}

export interface OutboxStats {
  pending: number;
  processing: number;
  done: number;
  dead: number;
  /** Null when nothing is pending, rather than 0, which would read as fresh. */
  oldestPendingAgeSeconds: number | null;
}

/** What the jobs dashboard shows and the alerts watch. */
export async function outboxStats(tx: Transaction, now: Date): Promise<OutboxStats> {
  const rows = await tx
    .select({
      status: outboxEvents.status,
      count: sql<number>`count(*)::int`,
      oldest: sql<string | null>`min(${outboxEvents.createdAt})`,
    })
    .from(outboxEvents)
    .groupBy(outboxEvents.status);

  const byStatus = new Map(rows.map((row) => [row.status, row]));
  const pendingRow = byStatus.get("PENDING");

  return {
    pending: pendingRow?.count ?? 0,
    processing: byStatus.get("PROCESSING")?.count ?? 0,
    done: byStatus.get("DONE")?.count ?? 0,
    dead: byStatus.get("DEAD")?.count ?? 0,
    oldestPendingAgeSeconds: pendingRow?.oldest
      ? Math.floor((now.getTime() - new Date(pendingRow.oldest).getTime()) / 1000)
      : null,
  };
}
