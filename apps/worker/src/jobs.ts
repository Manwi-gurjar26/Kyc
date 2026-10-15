import type { Database } from "@kilowattx/db";
import { recordHeartbeat } from "./heartbeat.js";
import type { OutboxDispatcher } from "./dispatcher.js";

/**
 * What each scheduled job actually does, separated from how it is scheduled.
 *
 * In main.ts these were closures inside main(), which meant the two pieces of
 * real logic here — drain until empty, and record every pass — had no test. The
 * healer had the same shape of problem and the same fix: a test that builds its
 * own copy of the thing proves nothing about the thing the process runs.
 */

export interface OutboxPassResult {
  batches: number;
  events: number;
  /** True when the bound was hit and work is probably still waiting. */
  hitLimit: boolean;
}

/**
 * Drains the outbox until a batch comes back empty.
 *
 * Not one batch per scheduled pass. Cron's finest resolution is a minute, so a
 * burst of several hundred events would otherwise trickle out twenty at a
 * time, one batch a minute — somebody would wait half an hour to be told their
 * KYC had been approved.
 *
 * Bounded, because a pass that never returns is a pass that blocks its own
 * next run and holds its singleton lock indefinitely. Hitting the bound is
 * reported rather than hidden: it means the backlog is growing faster than one
 * worker drains it, which is a capacity fact somebody should see.
 */
export async function drainOutbox(
  dispatcher: Pick<OutboxDispatcher, "runOnce">,
  options: { maxBatches: number },
): Promise<OutboxPassResult> {
  let batches = 0;
  let events = 0;
  /**
   * Why the loop stopped, recorded rather than inferred afterwards.
   *
   * Deriving it from the counters got this wrong: a queue that drained on its
   * last permitted batch has `batches === maxBatches` and found work, which
   * looks identical to being cut off mid-backlog. It is not — one finished and
   * one did not — and reporting the first as a capacity problem is crying
   * wolf at the number people are meant to act on.
   */
  let queueWentEmpty = false;

  while (batches < options.maxBatches) {
    const result = await dispatcher.runOnce();
    batches += 1;
    events += result.claimed;

    /** An empty claim means the queue is drained; stop rather than spin. */
    if (result.claimed === 0) {
      queueWentEmpty = true;
      break;
    }
  }

  return { batches, events, hitLimit: !queueWentEmpty };
}

/* ------------------------------------------------------------------ */

/**
 * Wraps a job so every pass is written down, whether it worked or not.
 *
 * The failure is re-thrown after being recorded. That ordering is the whole
 * point: pg-boss has to still see the job as failed so its retry policy
 * applies, and the heartbeat has to carry the error so an operator can see
 * *why* a job has been failing. Swallowing it would leave a job that reports
 * itself unhealthy while pg-boss believes it succeeded — the two would
 * disagree, and the one people page on would be wrong.
 */
export function tracked(
  db: Database,
  job: string,
  work: () => Promise<void>,
  now: () => Date = () => new Date(),
): () => Promise<void> {
  return async () => {
    try {
      await work();
    } catch (error) {
      /**
       * Recorded before re-throwing. If this write itself fails the original
       * error still has to reach pg-boss, so it is not allowed to replace it.
       */
      try {
        await recordHeartbeat(db, {
          job,
          now: now(),
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        /* the original error matters more than the bookkeeping */
      }
      throw error;
    }

    await recordHeartbeat(db, { job, now: now(), ok: true });
  };
}
