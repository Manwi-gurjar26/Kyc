"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { confirmSelfie, startSelfieUpload } from "../actions";

/**
 * Takes a selfie and uploads it.
 *
 * What this is NOT is a liveness check. The verification gateway this system
 * runs on sells no liveness test and no face match, so nothing here scores
 * anything: the photograph is collected, virus-scanned and stored, and a
 * reviewer compares it against the Aadhaar photograph by eye. The copy says
 * exactly that, because the version it replaces promised "a two-second check
 * that you are a live person" over a button that only set a boolean.
 *
 * The bytes go from the browser to the signed URL directly. They do not pass
 * through the server actions — those mint the URL and record the arrival,
 * which keeps one more copy of somebody's face out of our application logs.
 */

type Stage = "idle" | "starting" | "live" | "captured" | "uploading" | "done";

/** The signed URL is minted for this ceiling, and the API enforces it. */
const MAX_BYTES = 2_000_000;

export function SelfieCapture({ onDone }: { onDone: () => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [cameraRefused, setCameraRefused] = useState(false);

  /**
   * Stops the camera.
   *
   * Called on capture and on unmount, because a preview left running keeps
   * the indicator light on after the step is finished — which reasonably
   * reads as "this page is still watching me".
   */
  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  async function openCamera() {
    setError(null);
    setStage("starting");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 960 }, height: { ideal: 1280 } },
        audio: false,
      });

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setStage("live");
    } catch {
      /**
       * A refusal is not an error to argue with. Plenty of people have no
       * camera, and plenty more will not grant one to a page asking for their
       * face — so the file route appears instead of a retry loop.
       */
      setCameraRefused(true);
      setStage("idle");
    }
  }

  /** Draws the current frame and hands back the JPEG. */
  async function grabFrame(): Promise<Blob | null> {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return null;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const context = canvas.getContext("2d");
    if (!context) return null;

    /**
     * Un-mirrored on the way out.
     *
     * The preview is flipped because an unflipped one is disorienting to sit
     * in front of, but the stored image must be the real orientation — a
     * reviewer comparing a mirrored selfie against an Aadhaar photograph is
     * being asked to do the comparison through a mirror.
     */
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    return new Promise((resolve) =>
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.9),
    );
  }

  async function digestOf(blob: Blob): Promise<string> {
    const bytes = await blob.arrayBuffer();
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(hash)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /** Mints a URL, sends the bytes, records the arrival. */
  async function upload(blob: Blob) {
    setStage("uploading");
    setError(null);

    if (blob.size > MAX_BYTES) {
      setError("That image is too large. Please try again.");
      setStage("idle");
      return;
    }

    const target = await startSelfieUpload({ sizeBytes: blob.size });
    if (target.error || !target.url || !target.key) {
      setError(target.error?.message ?? "We could not start the upload.");
      setStage("idle");
      return;
    }

    const sent = await fetch(target.url, {
      method: "PUT",
      headers: { "content-type": "image/jpeg" },
      body: blob,
    });

    if (!sent.ok) {
      setError("The photo did not upload. Please try again.");
      setStage("idle");
      return;
    }

    const confirmed = await confirmSelfie({
      storageKey: target.key,
      sha256: await digestOf(blob),
    });

    if (confirmed.error) {
      setError(confirmed.error.message);
      setStage("idle");
      return;
    }

    /**
     * A file that failed its scan is not a selfie we hold.
     *
     * The decision step only counts a CLEAN document, so saying "done" on an
     * infected or unscannable upload would leave somebody believing the step
     * was finished while the reviewer sees nothing.
     */
    if (confirmed.scanStatus && confirmed.scanStatus !== "CLEAN") {
      setError(
        "That photo could not be accepted after scanning. Please take another one.",
      );
      setStage("idle");
      return;
    }

    setStage("done");
    onDone();
  }

  async function capture() {
    const blob = await grabFrame();
    stopCamera();

    if (!blob) {
      setError("We could not take the photo. Please try again.");
      setStage("idle");
      return;
    }

    setStage("captured");
    await upload(blob);
  }

  async function pickFile(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Please choose an image file.");
      return;
    }
    await upload(file);
  }

  const busy = stage === "uploading" || stage === "starting";

  return (
    <div className="frow">
      <div className="frow-top">
        <label htmlFor="selfie">Your photo</label>
        <span className="tag">Checked by a person</span>
      </div>

      {stage === "live" && (
        <>
          <div className="cam">
            {/* Muted and inline, or iOS refuses to play it at all. */}
            <video ref={videoRef} playsInline muted />
            <div className="oval" aria-hidden="true" />
            <div className="camhint">Look straight ahead, in even light</div>
          </div>

          <button
            type="button"
            className="btn"
            onClick={capture}
            style={{ marginTop: 10 }}
          >
            Take the photo
          </button>
        </>
      )}

      {stage !== "live" && (
        <div className="selfie">
          <div>
            <div className="st">
              {stage === "done"
                ? "Photo received"
                : stage === "uploading"
                  ? "Sending your photo…"
                  : "Take a photo of yourself"}
            </div>
            <div className="ss">
              {stage === "done"
                ? "A reviewer will compare it with your Aadhaar photo"
                : "We do not score it automatically — a person compares it with your Aadhaar photo"}
            </div>
          </div>

          <button
            id="selfie"
            type="button"
            className="cam"
            aria-label={stage === "done" ? "Photo received" : "Open the camera"}
            onClick={openCamera}
            disabled={busy || stage === "done"}
          >
            {stage === "done" ? "✓" : "◎"}
          </button>
        </div>
      )}

      {/*
        The fallback, shown once the camera has been refused or is absent.
        Hidden until then: offering "upload a file" alongside "use your camera"
        from the start invites the easier of the two, and a photograph chosen
        from a folder is weaker evidence that the person was ever present.
      */}
      {cameraRefused && stage !== "done" && (
        <>
          <p className="hint">
            We could not open your camera. You can choose a recent photo of
            yourself instead.
          </p>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={(event) => void pickFile(event.target.files?.[0])}
          />
          <button
            type="button"
            className="btn"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
          >
            Choose a photo
          </button>
        </>
      )}

      {/* Never rendered; it is only the surface the frame is drawn onto. */}
      <canvas ref={canvasRef} style={{ display: "none" }} />

      {error && (
        <div className="alert" role="alert" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}
    </div>
  );
}
