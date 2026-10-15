/**
 * Replay protection for vendor webhooks.
 *
 * The signature check proves a request came from the vendor. It cannot tell
 * you whether you have already processed it — a captured request is perfectly
 * signed. So every event id is remembered for a retention window, and a second
 * delivery is dropped.
 *
 * This matters more than it looks. Vendors retry aggressively, and our own
 * API runs on two or more containers, so the same event genuinely does
 * arrive twice at the same moment. Processing a KYC webhook twice would write
 * two kyc_checks rows and emit two outbox events, which means the customer
 * gets two WhatsApp messages and the reviewer sees a duplicate case.
 */

/**
 * The store the guard needs.
 *
 * There is exactly one method, and that is the point. The obvious interface —
 * `has(key)` then `remember(key)` — contains a race: two concurrent deliveries
 * both read "not seen", both write, and both proceed. Collapsing the test and
 * the write into one atomic operation removes the window entirely.
 *
 * The Postgres implementation is one statement:
 *
 *   INSERT INTO seen_webhook_events (key, expires_at)
 *   VALUES ($1, $2)
 *   ON CONFLICT (key) DO NOTHING
 *
 * and `rememberIfNew` is whether that inserted a row. The database's unique
 * index is what serialises the two tasks, which is the only thing that can.
 */
export interface SeenEventStore {
  /**
   * Records the key if it is not already present.
   * @returns true when this call was the one that recorded it.
   */
  rememberIfNew(key: string, expiresAt: Date): Promise<boolean>;
}

export interface ReplayCheckResult {
  /** True when this is the first time we have seen the event. */
  fresh: boolean;
}

/** How long an event id is remembered. Comfortably past any vendor's retries. */
export const DEFAULT_RETENTION_DAYS = 7;

export class ReplayGuard {
  constructor(
    private readonly store: SeenEventStore,
    private readonly retentionDays: number = DEFAULT_RETENTION_DAYS,
  ) {}

  /**
   * Whether this event should be processed.
   *
   * The key is namespaced by vendor, because event ids are only unique within
   * a vendor — two providers both numbering from "evt_1" must not shadow each
   * other.
   */
  async check(vendor: string, eventId: string, now: Date): Promise<ReplayCheckResult> {
    if (!vendor || vendor.trim() === "") {
      throw new Error("ReplayGuard.check: vendor is required");
    }
    if (!eventId || eventId.trim() === "") {
      throw new Error(
        "ReplayGuard.check: event id is required. A webhook with no id cannot be de-duplicated and must be refused.",
      );
    }

    const key = `${vendor.trim()}:${eventId.trim()}`;
    const expiresAt = new Date(
      now.getTime() + this.retentionDays * 24 * 60 * 60 * 1000,
    );

    const inserted = await this.store.rememberIfNew(key, expiresAt);
    return { fresh: inserted };
  }
}

/**
 * In-memory store, for tests and local development.
 *
 * `rememberIfNew` is written as a single synchronous check-and-set before any
 * `await`, so it is atomic with respect to the event loop. That is what lets
 * the concurrency tests pass; the optional write delay exists to prove the
 * atomicity does not depend on the store being fast.
 */
export class InMemorySeenEventStore implements SeenEventStore {
  private readonly seen = new Map<string, Date>();
  private readonly writeDelayMs: number;

  constructor(options: { writeDelayMs?: number } = {}) {
    this.writeDelayMs = options.writeDelayMs ?? 0;
  }

  async rememberIfNew(key: string, expiresAt: Date): Promise<boolean> {
    // Check and set together, with no await in between.
    if (this.seen.has(key)) {
      if (this.writeDelayMs > 0) await this.delay();
      return false;
    }
    this.seen.set(key, expiresAt);

    if (this.writeDelayMs > 0) await this.delay();
    return true;
  }

  /** Drops entries past their expiry. In Postgres this is a pg-boss job. */
  purgeExpired(now: Date): number {
    let removed = 0;
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt.getTime() <= now.getTime()) {
        this.seen.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Test helper: the expiry recorded for a key. */
  expiryOf(key: string): Date | undefined {
    return this.seen.get(key);
  }

  get size(): number {
    return this.seen.size;
  }

  private delay(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.writeDelayMs));
  }
}
