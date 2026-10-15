"use client";

import { useActionState } from "react";
import { giveKybConsent, type KybResult } from "./actions";

/**
 * KYB consent.
 *
 * A business check reads public registers, which on its own would be
 * unremarkable. What makes consent necessary is the rest of it: it attaches
 * the signed-in person to the business and pulls their own Aadhaar, PAN and
 * selfie in behind it. The notice says that plainly rather than talking only
 * about the company.
 */
export function ConsentGate() {
  const [state, submit, pending] = useActionState<KybResult, FormData>(
    async () => giveKybConsent(),
    {},
  );

  return (
    <div className="card">
      <p className="eyebrow">Step 1 · DPDP consent</p>
      <h1>Before we check your business</h1>
      <p className="lead">
        We need your permission. You choose, and you can take it back at any
        time.
      </p>

      <div className="notice">
        <div className="notice-head">What you are agreeing to</div>
        <ul>
          <li>
            <strong>What we check:</strong> your GSTIN against the GST registry,
            your company against the MCA register, and — because you will be
            signing — your own Aadhaar, PAN and a selfie.
          </li>
          <li>
            <strong>Why:</strong> to sign the power purchase agreement and raise
            GST invoices against the right GSTIN.
          </li>
          <li>
            <strong>Who sees it:</strong> Signzy for GST, CIN and PAN;
            HyperVerge for Aadhaar and the selfie. Both hosted in India.
          </li>
          <li>
            <strong>How long:</strong> 7 years, because tax law and a 25-year
            agreement require it.
          </li>
          <li>
            <strong>Your Aadhaar number:</strong> never stored. We keep only the
            last 4 digits and a reference token.
          </li>
        </ul>
      </div>

      {state.error ? (
        <div className="alert" role="alert">
          <strong>{state.error.code}</strong> — {state.error.message}
        </div>
      ) : null}

      <p className="lead" style={{ fontSize: 13 }}>
        Notice v2.1 · You can withdraw this from Settings → Privacy, and we will
        delete what the law does not force us to keep.
      </p>

      <form action={submit}>
        <button className="btn" type="submit" disabled={pending}>
          {pending ? "Recording…" : "Give consent and continue"}
        </button>
      </form>
    </div>
  );
}
