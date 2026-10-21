"use client";

import { useState, useTransition } from "react";
import { SelfieCapture } from "./SelfieCapture";
import { submitPan } from "../actions";

/**
 * What is left of an individual verification once Aadhaar is done: a PAN and
 * a photograph.
 *
 * This was the back half of IndividualForm, which also asked for an Aadhaar
 * number and exchanged an OTP. That half is gone from the web — the Aadhaar
 * now happens at DigiLocker, on the government's own site, and no number
 * reaches this application at all.
 *
 * The two steps that remain are unchanged and still ours: the Income Tax
 * Department matches the PAN against the name UIDAI gave us, and the selfie
 * is stored for a reviewer to compare against the Aadhaar photograph, because
 * no gateway we can reach sells a face match.
 */
export function PanAndSelfieStep() {
  const [pan, setPan] = useState("");
  const [selfie, setSelfie] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const canSubmit = /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan) && selfie;

  function finish() {
    setError(null);
    start(async () => {
      const result = await submitPan(pan);
      if (result.error) setError(result.error.message);
      /** On success the action redirects, so there is nothing to do here. */
    });
  }

  return (
    <>
      <div className="okchip" role="status">
        <span aria-hidden="true">✓</span>
        <span>Aadhaar shared through DigiLocker</span>
        <span className="src">UIDAI</span>
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

      {/* ---- the photograph ---- */}
      <SelfieCapture onDone={() => setSelfie(true)} />

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
