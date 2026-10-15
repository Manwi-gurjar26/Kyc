/**
 * The KYC status state machine.
 *
 * KYC is not in the stack doc's list of state machines, but it behaves exactly
 * like leads and agreements do, so it follows the same pattern: a typed
 * transition table in packages/core, guards on every move, and an audit_log
 * row plus an outbox event written for each transition.
 *
 * Nothing outside packages/core may assign a status. The API calls
 * decideKyc() or a review action; both route through assertTransition().
 */

export const KYC_STATUSES = [
  /** No verification attempted. */
  "NOT_STARTED",
  /** A vendor session is open; we are waiting for the signed result. */
  "IN_PROGRESS",
  /** A person has to look at this. Carries reasons. */
  "MANUAL_REVIEW",
  /** Cleared. Unlocks whatever the subject's role gates on. */
  "VERIFIED",
  /** Failed. A fresh attempt is allowed; direct promotion is not. */
  "REJECTED",
  /** Fraud. Admin-only, maker-checker, and it overrides everything. */
  "BLOCKED",
] as const;

export type KycStatus = (typeof KYC_STATUSES)[number];

/**
 * Legal moves, keyed by the state we are leaving.
 *
 * Two rules are encoded here deliberately:
 *
 *  1. REJECTED cannot reach VERIFIED. The only ways out are a fresh attempt
 *     (IN_PROGRESS) or a block. A property test asserts this, because an
 *     accidental edge here would let a failed check be laundered into a pass.
 *
 *  2. VERIFIED cannot quietly fall back to IN_PROGRESS or MANUAL_REVIEW. Once
 *     someone is cleared, the only move is BLOCKED, which is an explicit,
 *     logged, two-person fraud action. Re-KYC starts a new record rather than
 *     reopening this one, so the old decision stays auditable.
 */
const ALLOWED: Readonly<Record<KycStatus, readonly KycStatus[]>> = {
  NOT_STARTED: ["IN_PROGRESS", "BLOCKED"],
  IN_PROGRESS: ["VERIFIED", "MANUAL_REVIEW", "REJECTED", "BLOCKED"],
  /**
   * IN_PROGRESS is the reviewer's third option: ask for a clearer selfie or a
   * better scan, which sends the case back to the customer instead of
   * resolving it. Without it, a reviewer looking at a blurry sale deed can
   * only approve something they cannot read or reject someone who has done
   * nothing wrong.
   */
  MANUAL_REVIEW: ["VERIFIED", "REJECTED", "IN_PROGRESS", "BLOCKED"],
  VERIFIED: ["BLOCKED"],
  REJECTED: ["IN_PROGRESS", "BLOCKED"],
  BLOCKED: ["IN_PROGRESS"],
};

/** Whether moving from one status to another is permitted. */
export function canTransition(from: KycStatus, to: KycStatus): boolean {
  if (from === to) return false;
  return ALLOWED[from].includes(to);
}

/**
 * Whether a status has no moves left.
 *
 * Nothing is terminal on purpose: Support must always have a way to move a
 * stuck subject forward, and a dead-end status would mean a human being with
 * no route out of it and no route to an answer.
 */
export function isTerminal(status: KycStatus): boolean {
  return ALLOWED[status].length === 0;
}

/**
 * Returns the target status, or throws if the move is not legal.
 *
 * Every status write goes through this, so an illegal transition fails loudly
 * inside the transaction rather than landing in the database.
 */
export function assertTransition(from: KycStatus, to: KycStatus): KycStatus {
  if (!canTransition(from, to)) {
    throw new Error(
      `Illegal KYC transition: ${from} -> ${to}. Allowed from ${from}: ${
        ALLOWED[from].join(", ") || "(none)"
      }`,
    );
  }
  return to;
}

/** The statuses that let a guarded action through. */
export function isCleared(status: KycStatus): boolean {
  return status === "VERIFIED";
}
