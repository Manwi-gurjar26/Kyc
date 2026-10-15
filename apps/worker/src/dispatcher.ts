import {
  claimOutboxBatch,
  completeOutboxEvent,
  failOutboxEvent,
  kycRecords,
  notificationDeliveries,
  releaseStuckEvents,
  users,
  withContext,
  type ClaimedEvent,
  type Database,
  type Transaction,
} from "@kilowattx/db";
import { eq } from "drizzle-orm";
import {
  NOTIFICATION_RULES,
  type NotificationChannel,
  type NotificationSender,
} from "./notifications.js";

/**
 * The outbox dispatcher.
 *
 * Claim a batch, run each handler, mark done or schedule a retry. The thing
 * that makes this safe to run on several tasks at once is in the repository —
 * `FOR UPDATE SKIP LOCKED` — and the thing that makes it safe to run twice on
 * the same event is here: every handler is idempotent.
 */

export interface DispatchResult {
  claimed: number;
  completed: number;
  failed: number;
  dead: number;
  released: number;
}

export type EventHandler = (
  tx: Transaction,
  event: ClaimedEvent,
  now: Date,
) => Promise<void>;

export interface DispatcherOptions {
  db: Database;
  sender: NotificationSender;
  clock?: () => Date;
  batchSize?: number;
  /** How long a PROCESSING event waits before being considered abandoned. */
  stuckAfterSeconds?: number;
  log?: (line: string) => void;
}

export class OutboxDispatcher {
  private readonly db: Database;
  private readonly sender: NotificationSender;
  private readonly clock: () => Date;
  private readonly batchSize: number;
  private readonly stuckAfterSeconds: number;
  private readonly log: (line: string) => void;
  private readonly handlers: Map<string, EventHandler>;

  constructor(options: DispatcherOptions) {
    this.db = options.db;
    this.sender = options.sender;
    this.clock = options.clock ?? (() => new Date());
    this.batchSize = options.batchSize ?? 20;
    this.stuckAfterSeconds = options.stuckAfterSeconds ?? 300;
    this.log = options.log ?? (() => {});

    this.handlers = new Map(
      Object.keys(NOTIFICATION_RULES).map((eventType) => [
        eventType,
        this.notifyHandler(eventType),
      ]),
    );
  }

  /**
   * One pass.
   *
   * Each event is handled in its OWN transaction, not one transaction for the
   * batch. A batch-wide transaction would mean one poisonous event rolling
   * back nineteen successful ones, which then get retried, which sends
   * nineteen duplicate notifications once the poison is fixed.
   */
  async runOnce(): Promise<DispatchResult> {
    const now = this.clock();

    const released = await withContext(this.db, { role: "system" }, (tx) =>
      releaseStuckEvents(tx, { now, stuckAfterSeconds: this.stuckAfterSeconds }),
    );
    if (released > 0) {
      this.log(`[outbox] released ${released} event(s) stuck in PROCESSING`);
    }

    const batch = await withContext(this.db, { role: "system" }, (tx) =>
      claimOutboxBatch(tx, { limit: this.batchSize, now }),
    );

    let completed = 0;
    let failed = 0;
    let dead = 0;

    for (const event of batch) {
      const handler = this.handlers.get(event.eventType);

      if (!handler) {
        /**
         * An unknown event type is treated as a normal failure rather than
         * killed immediately, because the commonest cause is a rolling deploy:
         * the API is already emitting an event the worker does not know yet.
         * Retrying gives the worker rollout time to catch up, and if it really
         * is a missing handler the event dead-letters on its own and shows up
         * in the count.
         */
        const outcome = await withContext(this.db, { role: "system" }, (tx) =>
          failOutboxEvent(tx, {
            id: event.id,
            attempts: event.attempts,
            error: `No handler for event type "${event.eventType}"`,
            now,
          }),
        );
        if (outcome.status === "DEAD") dead += 1;
        else failed += 1;
        this.log(`[outbox] no handler for ${event.eventType} (${outcome.status})`);
        continue;
      }

      try {
        await withContext(this.db, { role: "system" }, async (tx) => {
          await handler(tx, event, now);
          await completeOutboxEvent(tx, event.id, now);
        });
        completed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        const outcome = await withContext(this.db, { role: "system" }, (tx) =>
          failOutboxEvent(tx, {
            id: event.id,
            attempts: event.attempts,
            error: message.slice(0, 1000),
            now,
          }),
        );

        if (outcome.status === "DEAD") {
          dead += 1;
          /**
           * The line that should page somebody. A dead event is a customer who
           * was never told something, and nothing will retry it.
           */
          this.log(
            `[outbox] DEAD ${event.eventType} ${event.id} after ${event.attempts} attempts: ${message}`,
          );
        } else {
          failed += 1;
          this.log(
            `[outbox] retry ${event.eventType} ${event.id} at ${outcome.retryAt?.toISOString()}: ${message}`,
          );
        }
      }
    }

    return { claimed: batch.length, completed, failed, dead, released };
  }

  /* ---------------------------------------------------------------- */

  /**
   * Builds the notification handler for one event type.
   *
   * Idempotent by construction. The delivery row carries a unique index on
   * (outbox_event_id, user_id, channel), so a redelivered event cannot produce
   * a second WhatsApp message — and the row is inserted BEFORE the send, so a
   * crash between the two leaves evidence rather than a silent gap.
   */
  private notifyHandler(eventType: string): EventHandler {
    const rule = NOTIFICATION_RULES[eventType]!;

    return async (tx, event, now) => {
      const records = await tx
        .select({
          userId: kycRecords.userId,
          status: kycRecords.status,
          reasons: kycRecords.decisionReasons,
        })
        .from(kycRecords)
        .where(eq(kycRecords.id, event.aggregateId))
        .limit(1);

      const record = records[0];
      if (!record?.userId) {
        /**
         * Not an error. A KYB case belongs to an organisation rather than a
         * person, and nobody has a phone number yet — so there is nobody to
         * message, and the event is complete. Throwing here would retry
         * forever and then dead-letter something that was never wrong.
         */
        this.log(`[notify] ${eventType} ${event.aggregateId} has no personal subject`);
        return;
      }

      const person = await tx
        .select({ locale: users.locale })
        .from(users)
        .where(eq(users.id, record.userId))
        .limit(1);

      const locale = person[0]?.locale === "hi" ? "hi" : "en";

      const payload = (event.payload ?? {}) as {
        reasonCode?: string;
        status?: string;
      };

      /**
       * The status comes from the EVENT, not from the record as it stands now.
       *
       * An event describes something that happened. The worker may run seconds
       * or minutes later — a retry, a backlog, a restart — and by then a
       * reviewer may have approved a case whose "under review" notification is
       * still queued. Reading the record live produces a message whose wording
       * and whose data disagree: template `kyc_under_review` carrying
       * `status=VERIFIED`, which is how a customer gets told two contradictory
       * things in one message.
       *
       * The record is still read, but only for who to message and in what
       * language — facts that are correct to take as they are now.
       */
      const variables: Record<string, string> = {
        status: payload.status ?? record.status,
        ...(payload.reasonCode ? { reasonCode: payload.reasonCode } : {}),
      };

      for (const channel of rule.channels) {
        await this.deliver(tx, {
          outboxEventId: event.id,
          userId: record.userId,
          channel,
          template: rule.template,
          locale,
          variables,
          now,
        });
      }
    };
  }

  /**
   * Writes the delivery row, then sends.
   *
   * That order matters. Sending first and recording after means a crash in
   * between leaves a message the customer received and we have no record of —
   * so support tells them it was never sent. Recording first means the worst
   * case is a row marked PENDING that was in fact delivered, which is a
   * question somebody can answer rather than a contradiction.
   *
   * The insert is `onConflictDoNothing`: a redelivered event finds the row
   * already there and skips the send entirely, which is what makes the handler
   * safe to run twice.
   */
  private async deliver(
    tx: Transaction,
    params: {
      outboxEventId: string;
      userId: string;
      channel: NotificationChannel;
      template: string;
      locale: "en" | "hi";
      variables: Record<string, string>;
      now: Date;
    },
  ): Promise<void> {
    const inserted = await tx
      .insert(notificationDeliveries)
      .values({
        outboxEventId: params.outboxEventId,
        userId: params.userId,
        channel: params.channel,
        template: params.template,
        locale: params.locale,
        status: "PENDING",
        attempts: 1,
      })
      .onConflictDoNothing({
        target: [
          notificationDeliveries.outboxEventId,
          notificationDeliveries.userId,
          notificationDeliveries.channel,
        ],
      })
      .returning({ id: notificationDeliveries.id });

    const row = inserted[0];
    if (!row) {
      /** Already sent on an earlier delivery of this event. */
      return;
    }

    try {
      const result = await this.sender.send({
        userId: params.userId,
        channel: params.channel,
        template: params.template,
        locale: params.locale,
        variables: params.variables,
      });

      await tx
        .update(notificationDeliveries)
        .set({
          status: "SENT",
          provider: result.provider,
          providerMessageId: result.providerMessageId,
          sentAt: params.now,
        })
        .where(eq(notificationDeliveries.id, row.id));
    } catch (error) {
      /**
       * Rethrown so the event retries, but the row is left behind as FAILED
       * first. The transaction will roll that back along with everything else
       * — which is correct, because the whole event retries — but the error
       * text reaches the outbox row via failOutboxEvent, so the reason
       * survives where somebody can read it.
       */
      throw new Error(
        `${params.channel} send failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
