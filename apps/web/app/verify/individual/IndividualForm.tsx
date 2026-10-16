"use client";

import { useState, useTransition } from "react";
import { SelfieCapture } from "./SelfieCapture";
import { sendAadhaarOtp, verifyIndividual } from "../actions";

/**
 * Individual verification: Aadhaar, PAN, liveness.
 *
 * The Aadhaar number is never sent to our own database. It goes to the
 * verification gateway, which answers with a masked last four and a reference
 * token, and those are the only two things that come back — the schema has
 * nowhere to put the full number.
 *
 * The OTP is a separate round trip on purpose. "Enter your Aadhaar and we will
 * check it" is not how Aadhaar eKYC works: UIDAI sends a one-time password to
 * the mobile registered against that number, and consent is the person typing
 * it back. A flow that skipped it would be verifying a number somebody typed,
 * not a person who holds it.
 */

type Stage = "entering" | "otp-sent" | "verified-aadhaar";

function group(value: string): string {
  return value.replace(/\D/g, "").slice(0, 12).replace(/(\d{4})(?=\d)/g, "$1 ");
}

export function IndividualForm() {
  const [aadhaar, setAadhaar] = useState("");
  const [otp, setOtp] = useState("");
  const [pan, setPan] = useState("");
  const [stage, setStage] = useState<Stage>("entering");
  const [selfie, setSelfie] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const digits = aadhaar.replace(/\D/g, "");
  const canSendOtp = digits.length === 12 && stage === "entering";
  const canSubmit =
    stage === "verified-aadhaar" && /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan) && selfie;

  function requestOtp() {
    setError(null);
    start(async () => {
      const result = await sendAadhaarOtp(digits);
      if (result.error) {
        setError(result.error.message);
        return;
      }
      setStage("otp-sent");
      setNote(result.sentTo ?? "An OTP has been sent to the registered mobile.");
    });
  }

  function submitOtp() {
    setError(null);
    start(async () => {
      const result = await verifyIndividual({ otp, stage: "otp" });
      if (result.error) {
        setError(result.error.message);
        return;
      }
      setStage("verified-aadhaar");
      setNote(result.message ?? null);
    });
  }

  function finish() {
    setError(null);
    start(async () => {
      const result = await verifyIndividual({ pan, stage: "finish" });
      if (result.error) setError(result.error.message);
      /** On success the action redirects, so there is nothing to do here. */
    });
  }

  return (
    <>
      {/* ---- Aadhaar ---- */}
      <div className="frow">
        <div className="frow-top">
          <label htmlFor="aadhaar">Aadhaar number</label>
          <span className="tag">Fast track</span>
        </div>

        <div className="frow-in">
          <input
            id="aadhaar"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            placeholder="0000 0000 0000"
            value={aadhaar}
            disabled={stage !== "entering"}
            onChange={(event) => setAadhaar(group(event.target.value))}
          />
          <button
            type="button"
            className="inlinebtn"
            disabled={!canSendOtp || pending}
            onClick={requestOtp}
          >
            {pending && stage === "entering" ? "Sending…" : "Get OTP →"}
          </button>
        </div>

        <p className="hint">
          The OTP goes to the mobile registered with UIDAI. We never store the
          full number — only the last four digits and a reference token.
        </p>

        {stage === "otp-sent" && (
          <>
            <div className="frow-in" style={{ marginTop: 10 }}>
              <input
                id="otp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6-digit OTP"
                aria-label="Aadhaar OTP"
                value={otp}
                onChange={(event) =>
                  setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))
                }
              />
              <button
                type="button"
                className="inlinebtn"
                disabled={otp.length !== 6 || pending}
                onClick={submitOtp}
              >
                {pending ? "Checking…" : "Verify →"}
              </button>
            </div>
          </>
        )}

        {stage === "verified-aadhaar" && (
          <div className="okchip">
            <span aria-hidden="true">✓</span>
            <span>Aadhaar verified · ⋯{digits.slice(-4)}</span>
            <span className="src">UIDAI</span>
          </div>
        )}
      </div>

      {/* ---- PAN ---- */}
      <div className="frow">
        <div className="frow-top">
          <label htmlFor="pan">PAN number</label>
          <span className="tag">10 characters</span>
        </div>

        <div className="frow-in">
          <input
            id="pan"
            type="text"
            autoComplete="off"
            placeholder="ABCDE1234F"
            style={{ textTransform: "uppercase" }}
            value={pan}
            onChange={(event) =>
              setPan(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10))
            }
          />
        </div>

        <p className="hint">
          It has to match the name on your electricity connection, because the
          rent is paid after TDS against this PAN.
        </p>
      </div>

      {/*
        ---- the photograph ----

        This was a button that set a boolean, under the words "a two-second
        check that you are a live person" and "matched against your Aadhaar
        photo once submitted". Nothing was captured, nothing was uploaded and
        nothing was ever matched — the gateway sells no liveness check and no
        face match. The real thing collects a photograph, scans it and stores
        it for a reviewer, and says so.
      */}
      <SelfieCapture onDone={() => setSelfie(true)} />

      {note && !error && (
        <div className="okchip" role="status">
          <span aria-hidden="true">i</span>
          <span>{note}</span>
        </div>
      )}

      {error && (
        <div className="alert" role="alert" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}

      <button className="cta" type="button" disabled={!canSubmit || pending} onClick={finish}>
        {pending ? "Verifying…" : "Verify →"}
      </button>

      <p className="secure">
        <span aria-hidden="true">🔒</span> Sent over TLS, stored encrypted, and
        never shown back in full
      </p>
    </>
  );
}
