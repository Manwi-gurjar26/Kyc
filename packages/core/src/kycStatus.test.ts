import { describe, expect, test } from "vitest";
import {
  KYC_STATUSES,
  assertTransition,
  canTransition,
  isTerminal,
  type KycStatus,
} from "./kycStatus.js";

describe("KYC_STATUSES", () => {
  test("has the six states the guide defines", () => {
    expect([...KYC_STATUSES].sort()).toEqual([
      "BLOCKED",
      "IN_PROGRESS",
      "MANUAL_REVIEW",
      "NOT_STARTED",
      "REJECTED",
      "VERIFIED",
    ]);
  });
});

describe("canTransition", () => {
  test("a new subject starts verification", () => {
    expect(canTransition("NOT_STARTED", "IN_PROGRESS")).toBe(true);
  });

  test("verification in progress can reach any of the three outcomes", () => {
    expect(canTransition("IN_PROGRESS", "VERIFIED")).toBe(true);
    expect(canTransition("IN_PROGRESS", "MANUAL_REVIEW")).toBe(true);
    expect(canTransition("IN_PROGRESS", "REJECTED")).toBe(true);
  });

  test("a reviewer can approve or reject a case under review", () => {
    expect(canTransition("MANUAL_REVIEW", "VERIFIED")).toBe(true);
    expect(canTransition("MANUAL_REVIEW", "REJECTED")).toBe(true);
  });

  /**
   * A reviewer's third option: neither approve nor reject, but ask for a
   * clearer selfie or a better scan. That sends the case back to the customer
   * rather than resolving it, so it has to return to IN_PROGRESS.
   *
   * Without this, "ask for a re-upload" has nowhere to go, and a reviewer
   * facing a blurry deed can only approve something they cannot read or reject
   * someone who has done nothing wrong.
   */
  test("a reviewer can send a case back for a re-upload", () => {
    expect(canTransition("MANUAL_REVIEW", "IN_PROGRESS")).toBe(true);
  });

  test("a rejected subject may try again, but is never verified directly", () => {
    expect(canTransition("REJECTED", "IN_PROGRESS")).toBe(true);
    expect(canTransition("REJECTED", "VERIFIED")).toBe(false);
  });

  test("a verified subject cannot silently become unverified", () => {
    expect(canTransition("VERIFIED", "IN_PROGRESS")).toBe(false);
    expect(canTransition("VERIFIED", "MANUAL_REVIEW")).toBe(false);
    expect(canTransition("VERIFIED", "REJECTED")).toBe(false);
  });

  test("any live state can be blocked for fraud", () => {
    expect(canTransition("NOT_STARTED", "BLOCKED")).toBe(true);
    expect(canTransition("IN_PROGRESS", "BLOCKED")).toBe(true);
    expect(canTransition("MANUAL_REVIEW", "BLOCKED")).toBe(true);
    expect(canTransition("VERIFIED", "BLOCKED")).toBe(true);
    expect(canTransition("REJECTED", "BLOCKED")).toBe(true);
  });

  test("a blocked subject can only be returned to verification", () => {
    expect(canTransition("BLOCKED", "IN_PROGRESS")).toBe(true);
    expect(canTransition("BLOCKED", "VERIFIED")).toBe(false);
    expect(canTransition("BLOCKED", "MANUAL_REVIEW")).toBe(false);
  });

  test("a state never transitions to itself", () => {
    for (const status of KYC_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  /**
   * The invariant that matters most. A rejection must never be undone by
   * anything other than a recorded human decision, and the only paths out of
   * REJECTED are a fresh attempt or a block.
   */
  test("no path turns REJECTED into VERIFIED in one step", () => {
    const reachable = KYC_STATUSES.filter((to) => canTransition("REJECTED", to));
    expect(reachable).not.toContain("VERIFIED");
  });
});

describe("isTerminal", () => {
  test("VERIFIED is not terminal, because fraud can still block it", () => {
    expect(isTerminal("VERIFIED")).toBe(false);
  });

  test("no state is a dead end — support must always have a way forward", () => {
    for (const status of KYC_STATUSES) {
      expect(isTerminal(status)).toBe(false);
    }
  });
});

describe("assertTransition", () => {
  test("returns the target status for a legal move", () => {
    expect(assertTransition("IN_PROGRESS", "VERIFIED")).toBe<KycStatus>("VERIFIED");
  });

  test("throws for an illegal move, naming both states", () => {
    expect(() => assertTransition("REJECTED", "VERIFIED")).toThrow(
      /REJECTED.*VERIFIED/,
    );
  });
});
