"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { completeVendorFlow, type ActionResult } from "../../actions";

type Step = "digilocker" | "pan" | "selfie" | "submitting";

const COPY = {
  en: {
    digilockerTitle: "Verify your Aadhaar",
    digilockerLead:
      "Choose how to share it. Both routes return your name, date of birth, address and photo, signed by the government, so nothing can be changed on the way.",
    digilocker: "Through DigiLocker",
    digilockerSub:
      "Log in with an OTP on your Aadhaar-linked mobile. One consent gives both Aadhaar and PAN.",
    aadhaarApp: "Through the Aadhaar App",
    aadhaarAppSub:
      "Scan a QR code and share a verifiable credential. Use this if your mobile is not linked to Aadhaar.",
    consent: "Give consent",
    panTitle: "Enter your PAN",
    panLead:
      "We check it against the name and date of birth Aadhaar just gave us, so you do not have to type those again.",
    panLabel: "PAN number",
    selfieTitle: "Take a selfie",
    selfieLead:
      "Look straight at the camera. We compare this with the photo on your Aadhaar.",
    blink: "Hold still",
    capture: "Capture",
    retake: "Retake",
    finish: "Finish verification",
    submitting: "Sending to our server…",
    next: "Continue",
  },
  hi: {
    digilockerTitle: "Aadhaar verify karein",
    digilockerLead:
      "Chunein ki kaise share karna hai. Dono tareeke se naam, janm-tithi, pata aur photo milta hai — sarkar dwara signed, isliye beech mein kuch badla nahi ja sakta.",
    digilocker: "DigiLocker se",
    digilockerSub:
      "Aadhaar se linked mobile par OTP daal kar login karein. Ek hi consent mein Aadhaar aur PAN dono.",
    aadhaarApp: "Aadhaar App se",
    aadhaarAppSub:
      "QR code scan karke credential share karein. Agar mobile Aadhaar se linked nahi hai toh yeh chunein.",
    consent: "Consent dein",
    panTitle: "Apna PAN daalein",
    panLead:
      "Hum ise Aadhaar se mile naam aur janm-tithi se match karte hain. Woh dobara likhne ki zaroorat nahi.",
    panLabel: "PAN number",
    selfieTitle: "Ek selfie leejiye",
    selfieLead:
      "Camera ki taraf seedha dekhein. Hum ise aapke Aadhaar ki photo se match karte hain.",
    blink: "Sthir rahein",
    capture: "Capture karein",
    retake: "Dobara leejiye",
    finish: "Verification poora karein",
    submitting: "Hamare server par bheja ja raha hai…",
    next: "Aage badhein",
  },
} as const;

export function VendorFlow({
  sessionId,
  locale,
}: {
  sessionId: string;
  locale: "en" | "hi";
}) {
  const t = COPY[locale];
  const [step, setStep] = useState<Step>("digilocker");
  const [route, setRoute] = useState<"digilocker" | "aadhaar_app">("digilocker");
  const [pan, setPan] = useState("");
  const [shot, setShot] = useState<string | null>(null);

  const [state, submit, pending] = useActionState<ActionResult, FormData>(
    async (_prev, formData) => completeVendorFlow(formData),
    {},
  );

  const steps: { id: Step; label: string }[] = [
    { id: "digilocker", label: "Aadhaar" },
    { id: "pan", label: "PAN" },
    { id: "selfie", label: "Selfie" },
  ];
  const stepIndex = steps.findIndex((s) => s.id === step);

  return (
    <>
      <div className="card">
        <p className="eyebrow">Vendor flow · standing in for HyperVerge</p>

        <div className="rail" style={{ marginBottom: 22 }}>
          {steps.map((s, i) => (
            <span key={s.id} style={{ display: "flex", alignItems: "center" }}>
              {i > 0 ? <span className="rail-link" /> : null}
              <span
                className={
                  "rail-step " +
                  (i === stepIndex ? "now" : i < stepIndex ? "done" : "")
                }
              >
                <span className="dot">{i < stepIndex ? "✓" : i + 1}</span>
                <span>{s.label}</span>
              </span>
            </span>
          ))}
        </div>

        {step === "digilocker" ? (
          <>
            <h1 className={locale === "hi" ? "hi" : undefined}>
              {t.digilockerTitle}
            </h1>
            <p className={"lead " + (locale === "hi" ? "hi" : "")}>
              {t.digilockerLead}
            </p>

            <div className="choices">
              <button
                type="button"
                className="choice"
                aria-pressed={route === "digilocker"}
                onClick={() => setRoute("digilocker")}
              >
                <span className="radio" />
                <span>
                  <span className={"ct " + (locale === "hi" ? "hi" : "")}>
                    {t.digilocker}
                  </span>
                  <span className={"cd " + (locale === "hi" ? "hi" : "")}>
                    {t.digilockerSub}
                  </span>
                </span>
              </button>
              <button
                type="button"
                className="choice"
                aria-pressed={route === "aadhaar_app"}
                onClick={() => setRoute("aadhaar_app")}
              >
                <span className="radio" />
                <span>
                  <span className={"ct " + (locale === "hi" ? "hi" : "")}>
                    {t.aadhaarApp}
                  </span>
                  <span className={"cd " + (locale === "hi" ? "hi" : "")}>
                    {t.aadhaarAppSub}
                  </span>
                </span>
              </button>
            </div>

            <button className="btn" type="button" onClick={() => setStep("pan")}>
              {t.consent}
            </button>

            <p className="footnote">
              Which of these routes is legally available to us is still open with
              Legal: DigiLocker needs a requester registration from NeGD, the
              Aadhaar App route needs an OVSE registration with UIDAI, and OTP
              eKYC needs MeitY approval. All three sit behind the same
              KycProvider interface, so the screens do not change when it is
              settled.
            </p>
          </>
        ) : null}

        {step === "pan" ? (
          <>
            <h1 className={locale === "hi" ? "hi" : undefined}>{t.panTitle}</h1>
            <p className={"lead " + (locale === "hi" ? "hi" : "")}>{t.panLead}</p>

            <div className="field">
              <label htmlFor="pan">{t.panLabel}</label>
              <input
                id="pan"
                type="text"
                value={pan}
                autoComplete="off"
                maxLength={12}
                placeholder="ABCPS4412K"
                onChange={(event) =>
                  setPan(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))
                }
              />
              <p className="hint">
                ^[A-Z]&#123;5&#125;[0-9]&#123;4&#125;[A-Z]$
                {pan.length >= 4 ? ` · 4th char “${pan[3]}”` : ""}
              </p>
            </div>

            <p className="footnote">
              Whatever is typed here is discarded. The PAN that reaches our server
              comes from the vendor&rsquo;s result, because the real check runs
              against the Income Tax Department&rsquo;s authorised channel and
              only answers yes or no to a name we send it — which is why Aadhaar
              has to come first.
            </p>

            <div className="btnrow">
              <button
                className="btn ghost"
                type="button"
                onClick={() => setStep("digilocker")}
              >
                ← Back
              </button>
              <button className="btn" type="button" onClick={() => setStep("selfie")}>
                {t.next}
              </button>
            </div>
          </>
        ) : null}

        {step === "selfie" ? (
          <>
            <h1 className={locale === "hi" ? "hi" : undefined}>{t.selfieTitle}</h1>
            <p className={"lead " + (locale === "hi" ? "hi" : "")}>{t.selfieLead}</p>

            <SelfieCapture
              hint={t.blink}
              captureLabel={t.capture}
              retakeLabel={t.retake}
              shot={shot}
              onShot={setShot}
            />

            {state.error ? (
              <div className="alert" role="alert" style={{ marginTop: 18 }}>
                <strong>{state.error.code}</strong> — {state.error.message}
              </div>
            ) : null}

            <form action={submit}>
              <input type="hidden" name="sessionId" value={sessionId} />
              <div className="btnrow">
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => setStep("pan")}
                >
                  ← Back
                </button>
                <button className="btn" type="submit" disabled={pending}>
                  {pending ? t.submitting : t.finish}
                </button>
              </div>
            </form>

            <p className="footnote">
              The selfie never leaves this page. Pressing finish tells our server
              that the user completed the vendor&rsquo;s flow; the server then
              fetches the result from the vendor and decides. Nothing the browser
              reports is treated as an outcome — in production the browser is not
              the thing reporting it at all.
            </p>
          </>
        ) : null}
      </div>

      <p className="footnote">
        Session <span className="mono">{sessionId}</span>
      </p>
    </>
  );
}

/**
 * A real camera, through getUserMedia.
 *
 * Real on purpose: permission prompts, a device with no camera, and a user who
 * says no are all situations support will see, and a mocked preview would hide
 * every one of them. The capture is drawn to a canvas and kept in this
 * component — it is never uploaded, because the vendor's SDK is what would
 * handle the image in production, and liveness cannot be judged from a still
 * frame anyway.
 */
function SelfieCapture({
  hint,
  captureLabel,
  retakeLabel,
  shot,
  onShot,
}: {
  hint: string;
  captureLabel: string;
  retakeLabel: string;
  shot: string | null;
  onShot: (dataUrl: string | null) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (shot) return;

    let cancelled = false;

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: 640, height: 853 },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
      } catch (cause) {
        const name = cause instanceof Error ? cause.name : "";
        setError(
          name === "NotAllowedError"
            ? "Camera access was declined. Allow it in your browser, or carry on without a selfie — the fake vendor does not need the image."
            : name === "NotFoundError"
              ? "No camera found on this device. Carry on without one; the fake vendor does not need the image."
              : "The camera could not be started. Carry on without one.",
        );
      }
    }

    void start();

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, [shot]);

  function capture() {
    const video = videoRef.current;
    if (!video) return;

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 853;
    const context = canvas.getContext("2d");
    if (!context) return;

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    onShot(canvas.toDataURL("image/jpeg", 0.8));

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  if (error) {
    return (
      <div className="alert" role="status">
        {error}
      </div>
    );
  }

  return (
    <>
      <div className="cam">
        {shot ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={shot} alt="The selfie just captured" />
        ) : (
          <>
            <video ref={videoRef} playsInline muted />
            <div className="oval" />
            <div className="camhint">{hint}</div>
          </>
        )}
      </div>

      <div className="btnrow" style={{ marginTop: 14 }}>
        {shot ? (
          <button className="btn ghost" type="button" onClick={() => onShot(null)}>
            {retakeLabel}
          </button>
        ) : (
          <button className="btn ghost" type="button" onClick={capture}>
            {captureLabel}
          </button>
        )}
      </div>

      <div style={{ marginTop: 10 }}>
        <div className="tickline">
          <i>✓</i> A real, live person — not a photo, a screen or a mask
        </div>
        <div className="tickline">
          <i>✓</i> Enough light, face fully inside the frame
        </div>
        <div className="tickline pend">
          <i>…</i> Face match against the Aadhaar photo — decided on our server
        </div>
      </div>
    </>
  );
}
