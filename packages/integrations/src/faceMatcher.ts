import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";

/**
 * Compares a selfie with the Aadhaar photograph.
 *
 * The gateway sells no face match, so this runs on our own server: YuNet finds
 * the face and its five landmarks, the face is aligned to the 112x112 pose the
 * recogniser was trained on, and SFace turns it into a 128-number description.
 * Two descriptions of the same person point the same way; the cosine between
 * them is the comparison.
 *
 * Both models are from the OpenCV zoo (YuNet MIT, SFace Apache-2.0) and are
 * fetched by `pnpm face:models` rather than committed.
 *
 * WHAT THIS IS NOT is a liveness check. It answers "is this the same face as
 * the Aadhaar photograph", not "is a living person in front of the camera" —
 * a printed photograph of the right person passes. Stopping somebody
 * submitting a stranger's face is the job; stopping a photo of a photo is a
 * different product, and `decideKyc` records that it was not checked.
 */

export type FaceComparison =
  | {
      kind: "COMPARED";
      /**
       * 0..1, calibrated so the default pass mark of 0.75 sits on SFace's
       * published same-person cut-off. See `calibrate`.
       */
      score: number;
      /** The raw cosine, kept for the audit detail. */
      cosine: number;
    }
  /** Nothing face-shaped in the selfie: a covered camera, a wall, a hand. */
  | { kind: "NO_FACE_IN_SELFIE" }
  /** Two clear faces: the usual shape of somebody holding up another photo. */
  | { kind: "SEVERAL_FACES_IN_SELFIE" }
  /** The Aadhaar photograph has no detectable face, so nothing to compare. */
  | { kind: "NO_FACE_IN_REFERENCE" }
  /** Not a JPEG we can decode. Nothing was compared. */
  | { kind: "UNREADABLE_IMAGE" };

export interface FaceMatcher {
  compare(selfie: Uint8Array, reference: Uint8Array): Promise<FaceComparison>;
}

/* ------------------------------------------------------------------ */
/* Calibration                                                        */
/* ------------------------------------------------------------------ */

/**
 * SFace's published cut-off: a cosine at or above this is the same person.
 *
 * On the samples this was tested against, three same-person pairs scored 0.55
 * to 0.65 and fifty-two different-person pairs scored -0.13 to 0.28.
 */
export const SFACE_SAME_PERSON_COSINE = 0.363;

/**
 * Maps a raw cosine onto the 0..1 scale the thresholds are written in.
 *
 * The thresholds predate this matcher — they were written for a vendor score,
 * and `faceMatch` has a floor of 0.5 so nobody can set it to pass every face.
 * Rather than special-case one engine there, the engine speaks that scale:
 * piecewise linear through (0, 0), (0.363, 0.75) and (0.7, 1), so the default
 * pass mark of 0.75 is exactly SFace's own cut-off and raising the setting
 * makes the check stricter, as it should.
 */
export function calibrate(cosine: number): number {
  if (cosine <= 0) return 0;
  if (cosine < SFACE_SAME_PERSON_COSINE) {
    return (cosine / SFACE_SAME_PERSON_COSINE) * 0.75;
  }
  const above = (cosine - SFACE_SAME_PERSON_COSINE) / (0.7 - SFACE_SAME_PERSON_COSINE);
  return Math.min(1, 0.75 + above * 0.25);
}

/**
 * Below this a selfie is refused on the spot and the person asked to retake.
 *
 * A cosine of 0.30 — under every same-person pair tested and above every
 * different-person one but the closest. Between this and the pass mark is the
 * band where a decade-old Aadhaar photograph lands for a genuine person, and
 * that band goes to a reviewer rather than being refused.
 */
export const FACE_CLEAR_MISMATCH = calibrate(0.3);

/* ------------------------------------------------------------------ */
/* The ONNX implementation                                            */
/* ------------------------------------------------------------------ */

const DETECTOR_FILE = "face_detection_yunet_2023mar.onnx";
const RECOGNISER_FILE = "face_recognition_sface_2021dec.onnx";

/** Where `pnpm face:models` puts them. */
export const DEFAULT_FACE_MODEL_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "models",
  "face",
);

/** YuNet's exported input is fixed at 640x640. */
const DETECTOR_SIZE = 640;
const MIN_FACE_SCORE = 0.6;

/**
 * Where the five landmarks land in the 112x112 crop SFace was trained on:
 * right eye, left eye, nose tip, right and left mouth corners.
 */
const ALIGNED = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
] as const;

interface Image {
  width: number;
  height: number;
  /** Packed RGB. */
  rgb: Uint8Array;
}

interface Face {
  score: number;
  x: number;
  y: number;
  w: number;
  h: number;
  landmarks: [number, number][];
}

type Ort = typeof import("onnxruntime-node");
type Session = import("onnxruntime-node").InferenceSession;

export class OnnxFaceMatcher implements FaceMatcher {
  private readonly modelDir: string;
  private loading: Promise<{ ort: Ort; detector: Session; recogniser: Session }> | null =
    null;

  constructor(options: { modelDir?: string } = {}) {
    this.modelDir = options.modelDir ?? DEFAULT_FACE_MODEL_DIR;
  }

  /** Whether the model files are on disk. Without them there is no matcher. */
  static modelsPresent(modelDir: string = DEFAULT_FACE_MODEL_DIR): boolean {
    return (
      existsSync(join(modelDir, DETECTOR_FILE)) &&
      existsSync(join(modelDir, RECOGNISER_FILE))
    );
  }

  async compare(selfieBytes: Uint8Array, referenceBytes: Uint8Array): Promise<FaceComparison> {
    const selfie = decode(selfieBytes);
    const reference = decode(referenceBytes);
    if (!selfie || !reference) return { kind: "UNREADABLE_IMAGE" };

    const selfieFaces = await this.detect(selfie);
    if (selfieFaces.length === 0) return { kind: "NO_FACE_IN_SELFIE" };

    /**
     * A second face at least half the size of the first. Small background
     * faces — a poster, somebody walking past — are not what this is for; a
     * second face the size of the first is somebody holding up a photograph.
     */
    const [first, second] = selfieFaces;
    if (second && second.w * second.h >= 0.5 * first!.w * first!.h) {
      return { kind: "SEVERAL_FACES_IN_SELFIE" };
    }

    const referenceFaces = await this.detect(reference);
    if (referenceFaces.length === 0) return { kind: "NO_FACE_IN_REFERENCE" };

    const a = await this.describe(selfie, largest(selfieFaces));
    const b = await this.describe(reference, largest(referenceFaces));

    let cosine = 0;
    for (let i = 0; i < a.length; i++) cosine += a[i]! * b[i]!;

    return { kind: "COMPARED", score: calibrate(cosine), cosine };
  }

  /* ---------------------------------------------------------------- */

  private models() {
    this.loading ??= (async () => {
      const ort = await import("onnxruntime-node");
      /** Level 3 is errors only: SFace's export warns about every initialiser. */
      const options = { logSeverityLevel: 3 as const };
      const [detector, recogniser] = await Promise.all([
        ort.InferenceSession.create(join(this.modelDir, DETECTOR_FILE), options),
        ort.InferenceSession.create(join(this.modelDir, RECOGNISER_FILE), options),
      ]);
      return { ort, detector, recogniser };
    })();

    /** A failed load is not cached, or one bad start would disable it for good. */
    this.loading.catch(() => {
      this.loading = null;
    });

    return this.loading;
  }

  private async detect(image: Image): Promise<Face[]> {
    const { ort, detector } = await this.models();
    const size = DETECTOR_SIZE;

    /**
     * Shrunk to fit, but enlarged at most twice and centred.
     *
     * An Aadhaar photograph is a head-and-shoulders crop of about 200 pixels.
     * Stretched to fill the frame, the face touches every edge and the
     * detector — trained on faces with context around them — finds nothing.
     */
    const scale = Math.min(size / Math.max(image.width, image.height), 2);
    const drawnW = Math.round(image.width * scale);
    const drawnH = Math.round(image.height * scale);
    const offX = Math.floor((size - drawnW) / 2);
    const offY = Math.floor((size - drawnH) / 2);

    /** Planar BGR, unnormalised, which is what OpenCV feeds it. */
    const plane = size * size;
    const input = new Float32Array(3 * plane);
    for (let y = 0; y < drawnH; y++) {
      const sy = (y + 0.5) / scale - 0.5;
      for (let x = 0; x < drawnW; x++) {
        const sx = (x + 0.5) / scale - 0.5;
        const at = (y + offY) * size + (x + offX);
        input[at] = sample(image, sx, sy, 2);
        input[plane + at] = sample(image, sx, sy, 1);
        input[2 * plane + at] = sample(image, sx, sy, 0);
      }
    }

    const out = await detector.run({
      [detector.inputNames[0]!]: new ort.Tensor("float32", input, [1, 3, size, size]),
    });

    const toImage = (cx: number, cy: number): [number, number] => [
      (cx - offX) / scale,
      (cy - offY) / scale,
    ];

    const found: Face[] = [];
    for (const stride of [8, 16, 32]) {
      const cols = size / stride;
      const rows = size / stride;
      const cls = out[`cls_${stride}`]!.data as Float32Array;
      const obj = out[`obj_${stride}`]!.data as Float32Array;
      const box = out[`bbox_${stride}`]!.data as Float32Array;
      const kps = out[`kps_${stride}`]!.data as Float32Array;

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          const score = Math.sqrt(clamp01(cls[i]!) * clamp01(obj[i]!));
          if (score < MIN_FACE_SCORE) continue;

          const cx = (c + box[i * 4]!) * stride;
          const cy = (r + box[i * 4 + 1]!) * stride;
          const w = Math.exp(box[i * 4 + 2]!) * stride;
          const h = Math.exp(box[i * 4 + 3]!) * stride;
          const [x, y] = toImage(cx - w / 2, cy - h / 2);

          const landmarks: [number, number][] = [];
          for (let k = 0; k < 5; k++) {
            landmarks.push(
              toImage((kps[i * 10 + 2 * k]! + c) * stride, (kps[i * 10 + 2 * k + 1]! + r) * stride),
            );
          }

          found.push({ score, x, y, w: w / scale, h: h / scale, landmarks });
        }
      }
    }

    /** Non-maximum suppression: one box per face, the most confident. */
    found.sort((a, b) => b.score - a.score);
    const kept: Face[] = [];
    for (const face of found) {
      if (!kept.some((k) => overlap(k, face) > 0.3)) kept.push(face);
    }
    return kept.sort((a, b) => b.w * b.h - a.w * a.h);
  }

  /** The face, aligned and run through SFace, as a unit vector. */
  private async describe(image: Image, face: Face): Promise<Float32Array> {
    const { ort, recogniser } = await this.models();
    const t = similarityTransform(face.landmarks, ALIGNED);

    /** Each output pixel is read back through the inverse transform. */
    const det = t.a * t.a + t.b * t.b;
    const plane = 112 * 112;
    const input = new Float32Array(3 * plane);
    for (let v = 0; v < 112; v++) {
      for (let u = 0; u < 112; u++) {
        const du = u - t.tx;
        const dv = v - t.ty;
        const x = (t.a * du + t.b * dv) / det;
        const y = (-t.b * du + t.a * dv) / det;
        /** RGB planes: OpenCV swaps BGR to RGB for this model. */
        for (let ch = 0; ch < 3; ch++) input[ch * plane + v * 112 + u] = sample(image, x, y, ch);
      }
    }

    const out = await recogniser.run({
      [recogniser.inputNames[0]!]: new ort.Tensor("float32", input, [1, 3, 112, 112]),
    });

    const raw = out[recogniser.outputNames[0]!]!.data as Float32Array;
    let norm = 0;
    for (const value of raw) norm += value * value;
    norm = Math.sqrt(norm) || 1;
    return raw.map((value) => value / norm);
  }
}

/* ------------------------------------------------------------------ */
/* Pixels                                                             */
/* ------------------------------------------------------------------ */

function decode(bytes: Uint8Array): Image | null {
  /** JPEG magic. The selfie is a canvas JPEG and the Aadhaar Pht is a JPEG. */
  if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    return null;
  }
  try {
    const raw = jpeg.decode(bytes, {
      useTArray: true,
      formatAsRGBA: false,
      /** A phone photo is ~12 megapixels; this is headroom, not a target. */
      maxResolutionInMP: 50,
      maxMemoryUsageInMB: 512,
    });
    return { width: raw.width, height: raw.height, rgb: raw.data };
  } catch {
    return null;
  }
}

/** Bilinear, with black outside the image. */
function sample(image: Image, x: number, y: number, channel: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (px: number, py: number) =>
    px < 0 || py < 0 || px >= image.width || py >= image.height
      ? 0
      : image.rgb[(py * image.width + px) * 3 + channel]!;

  return (
    at(x0, y0) * (1 - fx) * (1 - fy) +
    at(x0 + 1, y0) * fx * (1 - fy) +
    at(x0, y0 + 1) * (1 - fx) * fy +
    at(x0 + 1, y0 + 1) * fx * fy
  );
}

/**
 * The least-squares rotation, uniform scale and shift taking `from` onto `to`,
 * as [a -b tx; b a ty]. What OpenCV's alignCrop estimates for the same job.
 */
function similarityTransform(
  from: readonly (readonly [number, number])[],
  to: readonly (readonly [number, number])[],
): { a: number; b: number; tx: number; ty: number } {
  const n = from.length;
  let fx = 0, fy = 0, tx = 0, ty = 0;
  for (let i = 0; i < n; i++) {
    fx += from[i]![0]; fy += from[i]![1];
    tx += to[i]![0]; ty += to[i]![1];
  }
  fx /= n; fy /= n; tx /= n; ty /= n;

  let spread = 0, dot = 0, cross = 0;
  for (let i = 0; i < n; i++) {
    const x = from[i]![0] - fx, y = from[i]![1] - fy;
    const u = to[i]![0] - tx, v = to[i]![1] - ty;
    spread += x * x + y * y;
    dot += x * u + y * v;
    cross += x * v - y * u;
  }

  const a = dot / spread;
  const b = cross / spread;
  return { a, b, tx: tx - (a * fx - b * fy), ty: ty - (b * fx + a * fy) };
}

function overlap(p: Face, q: Face): number {
  const x1 = Math.max(p.x, q.x);
  const y1 = Math.max(p.y, q.y);
  const x2 = Math.min(p.x + p.w, q.x + q.w);
  const y2 = Math.min(p.y + p.h, q.y + q.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (p.w * p.h + q.w * q.h - inter);
}

const largest = (faces: Face[]): Face => faces[0]!;
const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);
