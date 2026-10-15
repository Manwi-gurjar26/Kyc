import type { KycThresholds } from "@kilowattx/core";
import { kycRecords, withContext, type Database } from "@kilowattx/db";
import { and, eq, lte, sql } from "drizzle-orm";
import type { KycProvider } from "@kilowattx/integrations";
import { applyVendorResult, type PanEncryptor } from "@kilowattx/kyc-pipeline";

/**
 * The safety net for missed webhooks.
 *
 * A session sits in IN_PROGRESS until the vendor's webhook arrives. Webhooks
 * get lost — a deploy mid-delivery, a network blip, a vendor outage, a
 * signature that failed verification and was correctly refused. When that
 * happens nothing else ever moves the record, so the customer waits on a
 * screen that will never change and support has no idea why.
 *
 * This job finds those sessions, asks the vendor directly, and — given a
 * `healer` — finishes the job.
 *
 * It can heal safely only because the pipeline is shared. Applying a vendor
 * result means decideKyc(), the duplicate-PAN blind index, PAN encryption and
 * the five-table transaction, all of which live in @kilowattx/kyc-pipeline
 * and are called by the API's webhook handler too. A second copy here would
 * drift from that one, silently, in the part of the system where being wrong
 * matters most — which is why this job reported only, until the extraction
 * was done.
 *
 * Without a healer it still reports, which is what alerting wants anyway.
 */

export interface StuckSession {
  kycRecordId: string;
  vendorSessionId: string;
  vendor: string | null;
  ageMinutes: number;
  /** What the vendor says, when it can be asked. */
  vendorHasResult: boolean | null;
  vendorError?: string;
}

export interface ReconciliationReport {
  checked: number;
  /** The vendor has a result we never processed. */
  resultWaiting: StuckSession[];
  /** Genuinely still in progress, or the vendor could not be reached. */
  inconclusive: StuckSession[];
  /** Applied successfully. Zero when no healer was supplied. */
  healed: number;
  /** Had a result but could not be applied. These need a human. */
  healFailures: { kycRecordId: string; error: string }[];
}

/**
 * What the sweep needs in order to finish a job rather than only report it.
 *
 * Supplying this is the difference between an alert somebody has to chase and
 * a case that completes a few minutes late.
 */
export interface Healer {
  thresholds: KycThresholds;
  /** 32+ bytes from the secret store. Keys the duplicate-PAN index. */
  blindIndexKey: Buffer;
  encryptor: PanEncryptor;
}

export interface ReconcileOptions {
  db: Database;
  provider: KycProvider;
  now: Date;
  /**
   * How long a session may sit in IN_PROGRESS before it is suspicious.
   *
   * Long enough that a person slowly working through DigiLocker, PAN and a
   * selfie is not flagged, short enough that nobody waits half a day. The
   * vendor session itself expires in about twenty minutes.
   */
  stuckAfterMinutes?: number;
  limit?: number;
  /** Omit to detect and report only. */
  healer?: Healer;
  log?: (line: string) => void;
}

export async function reconcileStuckSessions(
  options: ReconcileOptions,
): Promise<ReconciliationReport> {
  const {
    db,
    provider,
    now,
    stuckAfterMinutes = 30,
    limit = 50,
    healer,
    log = () => {},
  } = options;

  const cutoff = new Date(now.getTime() - stuckAfterMinutes * 60_000);

  const stuck = await withContext(db, { role: "system" }, (tx) =>
    tx
      .select({
        id: kycRecords.id,
        vendorSessionId: kycRecords.vendorSessionId,
        vendor: kycRecords.vendor,
        createdAt: kycRecords.createdAt,
      })
      .from(kycRecords)
      .where(
        and(
          eq(kycRecords.status, "IN_PROGRESS"),
          lte(kycRecords.createdAt, cutoff),
          sql`${kycRecords.vendorSessionId} is not null`,
        ),
      )
      .orderBy(kycRecords.createdAt)
      .limit(limit),
  );

  const report: ReconciliationReport = {
    checked: stuck.length,
    resultWaiting: [],
    inconclusive: [],
    healed: 0,
    healFailures: [],
  };

  for (const record of stuck) {
    const ageMinutes = Math.floor(
      (now.getTime() - record.createdAt.getTime()) / 60_000,
    );

    const entry: StuckSession = {
      kycRecordId: record.id,
      vendorSessionId: record.vendorSessionId!,
      vendor: record.vendor,
      ageMinutes,
      vendorHasResult: null,
    };

    try {
      const result = await provider.fetchResult(record.vendorSessionId!);
      entry.vendorHasResult = true;
      report.resultWaiting.push(entry);

      /**
       * The vendor finished and we never heard — either a webhook was lost or
       * one was refused by the signature check. The second is a security
       * signal rather than a glitch, so it is logged either way, even when the
       * sweep goes on to fix it.
       */
      log(
        `[reconcile] MISSED RESULT ${record.id} session=${record.vendorSessionId} ` +
          `age=${ageMinutes}m — the vendor has a result we never processed`,
      );

      if (!healer) continue;

      /**
       * Each session heals in its OWN transaction. One that cannot be applied
       * must not roll back the others — and the commonest cause is benign: a
       * record somebody decided by hand while this sweep was running, which
       * the state machine then correctly refuses.
       */
      try {
        const outcome = await withContext(db, { role: "system" }, (tx) =>
          applyVendorResult(tx, {
            result,
            thresholds: healer.thresholds,
            blindIndexKey: healer.blindIndexKey,
            encryptor: healer.encryptor,
            now,
            traceId: `reconcile:${result.eventId}`,
          }),
        );

        report.healed += 1;
        log(
          `[reconcile] healed ${record.id} -> ${outcome.status} ` +
            `(the customer is notified through the outbox, as if the webhook had arrived)`,
        );
      } catch (healError) {
        const message =
          healError instanceof Error ? healError.message : String(healError);
        report.healFailures.push({ kycRecordId: record.id, error: message });
        log(`[reconcile] could not heal ${record.id}: ${message}`);
      }
    } catch (error) {
      /**
       * Not necessarily a problem. The commonest cause is a person who opened
       * the flow and wandered off, so the vendor has nothing yet either.
       */
      entry.vendorHasResult = false;
      entry.vendorError = error instanceof Error ? error.message : String(error);
      report.inconclusive.push(entry);
    }
  }

  if (report.checked > 0) {
    log(
      `[reconcile] checked ${report.checked} stuck session(s): ` +
        `${report.resultWaiting.length} with a result waiting, ` +
        `${report.healed} healed, ${report.healFailures.length} could not be healed, ` +
        `${report.inconclusive.length} inconclusive`,
    );
  }

  return report;
}
