import { DEFAULT_KYC_THRESHOLDS, type KycThresholds } from "@kilowattx/core";
import { settings, type Database, type Transaction } from "@kilowattx/db";

/**
 * The thresholds Ops can retune without a release.
 *
 * One loader, used by the API when a webhook arrives and by the worker when
 * reconciliation heals a case. It lives here rather than in either app because
 * two copies meant exactly one bug: the worker used the compiled defaults while
 * the API read the table, so the same case got a different answer depending on
 * which path reached it.
 *
 * Read on every decision, never cached. The whole point of keeping them in the
 * database is that a retune takes effect now; a cache would mean it takes
 * effect whenever the processes next restart, which is not a behaviour anybody
 * can reason about at 2am.
 */

export const THRESHOLD_SETTING_PREFIX = "kyc.threshold.";

export interface RejectedThreshold {
  key: keyof KycThresholds;
  /** What was in the table, for the log line. */
  value: unknown;
  reason: string;
}

export interface LoadedThresholds {
  thresholds: KycThresholds;
  /**
   * Values that were present and refused.
   *
   * Returned rather than thrown. One nonsensical setting must not take the
   * other four down with it, and it must not stop verification either — the
   * default is safe, and refusing to run would turn a typo into an outage.
   *
   * But it is never silent: a threshold Ops believes is in force while it is
   * not is worse than one they never set.
   */
  rejected: RejectedThreshold[];
}

/* ------------------------------------------------------------------ */

/**
 * What each threshold is allowed to be.
 *
 * These bounds are the substance of this module. Reading a number out of a
 * table is trivial; refusing one that would quietly disable a check is not.
 *
 * A face-match threshold of 0 passes every face, including a photograph of a
 * photograph — and the check still appears in the audit trail reporting
 * success, having tested nothing. That failure is invisible by construction,
 * which is why the floor is enforced here rather than trusted to whoever edits
 * the row.
 */
const RULES: Record<
  keyof KycThresholds,
  { min: number; max: number; integer: boolean; why: string }
> = {
  /** A score, so 0..1. Zero would pass every face. */
  faceMatch: {
    min: 0.5,
    max: 1,
    integer: false,
    why: "a face-match score is between 0 and 1, and below 0.5 it passes almost anything",
  },
  nameMatch: {
    min: 0.5,
    max: 1,
    integer: false,
    why: "a name-match score is between 0 and 1, and below 0.5 unrelated names match",
  },
  documentConfidence: {
    min: 0.5,
    max: 1,
    integer: false,
    why: "an OCR confidence is between 0 and 1, and below 0.5 illegible fields are trusted",
  },
  /**
   * Tolerating every field being illegible is tolerating no OCR at all: the
   * form would be pre-filled with guesses and nobody would be asked to check.
   */
  maxLowConfidenceFields: {
    min: 0,
    max: 10,
    integer: true,
    why: "a count of tolerated unreadable fields, 0 to 10",
  },
  /**
   * Not a business preference. Eighteen is the floor the guide cites, and a
   * lower value would onboard a child — so the setting may raise the bar and
   * never lower it.
   */
  minimumAge: {
    min: 18,
    max: 120,
    integer: true,
    why: "the minimum age may be raised above 18 but never lowered below it",
  },
};

/* ------------------------------------------------------------------ */

export async function loadThresholds(
  db: Database | Transaction,
): Promise<LoadedThresholds> {
  const rows = await db.select().from(settings);
  const byKey = new Map(rows.map((row) => [row.key, row.value]));

  const thresholds = { ...DEFAULT_KYC_THRESHOLDS };
  const rejected: RejectedThreshold[] = [];

  for (const key of Object.keys(RULES) as (keyof KycThresholds)[]) {
    /**
     * The exact key or nothing. Matching case-insensitively, or trimming, or
     * guessing at `facematch` would mean a setting nobody can find by
     * searching is the one in force.
     */
    if (!byKey.has(`${THRESHOLD_SETTING_PREFIX}${key}`)) continue;

    const raw = byKey.get(`${THRESHOLD_SETTING_PREFIX}${key}`);
    const verdict = parse(key, raw);

    if (verdict.ok) thresholds[key] = verdict.value;
    else rejected.push({ key, value: raw, reason: verdict.reason });
  }

  return { thresholds, rejected };
}

/* ------------------------------------------------------------------ */

function parse(
  key: keyof KycThresholds,
  raw: unknown,
): { ok: true; value: number } | { ok: false; reason: string } {
  const rule = RULES[key];

  /**
   * Empty string and null are checked before any arithmetic, because both
   * coerce to 0 — which is precisely the value that disables a check. This is
   * the whole reason `Number(raw)` is not used directly.
   */
  if (raw === null || raw === undefined) {
    return { ok: false, reason: "no value was set" };
  }
  if (typeof raw === "string" && raw.trim() === "") {
    return { ok: false, reason: "the value is empty" };
  }
  if (typeof raw === "boolean") {
    return { ok: false, reason: "a threshold must be a number, not true or false" };
  }

  const value = typeof raw === "number" ? raw : Number(raw);

  if (!Number.isFinite(value)) {
    return { ok: false, reason: `"${String(raw)}" is not a number` };
  }
  if (rule.integer && !Number.isInteger(value)) {
    return { ok: false, reason: `${value} must be a whole number — ${rule.why}` };
  }
  if (value < rule.min || value > rule.max) {
    return {
      ok: false,
      reason: `${value} must be between ${rule.min} and ${rule.max} — ${rule.why}`,
    };
  }

  return { ok: true, value };
}

/* ------------------------------------------------------------------ */

/**
 * Loads the thresholds and reports anything refused.
 *
 * The convenience both callers want: the thresholds, with every rejection
 * already on the log at error level. A refused threshold is an operational
 * mistake somebody has to see — Ops will otherwise believe the new bar is in
 * force while verification carries on at the old one.
 */
export async function loadThresholdsLogging(
  db: Database | Transaction,
  log: (line: string) => void,
): Promise<KycThresholds> {
  const { thresholds, rejected } = await loadThresholds(db);

  for (const bad of rejected) {
    log(
      `[thresholds] REFUSED kyc.threshold.${bad.key}=${JSON.stringify(bad.value)}: ` +
        `${bad.reason}. Using ${thresholds[bad.key]} instead — the setting is NOT in force.`,
    );
  }

  return thresholds;
}
