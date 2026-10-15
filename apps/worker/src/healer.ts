import type { Database } from "@kilowattx/db";
import {
  PlaceholderPanEncryptor,
  loadThresholdsLogging,
  type PanEncryptor,
} from "@kilowattx/kyc-pipeline";
import type { KycThresholds } from "@kilowattx/core";

/**
 * What reconciliation needs in order to finish a case rather than only report
 * it.
 *
 * Assembled here rather than inline in main.ts so the tests exercise the real
 * wiring. The thresholds were the compiled defaults until recently — meaning a
 * case healed by the worker was decided against different numbers from the
 * same case decided by the API's webhook — and a test that built its own
 * healer could not have caught that, because the thing being got wrong was the
 * assembly.
 */

export interface Healer {
  thresholds: KycThresholds;
  blindIndexKey: Buffer;
  encryptor: PanEncryptor;
}

export interface HealerFactoryOptions {
  db: Database;
  /** 32+ bytes, base64. Keys the duplicate-PAN blind index. */
  blindIndexKeyBase64: string;
  nodeEnv: string;
  log: (line: string) => void;
}

/**
 * Returns a function that builds a healer, reading the thresholds each time.
 *
 * Per pass, not once at boot. A long-running worker that cached them would
 * still be deciding against last week's bar, and a retune that only takes
 * effect on the next deploy is not a retune — which is the whole reason the
 * thresholds live in a table.
 *
 * The key and the encryptor are built once: neither comes from the database,
 * and the placeholder encryptor refuses to construct in production, so it
 * should fail at boot rather than on the first case it is handed.
 */
export function healerFactory(options: HealerFactoryOptions): () => Promise<Healer> {
  const blindIndexKey = Buffer.from(options.blindIndexKeyBase64, "base64");
  const encryptor = new PlaceholderPanEncryptor(options.nodeEnv);

  return async () => ({
    thresholds: await loadThresholdsLogging(options.db, options.log),
    blindIndexKey,
    encryptor,
  });
}
