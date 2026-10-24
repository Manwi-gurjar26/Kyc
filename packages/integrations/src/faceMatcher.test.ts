import { describe, expect, test } from "vitest";
import { DEFAULT_KYC_THRESHOLDS } from "@kilowattx/core";
import {
  FACE_CLEAR_MISMATCH,
  OnnxFaceMatcher,
  SFACE_SAME_PERSON_COSINE,
  calibrate,
} from "./faceMatcher.js";

/**
 * The calibration is the part of the matcher that encodes policy, so it is
 * what is pinned here. The models themselves are 38 MB, fetched per machine
 * and not committed, and so are not exercised by this suite.
 */
describe("calibration", () => {
  /**
   * The thresholds predate this engine. If SFace's own cut-off did not land
   * exactly on the default pass mark, the default would silently be either
   * stricter or looser than the model's authors recommend.
   */
  test("SFace's same-person cut-off is exactly the default pass mark", () => {
    expect(calibrate(SFACE_SAME_PERSON_COSINE)).toBeCloseTo(DEFAULT_KYC_THRESHOLDS.faceMatch, 10);
  });

  test("it never leaves 0..1 and never decreases", () => {
    let previous = -1;
    for (let cosine = -1; cosine <= 1; cosine += 0.01) {
      const score = calibrate(cosine);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
      expect(score).toBeGreaterThanOrEqual(previous);
      previous = score;
    }
  });

  /**
   * The refuse-and-retake line sits below the pass mark, leaving a band for a
   * genuine person behind an old Aadhaar photograph to go to a reviewer.
   */
  test("a clear mismatch is well below the pass mark", () => {
    expect(FACE_CLEAR_MISMATCH).toBeLessThan(DEFAULT_KYC_THRESHOLDS.faceMatch);
    expect(FACE_CLEAR_MISMATCH).toBeCloseTo(calibrate(0.3), 10);
  });
});

describe("input", () => {
  /** Rejected before any model is loaded, so no model files are needed. */
  test("something that is not a JPEG is unreadable, not a non-match", async () => {
    const matcher = new OnnxFaceMatcher({ modelDir: "/nonexistent" });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    await expect(matcher.compare(png, png)).resolves.toEqual({ kind: "UNREADABLE_IMAGE" });
  });
});
